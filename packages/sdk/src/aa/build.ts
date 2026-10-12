/**
 * Builds, sends and reads back one user operation (ADR-0023). Building reads the operation's nonce lane, prices the
 * gas, estimates it, bounds what the paymaster may take against the network's ceiling and fetches the paymaster's
 * data; the result is everything but the signature. Sending checks that the signature recovers to the sender over the
 * DeleGator's digest before the bundler sees it. The same code serves the Worker (hosted agents) and the browser.
 */
import {
  type Address,
  type Hex,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  isAddressEqual,
  isHex,
  parseAbi,
  recoverAddress,
  toHex,
} from 'viem'
import { type Call, type SignedAuthorization, executeCalldata } from '../batch.ts'
import type { AccountAbstraction } from '../deployment.ts'
import { type TokenQuote, maxTokenCost } from './fees.ts'
import { AaError, type Json, type JsonRpc, field, hexField, quantity } from './rpc.ts'
import { type UserOperation, approveCall, delegatorDigest, laneNonce, toBundlerJson, userOpHash } from './userop.ts'

/**
 * A well-formed ECDSA signature for estimation: it recovers to some other address, so the DeleGator reports a failed
 * validation instead of reverting on a malformed one.
 */
const DUMMY_SIGNATURE: Hex =
  '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c'

const entryPointAbi = parseAbi(['function getNonce(address sender, uint192 key) view returns (uint256)'])
const SEQUENCE = (1n << 64n) - 1n

export interface BuildInput {
  readonly aa: AccountAbstraction
  readonly chainId: number
  /** The chain's node: the nonce lane and the paymaster allowance are read there. */
  readonly node: JsonRpc
  readonly bundler: JsonRpc
  /** The ERC-7677 paymaster service (Pimlico on mainnet, our Worker on testnet); it also answers token quotes. */
  readonly paymaster: JsonRpc
  readonly sender: Address
  /**
   * The batch, before any paymaster approval, for the most the gas may cost in the gas token: first the ceiling (for
   * the estimate), then the bound itself, so a gas pull can take just enough. Fixed calls ignore it.
   */
  readonly calls: (maxCost: bigint) => readonly Call[] | Promise<readonly Call[]>
  /** The operation's lane (`nonceKey(operationId)`): every attempt of one operation shares its nonce. */
  readonly nonceKey: bigint
  /** The sender's 7702 authorization, when its code does not point at the DeleGator yet. */
  readonly authorization?: SignedAuthorization | undefined
  /** Testnet only: our paymaster sponsors a faucet claim instead of charging the gas token. */
  readonly sponsor?: 'faucet' | undefined
}

/** An operation ready to sign, the most its gas may cost and the hash it will go by. */
export interface BuiltUserOp {
  readonly op: UserOperation
  readonly authorization?: SignedAuthorization | undefined
  readonly entryPoint: Address
  readonly chainId: number
  /** Gas token base units; 0 when sponsored. */
  readonly maxCost: bigint
  readonly userOpHash: Hex
}

async function readCall(node: JsonRpc, to: Address, data: Hex): Promise<Hex> {
  return hexField(await node('eth_call', [{ to, data }, 'latest']), 'call result')
}

/** The sequence of `sender`'s lane: 0 until one of its operations lands. */
export async function laneSequence(node: JsonRpc, entryPoint: Address, sender: Address, key: bigint): Promise<bigint> {
  const data = encodeFunctionData({ abi: entryPointAbi, functionName: 'getNonce', args: [sender, key] })
  const result = await readCall(node, entryPoint, data)
  return decodeFunctionResult({ abi: entryPointAbi, functionName: 'getNonce', data: result }) & SEQUENCE
}

async function allowanceOf(node: JsonRpc, token: Address, owner: Address, spender: Address): Promise<bigint> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [owner, spender] })
  return decodeFunctionResult({ abi: erc20Abi, functionName: 'allowance', data: await readCall(node, token, data) })
}

const named = (value: Json | undefined, paymaster: Address): boolean => {
  const address = hexField(value, 'paymaster')
  return address.length === 42 && isAddressEqual(address, paymaster)
}

