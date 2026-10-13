/**
 * Builds, sends and reads back one user operation (ADR-0023). Building reads the operation's nonce lane, prices the
 * gas, estimates it, bounds what the paymaster may take against the network's ceiling and fetches the paymaster's
 * data; the result is everything but the signature. A MON-paid operation (`payment: 'native'`) has no paymaster: the
 * DeleGator pays the EntryPoint's prefund from its own balance in `validateUserOp`, so it is bounded in wei and checked
 * against the account's balance and Monad's reserve instead. Sending checks that the signature recovers to the sender
 * over the DeleGator's digest before the bundler sees it. The same code serves the Worker (hosted agents) and the
 * browser.
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
import { type TokenQuote, keepsReserve, maxNativeCost, maxTokenCost, missingAccountFunds } from './fees.ts'
import { AaError, type Json, type JsonRpc, field, hexField, quantity } from './rpc.ts'
import { type UserOperation, approveCall, delegatorDigest, laneNonce, toBundlerJson, userOpHash } from './userop.ts'

/**
 * A well-formed ECDSA signature for estimation: it recovers to some other address, so the DeleGator reports a failed
 * validation instead of reverting on a malformed one.
 */
export const ESTIMATE_SIGNATURE: Hex =
  '0xbbab8d71ce002d90139cb92579e2311de0983756e4d23be16652859b201bdecc407ee1174363f8dcfc69492d377c15c81d5c1560faf03ed23b1a24f8f044cf091c'

const entryPointAbi = parseAbi([
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
])
const SEQUENCE = (1n << 64n) - 1n

export interface BuildInput {
  readonly aa: AccountAbstraction
  readonly chainId: number
  /** The chain's node: the nonce lane and the paymaster allowance are read there. */
  readonly node: JsonRpc
  readonly bundler: JsonRpc
  /**
   * The ERC-7677 paymaster service (Pimlico on mainnet, our Worker on testnet); it also answers token quotes. A
   * MON-paid operation never calls it.
   */
  readonly paymaster: JsonRpc
  readonly sender: Address
  /**
   * The batch, before any paymaster approval, for the most the gas may cost in the gas token (in wei when MON-paid):
   * first the ceiling (for the estimate), then the bound itself, so a gas pull can take just enough. Fixed calls ignore
   * it.
   */
  readonly calls: (maxCost: bigint) => readonly Call[] | Promise<readonly Call[]>
  /** The operation's lane (`nonceKey(operationId)`): every attempt of one operation shares its nonce. */
  readonly nonceKey: bigint
  /** The sender's 7702 authorization, when its code does not point at the DeleGator yet. */
  readonly authorization?: SignedAuthorization | undefined
  /** Testnet only: Pimlico sponsors a faucet claim instead of charging the gas token. */
  readonly sponsor?: 'faucet' | undefined
  /**
   * The least call gas the batch needs, whatever the estimate says: calls that push payouts revert with
   * `TransferGasTooLow` below a fixed reserve, which an estimate does not see (Explore's `gas.ts` floors).
   */
  readonly minCallGas?: bigint | undefined
  /**
   * Who pays the gas. `token` (the default): the paymaster, in the gas token. `native`: the account itself, in MON, with
   * no paymaster; bounded by `aa.maxNativeCostPerOp` and refused where paying would break Monad's reserve rule.
   */
  readonly payment?: 'token' | 'native' | undefined
}

