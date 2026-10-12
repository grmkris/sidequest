/**
 * One transaction instead of several (EIP-7702): the wallet points its own code at the MetaMask
 * `EIP7702StatelessDeleGatorImpl` (the deployment's `delegation.delegator`) and calls ERC-7579 `execute` on itself
 * in batch mode, so an approve, an approve and a publish land together, all or nothing, with one signature.
 * `msg.sender` of every inner call is still the wallet, so nothing on the protocol side changes, and the DeleGator's
 * ERC-1271 accepts the wallet's own raw EIP-712 signatures. The same code is what lets a creator sign execution
 * budgets as delegations (ADR-0009), so every account here points at one delegate.
 *
 * The first batch carries a signed authorization (a type-4 transaction); later ones are ordinary calls to self while
 * the code still points at the delegate. Monad: a delegated account's transaction may not lower its balance below
 * 10 MON by more than the gas fee. Board transactions carry no value, so only gas is spent.
 */
import {
  type Address,
  type Hex,
  type PublicClient,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
} from 'viem'
import type { Wallet } from './actions.ts'
import type { TxRequest } from './board-client.ts'

/** ERC-7579 `execute` as the DeleGator exposes it to its own account. */
export const delegatorAbi = parseAbi(['function execute(bytes32 mode, bytes executionCalldata)'])

/** ERC-7579 mode: batch of calls, revert on the first failure. */
export const BATCH_DEFAULT_MODE: Hex = '0x0100000000000000000000000000000000000000000000000000000000000000'

const executionsAbi = [
  {
    type: 'tuple[]',
    components: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'callData', type: 'bytes' },
    ],
  },
] as const

/** A signed EIP-7702 authorization in viem's shape. */
export interface SignedAuthorization {
  readonly address: Address
  readonly chainId: number
  readonly nonce: number
  readonly r: Hex
  readonly s: Hex
  readonly yParity: number
}

/**
 * Signs an authorization for `delegate` that the wallet itself will submit (so its nonce is the transaction's nonce
 * plus one). Local keys sign with viem; wallets whose key lives elsewhere (a Privy server wallet) register their own
 * signer with `setAuthorizationSigner`.
 */
export type AuthorizationSigner = (delegate: Address, chainId: number, nonce: number) => Promise<SignedAuthorization>

const signers = new WeakMap<object, AuthorizationSigner>()

export function setAuthorizationSigner(wallet: Wallet, signer: AuthorizationSigner) {
  signers.set(wallet, signer)
}

interface Reads {
  estimateGas?: PublicClient['estimateGas']
  getCode(a: { address: Address }): Promise<Hex | undefined>
  getTransactionCount(a: { address: Address; blockTag?: 'pending' }): Promise<number>
  waitForTransactionReceipt(a: { hash: Hex }): Promise<{ status: string }>
}

/** The address an account's code delegates to (`0xef0100 ‖ address`), or null for a plain EOA or a contract. */
export async function delegationOf(reads: Pick<Reads, 'getCode'>, account: Address): Promise<Address | null> {
  const code = (await reads.getCode({ address: account })) ?? '0x'
  if (code.length !== 48 || !code.toLowerCase().startsWith('0xef0100')) return null
  return `0x${code.slice(8)}` as Address
}

/** The ERC-7579 batch `execute` calldata for the board's transactions, in order. */
export function batchCalldata(txs: readonly TxRequest[]): Hex {
  return executeCalldata(txs.map((t) => ({ to: t.to, value: BigInt(t.value), data: t.data })))
}

/** One call of a DeleGator batch. */
export interface Call {
  readonly to: Address
  readonly value: bigint
  readonly data: Hex
}

/** The DeleGator's `execute(batch mode, calls)`: every call lands, or none (a transaction to self, or a user op's call data). */
export function executeCalldata(calls: readonly Call[]): Hex {
  const executions = encodeAbiParameters(executionsAbi, [
    calls.map((c) => ({ target: c.to, value: c.value, callData: c.data })),
  ])
  return encodeFunctionData({ abi: delegatorAbi, functionName: 'execute', args: [BATCH_DEFAULT_MODE, executions] })
}

/** The calls `executeCalldata` encoded; null for anything else, which a caller refuses. */
export function decodeExecuteCalldata(data: Hex): Call[] | null {
  try {
    const { args } = decodeFunctionData({ abi: delegatorAbi, data })
    if (args[0].toLowerCase() !== BATCH_DEFAULT_MODE) return null
    const [calls] = decodeAbiParameters(executionsAbi, args[1])
    return calls.map((c) => ({ to: c.target, value: c.value, data: c.callData }))
  } catch {
    // expected: call data that is not a DeleGator batch reads as none.
    return null
  }
}

/**
 * Sends the board's transactions as one EIP-7702 batch from `wallet` and waits for it; returns its single hash.
 * One transaction is sent as it is. Throws if the batch reverts (then none of its calls happened).
 */
export async function sendBatch(
  wallet: Wallet,
  reads: Reads,
  txs: readonly TxRequest[],
  delegate: Address,
): Promise<Hex> {
  if (txs.length === 0) throw new Error('nothing to send')
  const me = wallet.account.address
  let hash: Hex
  if (txs.length === 1) {
    const [t] = txs as [TxRequest]
    hash = await wallet.sendTransaction({
      to: t.to,
      data: t.data,
      value: BigInt(t.value),
      ...(t.gas === undefined ? {} : { gas: BigInt(t.gas) }),
    })
  } else {
    const data = batchCalldata(txs)
    // Floors cover each inner call and its forwarding reserve. Estimate the whole batch too: later calls may
    // depend on earlier ones, and a call without a floor can cost more than a default allowance.
    const withGas = async (request: Parameters<Wallet['sendTransaction']>[0]) => {
      if (!txs.some((t) => t.gas !== undefined)) return request
      const floor = txs.reduce((sum, t) => sum + BigInt(t.gas ?? '0'), 200_000n)
      if (reads.estimateGas === undefined && txs.some((t) => t.gas === undefined))
        throw new Error('Batch gas estimation is required for calls without a gas limit')
      const estimate =
        reads.estimateGas === undefined ? 0n : await reads.estimateGas({ ...request, account: wallet.account } as never)
      return { ...request, gas: estimate > floor ? estimate : floor }
    }
    const current = await delegationOf(reads, me)
    if (current !== null && current.toLowerCase() === delegate.toLowerCase()) {
      hash = await wallet.sendTransaction(await withGas({ to: me, data }))
    } else {
      const chainId = wallet.chain.id
      const custom = signers.get(wallet)
      const authorization =
        custom !== undefined
          ? await custom(delegate, chainId, (await reads.getTransactionCount({ address: me, blockTag: 'pending' })) + 1)
          : await wallet.signAuthorization({ account: wallet.account, contractAddress: delegate, executor: 'self' })
      hash = await wallet.sendTransaction(await withGas({ to: me, data, authorizationList: [authorization as never] }))
    }
  }
  const receipt = await reads.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${txs.map((t) => t.description).join(' + ')}: ${hash} reverted`)
  return hash
}