/** The paymaster's quote for the gas token, refused unless it names the configured paymaster. */
async function quote(input: BuildInput, paymaster: Address): Promise<TokenQuote> {
  const answer = await input.paymaster('pimlico_getTokenQuotes', [
    { tokens: [input.aa.gasToken] },
    input.aa.entryPoint,
    toHex(input.chainId),
  ])
  const quotes = field(answer, 'quotes')
  const first = Array.isArray(quotes) ? quotes[0] : undefined
  if (!named(field(first, 'paymaster'), paymaster))
    throw new AaError('mismatch', 'the paymaster service quoted another paymaster than the configured one')
  return {
    paymaster,
    exchangeRate: quantity(field(first, 'exchangeRate'), 'exchange rate'),
    postOpGas: quantity(field(first, 'postOpGas'), 'post-op gas'),
  }
}

/** A gas limit the answer may carry; undefined when it does not. */
const limit = (answer: Json | undefined, name: string): bigint | undefined => {
  const value = field(answer, name)
  return value === undefined ? undefined : quantity(value, name)
}

/** The paymaster's gas limits from an answer, keeping the operation's own where the answer has none. */
function paymasterLimits(op: UserOperation, answer: Json | undefined): UserOperation {
  const verification = limit(answer, 'paymasterVerificationGasLimit') ?? op.paymasterVerificationGasLimit
  const postOp = limit(answer, 'paymasterPostOpGasLimit') ?? op.paymasterPostOpGasLimit
  return {
    ...op,
    ...(verification === undefined ? {} : { paymasterVerificationGasLimit: verification }),
    ...(postOp === undefined ? {} : { paymasterPostOpGasLimit: postOp }),
  }
}

/** Merges a paymaster answer (stub or final) into the operation, refusing any other paymaster. */
function withPaymaster(op: UserOperation, answer: Json, paymaster: Address): UserOperation {
  if (!named(field(answer, 'paymaster'), paymaster))
    throw new AaError('mismatch', 'the paymaster service answered for another paymaster')
  return paymasterLimits(
    { ...op, paymaster, paymasterData: hexField(field(answer, 'paymasterData'), 'paymaster data') },
    answer,
  )
}

/** The bundler's estimate into the operation. Monad bills the whole limit: the call gets 10% for state moving, no more. */
function withEstimate(op: UserOperation, gas: Json): UserOperation {
  return paymasterLimits(
    {
      ...op,
      callGasLimit: (quantity(field(gas, 'callGasLimit'), 'call gas') * 11n) / 10n,
      verificationGasLimit: quantity(field(gas, 'verificationGasLimit'), 'verification gas'),
      preVerificationGas: quantity(field(gas, 'preVerificationGas'), 'pre-verification gas'),
    },
    gas,
  )
}

/** The first draft: the lane's nonce, the bundler's fast price, a dummy signature. */
async function draft(input: BuildInput, callData: Hex): Promise<UserOperation> {
  const fast = field(await input.bundler('pimlico_getUserOperationGasPrice', []), 'fast')
  return {
    sender: input.sender,
    nonce: laneNonce(input.nonceKey),
    callData,
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: quantity(field(fast, 'maxFeePerGas'), 'max fee'),
    maxPriorityFeePerGas: quantity(field(fast, 'maxPriorityFeePerGas'), 'priority fee'),
    signature: DUMMY_SIGNATURE,
  }
}

/** The batch for a cost bound: the caller's calls, then the standing paymaster approval when it is short. */
function batcher(input: BuildInput, paymaster: Address, approve: boolean) {
  const { calls, aa } = input
  return async (maxCost: bigint): Promise<Hex> =>
    executeCalldata([
      ...(await calls(maxCost)),
      ...(approve ? [approveCall(aa.gasToken, paymaster, aa.standingApproval)] : []),
    ])
}

/** Checks the lane is free and the paymaster is configured; returns the paymaster. */
async function preflight(input: BuildInput): Promise<Address> {
  const paymaster = input.aa.paymaster
  if (paymaster === null) throw new AaError('no-paymaster', 'no paymaster is configured on this network yet')
  if ((await laneSequence(input.node, input.aa.entryPoint, input.sender, input.nonceKey)) !== 0n)
    throw new AaError('landed', 'an operation already landed on this lane: reconcile it instead of building another')
  return paymaster
}

