import * as sdk from '@sidequest/sdk'
import {
  type Address,
  type Hex,
  decodeEventLog,
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  toHex,
  toEventSelector,
  pad,
} from 'viem'
import { Schema } from 'effect'
import type { WalletStep } from './components/txOperation.ts'
import { paymentMode, type PaymentMode } from './aa-mode.ts'
import type { AaJournal } from './aa-journal.ts'

export interface BrowserAaRpc {
  readonly node: sdk.JsonRpc
  readonly bundler: sdk.JsonRpc
  readonly paymaster: sdk.JsonRpc
}

export function browserAaRpc(rpcUrl: string, apiOrigin = '', fetcher: typeof fetch = fetch): BrowserAaRpc {
  const proxy = sdk.jsonRpc(`${apiOrigin.replace(/\/$/, '')}/aa/rpc`, 'Gas service', fetcher)
  return { node: sdk.jsonRpc(rpcUrl, 'Monad', fetcher), bundler: proxy, paymaster: proxy }
}

export async function browserPaymentMode(
  rpc: BrowserAaRpc,
  deployment: sdk.Deployment,
  address: Address,
  txs: readonly WalletStep[],
  options: { canAuthorize: boolean; sponsor?: boolean },
): Promise<PaymentMode> {
  const [code, balance] = await Promise.all([
    rpc.node('eth_getCode', [address, 'latest']),
    rpc.node('eth_getBalance', [address, 'latest']),
  ])
  const delegated =
    Schema.decodeUnknownSync(Schema.String)(code).toLowerCase() ===
    `0xef0100${deployment.delegation.delegator.slice(2).toLowerCase()}`
  const nativeBalance = hexQuantity(balance)
  const aa = deployment.aa
  const gasTokenBalance = aa === null ? 0n : await tokenBalance(rpc.node, aa.gasToken, address)
  return paymentMode({
    aa,
    gasTokenBalance,
    carriedGasToken: aa === null ? 0n : carriedGasToken(txs, aa.gasToken, address),
    nativeBalance,
    nativeValue: txs.reduce((total, tx) => total + BigInt(tx.value), 0n),
    delegated,
    canBatch: delegated,
    canSignAuthorization: options.canAuthorize,
    sponsor: options.sponsor === true,
  })
}

/** Count only explicit transfers of the configured token into this wallet, net of explicit transfers out. */
export function carriedGasToken(txs: readonly WalletStep[], token: Address, sender: Address): bigint {
  let amount = 0n
  for (const tx of txs) {
    if (tx.to.toLowerCase() !== token.toLowerCase()) continue
    amount += tokenTransferDelta(tx.data, sender)
  }
  return amount > 0n ? amount : 0n
}

function tokenTransferDelta(data: Hex, sender: Address): bigint {
  try {
    const call = decodeFunctionData({ abi: erc20Abi, data })
    if (call.functionName === 'transfer')
      return call.args[0].toLowerCase() === sender.toLowerCase() ? 0n : -call.args[1]
    if (call.functionName === 'transferFrom') {
      const outgoing = call.args[0].toLowerCase() === sender.toLowerCase() ? -call.args[2] : 0n
      const incoming = call.args[1].toLowerCase() === sender.toLowerCase() ? call.args[2] : 0n
      return outgoing + incoming
    }
  } catch {
    // Unreadable calls cannot supply gas funding evidence.
  }
  return 0n
}

const hexQuantity = (value: unknown): bigint => BigInt(Schema.decodeUnknownSync(Schema.String)(value))
async function tokenBalance(node: sdk.JsonRpc, token: Address, address: Address): Promise<bigint> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [address] })
  const answer = Schema.decodeUnknownSync(Schema.String)(await node('eth_call', [{ to: token, data }, 'latest']))
  // SAFETY: viem validates the returned hex and ABI-encoded uint256 during decoding.
  return decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: answer as Hex })
}

export function userOpCalls(txs: readonly WalletStep[], chainId: number): sdk.Call[] {
  return txs.map((tx) => {
    if (tx.chainId !== chainId || tx.value !== '0')
      throw new Error('The user operation must use this network and no MON value.')
    return { to: tx.to, data: tx.data, value: 0n }
  })
}

const eventAbi = parseAbi([
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
])
const Log = Schema.Struct({
  data: Schema.String,
  topics: Schema.Array(Schema.String),
  transactionHash: Schema.String,
})

async function laneEvent(rpc: BrowserAaRpc, built: sdk.BuiltUserOp, block: string) {
  const logs = Schema.decodeUnknownSync(Schema.Array(Log))(
    await rpc.node('eth_getLogs', [
      {
        address: built.entryPoint,
        fromBlock: block,
        toBlock: 'latest',
        topics: [toEventSelector(eventAbi[0]), null, pad(built.op.sender, { size: 32 })],
      },
    ]),
  )
  for (const log of logs) {
    try {
      // SAFETY: decodeEventLog validates each topic and the ABI-encoded event before its args are used.
      const event = decodeEventLog({ abi: eventAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] })
      if (
        event.args.userOpHash.toLowerCase() === built.userOpHash.toLowerCase() &&
        event.args.sender.toLowerCase() === built.op.sender.toLowerCase() &&
        event.args.nonce === built.op.nonce
      ) {
        // SAFETY: transactionHash comes from the node's event; a malformed hash is rejected before recording a receipt.
        const txHash = log.transactionHash as Hex
        if (!/^0x[0-9a-f]{64}$/i.test(txHash)) throw new Error('The operation event has no transaction hash.')
        return { txHash, status: event.args.success ? ('success' as const) : ('reverted' as const) }
      }
    } catch {
      // Other EntryPoint events are not receipt evidence for this action.
    }
  }
  return null
}

export type AaReconciliation =
  | { readonly at: 'receipt'; readonly receipt: NonNullable<AaJournal['receipt']> }
  | { readonly at: 'pending' | 'dropped' | 'unknown' }

/** Receipts, then lane/event proof, then the 120-second pending window: never select a new nonce after an ambiguous send. */
export async function reconcileUserOp(
  rpc: BrowserAaRpc,
  built: sdk.BuiltUserOp,
  saved: AaJournal,
  now = Date.now(),
): Promise<AaReconciliation> {
  let receipt: sdk.UserOpReceipt | null = null
  let receiptUnavailable = false
  try {
    receipt = await sdk.userOpReceipt(rpc.bundler, built.userOpHash)
  } catch {
    receiptUnavailable = true
  }
  if (receipt !== null) return { at: 'receipt', receipt }
  const sequence = await sdk.laneSequence(rpc.node, built.entryPoint, built.op.sender, sdk.nonceKey(saved.actionId))
  const event = await laneEvent(rpc, built, saved.block ?? toHex(0))
  if (event !== null) return { at: 'receipt', receipt: event }
  if (sequence !== 0n || receiptUnavailable) return { at: 'unknown' }
  if (saved.submittedAt === undefined) return { at: 'dropped' }
  if (now - saved.submittedAt < 120_000) return { at: 'pending' }
  const pending = await rpc.bundler('eth_getUserOperationByHash', [built.userOpHash])
  return { at: pending === null ? 'dropped' : 'pending' }
}