/** An operation ready to sign, the most its gas may cost and the hash it will go by. */
export interface BuiltUserOp {
  readonly op: UserOperation
  readonly authorization?: SignedAuthorization | undefined
  readonly entryPoint: Address
  readonly chainId: number
  /** Gas token base units; 0 when sponsored; wei when MON-paid (the operation has no paymaster). */
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
function withPaymaster(op: UserOperation, answer: Json, paymaster: Address | null): UserOperation {
  const address = hexField(field(answer, 'paymaster'), 'paymaster')
  if (address.length !== 42 || (paymaster !== null && !named(address, paymaster)))
    throw new AaError('mismatch', 'the paymaster service answered for another paymaster')
  return paymasterLimits(
    { ...op, paymaster: address, paymasterData: hexField(field(answer, 'paymasterData'), 'paymaster data') },
    answer,
  )
}

const atLeast = (value: bigint | undefined, floor: bigint | undefined): bigint | undefined =>
  value === undefined || (floor !== undefined && floor > value) ? floor : value

/**
 * The bundler's estimate into the operation. Monad bills the whole limit: the call gets 10% for state moving, no more,
 * and never less than the batch's own floor. The paymaster's own limits never drop below its stub's: its quote signer
 * refuses a post-op limit too small to charge the token (ours needs 160k), whatever the bundler measured.
 */
function withEstimate(op: UserOperation, gas: Json, minCallGas: bigint): UserOperation {
  const estimated = (quantity(field(gas, 'callGasLimit'), 'call gas') * 11n) / 10n
  const merged = paymasterLimits(
    {
      ...op,
      callGasLimit: estimated > minCallGas ? estimated : minCallGas,
      verificationGasLimit: quantity(field(gas, 'verificationGasLimit'), 'verification gas'),
      preVerificationGas: quantity(field(gas, 'preVerificationGas'), 'pre-verification gas'),
    },
    gas,
  )
  const verification = atLeast(merged.paymasterVerificationGasLimit, op.paymasterVerificationGasLimit)
  const postOp = atLeast(merged.paymasterPostOpGasLimit, op.paymasterPostOpGasLimit)
  return {
    ...merged,
    ...(verification === undefined ? {} : { paymasterVerificationGasLimit: verification }),
    ...(postOp === undefined ? {} : { paymasterPostOpGasLimit: postOp }),
  }
}

/**
 * A sponsoring paymaster (Pimlico's, for a testnet faucet claim) estimates the operation itself and signs over its own
 * gas limits, so its final answer's limits replace ours: keeping ours would break its signature (AA34).
 */
function withSponsorGas(op: UserOperation, answer: Json): UserOperation {
  const call = limit(answer, 'callGasLimit')
  const verification = limit(answer, 'verificationGasLimit')
  const preVerification = limit(answer, 'preVerificationGas')
  return {
    ...op,
    ...(call === undefined ? {} : { callGasLimit: call }),
    ...(verification === undefined ? {} : { verificationGasLimit: verification }),
    ...(preVerification === undefined ? {} : { preVerificationGas: preVerification }),
  }
}

/**
 * Pre-verification gas prices the operation's calldata, and the bundler measures it with our placeholder signature and
 * the paymaster's stub data. The real signature and paymaster data have fewer zero bytes, so the bare estimate comes up
 * a few dozen gas short at send (seen live on dev: 310563 sent, 310601 required). 10% covers that. A sponsor keeps a
 * higher value we give it and signs over it.
 */
function withPreVerificationMargin(op: UserOperation): UserOperation {
  return { ...op, preVerificationGas: (op.preVerificationGas * 110n + 99n) / 100n }
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
    signature: ESTIMATE_SIGNATURE,
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

/**
 * Our testnet paymaster charges the gas token in postOp, and a bundler's estimate simulates postOp with inflated gas
 * that the sender's funds can't cover, so estimating with it attached fails (AA50, seen live on dev, whatever overrides
 * are given). So its ops are estimated unpaid, with only the sender's native balance overridden for the prefund. Its
 * own fixed limits come from the stub afterwards.
 */
const unpaidEstimate = (input: BuildInput, paymaster: Address | null): boolean =>
  input.aa.paymasterKind === 'sidequest-testnet' && paymaster !== null && input.sponsor === undefined

/**
 * A native balance the sender holds during an unpaid estimate, so the EntryPoint's prefund check passes: a bundler
 * simulates with inflated limits whose prefund a real balance need not cover. A MON-paid operation's real balance is
 * checked against its bound afterwards (`affordable`).
 */
const PREFUND_OVERRIDE = 10n ** 24n

/** The operation without any paymaster field. */
function bare(op: UserOperation): UserOperation {
  const {
    paymaster: _p,
    paymasterData: _d,
    paymasterVerificationGasLimit: _v,
    paymasterPostOpGasLimit: _o,
    ...rest
  } = op
  return rest
}

/** The bundler's estimate request, unpaid where `unpaidEstimate` says so (and always when MON-paid). */
function estimateParams(input: BuildInput, op: UserOperation, unpaid: boolean): Json[] {
  if (!unpaid) return [toBundlerJson(op, input.authorization), input.aa.entryPoint]
  return [
    toBundlerJson(bare(op), input.authorization),
    input.aa.entryPoint,
    { [input.sender]: { balance: toHex(PREFUND_OVERRIDE) } },
  ]
}

/** Every gas unit the operation's limits name. */
const limitsOf = (op: UserOperation): bigint =>
  op.verificationGasLimit +
  op.callGasLimit +
  (op.paymasterVerificationGasLimit ?? 0n) +
  (op.paymasterPostOpGasLimit ?? 0n)

/**
 * The limits the bundler priced its pre-verification gas for: its own measurement, before our margin and floor. An
 * unpaid estimate measured no paymaster.
 */
function measuredLimits(gas: Json, unpaid: boolean): bigint {
  const measured =
    quantity(field(gas, 'verificationGasLimit'), 'verification gas') + quantity(field(gas, 'callGasLimit'), 'call gas')
  if (unpaid) return measured
  return measured + (limit(gas, 'paymasterVerificationGasLimit') ?? 0n) + (limit(gas, 'paymasterPostOpGasLimit') ?? 0n)
}

/** After an unpaid estimate: the stub's paymaster limits. */
function withStubLimits(op: UserOperation, stub: UserOperation): UserOperation {
  const verification = stub.paymasterVerificationGasLimit ?? op.paymasterVerificationGasLimit
  const postOp = stub.paymasterPostOpGasLimit ?? op.paymasterPostOpGasLimit
  return {
    ...op,
    ...(verification === undefined ? {} : { paymasterVerificationGasLimit: verification }),
    ...(postOp === undefined ? {} : { paymasterPostOpGasLimit: postOp }),
  }
}

/**
 * On Monad a bundler prices pre-verification gas from the operation's limits, because the chain bills the whole
 * limit. Anything that raises them after the estimate raises what it requires: our paymaster's limits after an unpaid
 * estimate (342947 unpaid, 520126 required), a SIDE sale's batch floor above its estimate (573535 sent, 715771
 * required), a sponsored faucet claim's floor (276351 sent, 292982 required; all live on dev, 12–13 Oct). So it is
 * scaled by how much the limits grew over the ones the bundler measured, on every path.
 */
function scaledPreVerification(op: UserOperation, measured: bigint): UserOperation {
  const sent = limitsOf(op)
  if (measured === 0n || sent <= measured) return op
  return { ...op, preVerificationGas: (op.preVerificationGas * sent + measured - 1n) / measured }
}

/**
 * The bound shown and pulled for is the one signed: final paymaster limits above the bounded ones would raise what the
 * operation can cost (found in the pre-launch review, 13 Oct).
 */
function keptBound(op: UserOperation, tokenQuote: TokenQuote, maxCost: bigint): void {
  if (maxTokenCost(op, tokenQuote) > maxCost)
    throw new AaError('mismatch', 'the paymaster raised its gas limits after the cost was bounded')
}

/** Refuses a lane an operation already landed on: every attempt of one operation shares its nonce. */
async function freeLane(input: BuildInput): Promise<void> {
  if ((await laneSequence(input.node, input.aa.entryPoint, input.sender, input.nonceKey)) !== 0n)
    throw new AaError('landed', 'an operation already landed on this lane: reconcile it instead of building another')
}

/** Checks the lane is free and the paymaster is configured; returns the paymaster. */
async function preflight(input: BuildInput): Promise<Address | null> {
  const paymaster = input.aa.paymaster
  if (input.sponsor !== undefined && input.chainId !== 10143)
    throw new AaError('refused', 'faucet sponsorship is testnet only')
  if (paymaster === null && input.sponsor === undefined)
    throw new AaError('no-paymaster', 'no paymaster is configured on this network yet')
  await freeLane(input)
  return paymaster
}

/** The account's MON deposit at the EntryPoint: what is left of earlier MON-paid prefunds. */
async function entryPointDeposit(node: JsonRpc, entryPoint: Address, account: Address): Promise<bigint> {
  const data = encodeFunctionData({ abi: entryPointAbi, functionName: 'balanceOf', args: [account] })
  const result = await readCall(node, entryPoint, data)
  return decodeFunctionResult({ abi: entryPointAbi, functionName: 'balanceOf', data: result })
}

/**
 * Refuses a MON-paid operation its account cannot pay: the account sends the EntryPoint what its deposit there does not
 * cover, and on Monad a bundler's transaction that takes a delegated account below its reserve reverts whole.
 */
async function affordable(input: BuildInput, maxCost: bigint): Promise<void> {
  const [balance, deposit] = await Promise.all([
    input.node('eth_getBalance', [input.sender, 'latest']).then((answer) => quantity(answer, 'balance')),
    entryPointDeposit(input.node, input.aa.entryPoint, input.sender),
  ])
  const missing = missingAccountFunds(maxCost, deposit)
  if (!keepsReserve(balance, missing, input.aa.nativeReserve))
    throw new AaError(
      'ceiling',
      `the account holds ${balance} wei; paying up to ${missing} wei of gas must leave the ${input.aa.nativeReserve} wei reserve`,
    )
}

/**
 * A MON-paid operation: no paymaster call at all. Estimated unpaid like our testnet paymaster's ops, priced for the
 * limits it sends, bounded in wei against the network's ceiling and against what the account can pay.
 */
async function buildNativeUserOp(input: BuildInput): Promise<BuiltUserOp> {
  const { aa, chainId } = input
  const ceiling = aa.maxNativeCostPerOp
  if (input.sponsor !== undefined) throw new AaError('refused', 'a sponsored operation is not MON-paid')
  if (ceiling === null) throw new AaError('unavailable', 'MON-paid user operations are not configured on this network')
  await freeLane(input)
  const batch = async (maxCost: bigint): Promise<Hex> => executeCalldata(await input.calls(maxCost))
  let op = await draft(input, await batch(ceiling))
  const gas = await input.bundler('eth_estimateUserOperationGas', estimateParams(input, op, true))
  op = bare(withEstimate(op, gas, input.minCallGas ?? 0n))
  op = scaledPreVerification(op, measuredLimits(gas, true))
  op = withPreVerificationMargin(op)
  const maxCost = maxNativeCost(op)
  if (maxCost > ceiling)
    throw new AaError('ceiling', `the gas could cost up to ${maxCost} wei, above the ${ceiling} wei ceiling`)
  await affordable(input, maxCost)
  op = { ...op, callData: await batch(maxCost) }
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
 * Reads the lane, prices and estimates the gas and bounds its cost; fetches the paymaster's data unless the account
 * pays in MON.
 */
export async function buildUserOp(input: BuildInput): Promise<BuiltUserOp> {
  return input.payment === 'native' ? buildNativeUserOp(input) : buildTokenUserOp(input)
}

/** A paymaster-paid operation: in the gas token, or sponsored (a testnet faucet claim). */
async function buildTokenUserOp(input: BuildInput): Promise<BuiltUserOp> {
  const { aa, chainId } = input
  const paymaster = await preflight(input)
  const sponsored = input.sponsor !== undefined
  const tokenQuote = sponsored || paymaster === null ? null : await quote(input, paymaster)
  const approve =
    !sponsored &&
    paymaster !== null &&
    (await allowanceOf(input.node, aa.gasToken, input.sender, paymaster)) < aa.maxCostPerOp
  const batch = batcher(input, paymaster ?? aa.entryPoint, approve)
  const context = sponsored ? { sponsor: 'faucet' } : { token: aa.gasToken }
  const params = (op: UserOperation): Json[] => [
    toBundlerJson(op, input.authorization),
    aa.entryPoint,
    toHex(chainId),
    context,
  ]
  const unpaid = unpaidEstimate(input, paymaster)
  let op = await draft(input, await batch(aa.maxCostPerOp))
  op = withPaymaster(op, await input.paymaster('pm_getPaymasterStubData', params(op)), sponsored ? null : paymaster)
  const stub = op
  const gas = await input.bundler('eth_estimateUserOperationGas', estimateParams(input, op, unpaid))
  op = withEstimate(op, gas, input.minCallGas ?? 0n)
  if (unpaid) op = withStubLimits(op, stub)
  op = scaledPreVerification(op, measuredLimits(gas, unpaid))
  op = withPreVerificationMargin(op)
  const maxCost = tokenQuote === null ? 0n : maxTokenCost(op, tokenQuote)
  if (maxCost > aa.maxCostPerOp)
    throw new AaError('ceiling', `the gas could cost up to ${maxCost} base units, above the ${aa.maxCostPerOp} ceiling`)
  if (!sponsored) op = { ...op, callData: await batch(maxCost) }
  const final = await input.paymaster('pm_getPaymasterData', params(op))
  op = withPaymaster(op, final, sponsored ? null : paymaster)
  if (sponsored) op = withSponsorGas(op, final)
  else if (tokenQuote !== null) keptBound(op, tokenQuote, maxCost)
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