/** Reads the lane, prices and estimates the gas, bounds its cost and fetches the paymaster's data. */
export async function buildUserOp(input: BuildInput): Promise<BuiltUserOp> {
  const { aa, chainId } = input
  const paymaster = await preflight(input)
  const sponsored = input.sponsor !== undefined
  const tokenQuote = sponsored ? null : await quote(input, paymaster)
  const approve = !sponsored && (await allowanceOf(input.node, aa.gasToken, input.sender, paymaster)) < aa.maxCostPerOp
  const batch = batcher(input, paymaster, approve)
  const context = sponsored ? { sponsor: 'faucet' } : { token: aa.gasToken }
  const params = (op: UserOperation): Json[] => [
    toBundlerJson(op, input.authorization),
    aa.entryPoint,
    toHex(chainId),
    context,
  ]
  let op = await draft(input, await batch(aa.maxCostPerOp))
  op = withPaymaster(op, await input.paymaster('pm_getPaymasterStubData', params(op)), paymaster)
  op = withEstimate(
    op,
    await input.bundler('eth_estimateUserOperationGas', [toBundlerJson(op, input.authorization), aa.entryPoint]),
  )
  const maxCost = tokenQuote === null ? 0n : maxTokenCost(op, tokenQuote)
  if (maxCost > aa.maxCostPerOp)
    throw new AaError('ceiling', `the gas could cost up to ${maxCost} base units, above the ${aa.maxCostPerOp} ceiling`)
  if (!sponsored) op = { ...op, callData: await batch(maxCost) }
  op = withPaymaster(op, await input.paymaster('pm_getPaymasterData', params(op)), paymaster)
  return {
    op,
    authorization: input.authorization,
    entryPoint: aa.entryPoint,
    chainId,
    maxCost,
    userOpHash: userOpHash(op, chainId, aa.entryPoint),
  }
}

/**
 * Hands the signed operation to the bundler once and returns its hash. Refused: nothing was taken. No answer: it may
 * have been taken (`uncertain`), so the caller reconciles through the lane before any retry.
 */
export async function sendUserOp(bundler: JsonRpc, built: BuiltUserOp, signature: Hex): Promise<Hex> {
  const op = { ...built.op, signature }
  const signer = await recoverAddress({ hash: delegatorDigest(op, built.chainId, built.entryPoint), signature })
  if (!isAddressEqual(signer, op.sender))
    throw new AaError('bad-signature', 'the signature is not from the sending account; nothing was sent')
  let sent: Json
  try {
    sent = await bundler('eth_sendUserOperation', [toBundlerJson(op, built.authorization), built.entryPoint])
  } catch (error) {
    if (error instanceof AaError && error.code === 'unavailable')
      throw new AaError('uncertain', 'the bundler did not answer the send; the operation may have gone out')
    throw error
  }
  if (!isHex(sent) || sent.toLowerCase() !== built.userOpHash.toLowerCase())
    throw new AaError('uncertain', 'the bundler answered with another operation hash; reconcile before any retry')
  return built.userOpHash
}

/** A mined operation: whether its batch ran, its bundle transaction and the gas it was charged (wei). */
export interface UserOpReceipt {
  readonly status: 'success' | 'reverted'
  readonly txHash: Hex
  readonly actualGasCost: bigint
}

/** The bundler's receipt for an operation, or null while it is not mined (or unknown to this bundler). */
export async function userOpReceipt(bundler: JsonRpc, hash: Hex): Promise<UserOpReceipt | null> {
  const receipt = await bundler('eth_getUserOperationReceipt', [hash])
  if (receipt === null) return null
  const txHash = hexField(field(field(receipt, 'receipt'), 'transactionHash'), 'bundle transaction')
  if (txHash.length !== 66) throw new AaError('unavailable', 'the receipt has no transaction')
  return {
    status: field(receipt, 'success') === true ? 'success' : 'reverted',
    txHash,
    actualGasCost: quantity(field(receipt, 'actualGasCost'), 'actual gas cost'),
  }
}
