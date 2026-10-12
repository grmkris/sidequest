import { erc20Abi } from 'viem'
/**
 * Every on-chain operation of the protocol, one function each, over viem clients. Writes simulate first (so a
 * revert surfaces with its decoded error before anything is sent), then send and wait for the receipt; a reverted
 * receipt throws. Signing helpers produce exactly the EIP-712 messages the contracts verify.
 *
 * These functions move money or change dispute state. Callers that retry must reconcile against the chain first
 * (R114-07); the board's operation records do that, this layer does not guess.
 */
import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  encodeFunctionData,
  decodeEventLog,
  keccak256,
  maxUint256,
  stringToHex,
  zeroAddress,
} from 'viem'
import {
  coreAbi,
  identityAbi,
  sidequestHoldingAbi,
  sidequestEvaluatorAbi,
  stakeVaultAbi,
  sideTokenAbi,
  testnetFaucetAbi,
} from './abi/index.ts'
import type { Deployment, Stack } from './deployment.ts'
import type { SignedEvidenceAttestation } from './batch.ts'
import { requireBondHorizon, readWindowBounds, validateOfferWindows } from './clocks.ts'
import { readBondPolicy, requireCreatorBond } from './bond-policy.ts'
import {
  type Authorization,
  type Ruling,
  type Selection,
  EMPTY_HASH,
  coreDomain,
  evaluatorDomain,
  holdingDomain,
  rulingTypes,
  selectionTypes,
  setBudgetTypes,
  submitTypes,
} from './typed-data.ts'

export type Wallet = WalletClient<Transport, Chain, Account>

/** A rejection's finding. */
export const Violation = { None: 0, Quality: 1, Falsified: 2 } as const
export type ViolationName = keyof typeof Violation

/** The ERC-8183 core's job status. */
export const JobStatus = ['Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired'] as const
export type JobStatusName = (typeof JobStatus)[number]

export interface Ctx {
  readonly publicClient: PublicClient
  readonly deployment: Deployment
  readonly stack: Stack
}

/** Hash of a human-readable string, for manifest, terms, reasons and deliverables in scripts and tests. */
export const hashText = (text: string): Hex => keccak256(stringToHex(text))

/** A random nonce that fits `uint72` (core authorisations) and `uint256` (selections, rulings). */
export function randomNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(9))
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n)
}

async function send(ctx: Ctx, wallet: Wallet, request: Parameters<Wallet['writeContract']>[0]) {
  const hash = await wallet.writeContract(request)
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`)
  return receipt
}

async function write(
  ctx: Ctx,
  wallet: Wallet,
  address: Address,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[],
  gas?: bigint,
) {
  const { request } = await ctx.publicClient.simulateContract({
    account: wallet.account,
    address,
    abi,
    functionName,
    args,
    ...(gas === undefined ? {} : { gas }),
  } as never)
  return send(ctx, wallet, request as never)
}

const holdingAbi = (_ctx: Ctx) => sidequestHoldingAbi
const evaluatorAbi = (_ctx: Ctx) => sidequestEvaluatorAbi
/** ADR-0011/D4b: Monad charges the requested limit; floors are deliberately explicit. */
export const V1_GAS = {
  settle: 1_000_000n,
  claimTopUpRefund: 450_000n,
  cancel: 700_000n,
  evaluator: 1_200_000n,
  retryDeferred: 300_000n,
} as const

// -------------------------------------------------------------------------------------------------
// Tokens and identity
// -------------------------------------------------------------------------------------------------

/** The configured testnet faucet, unavailable on mainnet. */
function testnetFaucetOf(ctx: Ctx): Address {
  if (ctx.deployment.testnetFaucet === null) throw new Error('No testnet faucet is deployed on this network')
  return ctx.deployment.testnetFaucet
}

/** Testnet only: the faucet call that gives `to` SIDE and each payment token. Anyone may send it for any address. */
export function dripCall(ctx: Ctx, to: Address): { to: Address; data: Hex } {
  return {
    to: testnetFaucetOf(ctx),
    data: encodeFunctionData({ abi: testnetFaucetAbi, functionName: 'drip', args: [to] }),
  }
}

/** Testnet only: when `to` may claim from the faucet next, in Unix seconds; 0 means now. */
export async function nextDripAt(ctx: Ctx, to: Address): Promise<number> {
  return Number(
    await ctx.publicClient.readContract({
      address: testnetFaucetOf(ctx),
      abi: testnetFaucetAbi,
      functionName: 'nextDripAt',
      args: [to],
    }),
  )
}

/** Testnet only: claims the faucet's SIDE and payment tokens for `to`, paid for by `wallet`. */
export function drip(ctx: Ctx, wallet: Wallet, to: Address = wallet.account.address) {
  return write(ctx, wallet, testnetFaucetOf(ctx), testnetFaucetAbi, 'drip', [to])
}

/** Approves `spender` for `amount` of `token` unless the allowance already covers it. */
export async function ensureAllowance(ctx: Ctx, wallet: Wallet, token: Address, spender: Address, amount: bigint) {
  const current = await ctx.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [wallet.account.address, spender],
  })
  if (current >= amount) return undefined
  return write(ctx, wallet, token, erc20Abi, 'approve', [spender, maxUint256])
}

export function balanceOf(ctx: Ctx, token: Address, who: Address) {
  return ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] })
}

/** Registers the wallet as an ERC-8004 agent; its agent wallet defaults to the owner. Returns the agent id. */
export async function registerAgent(ctx: Ctx, wallet: Wallet, agentURI: string): Promise<bigint> {
  const { request, result } = await ctx.publicClient.simulateContract({
    account: wallet.account,
    address: ctx.deployment.identity,
    abi: identityAbi,
    functionName: 'register',
    args: [agentURI],
  })
  await send(ctx, wallet, request as never)
  return result
}

export function agentWallet(ctx: Ctx, agentId: bigint) {
  return ctx.publicClient.readContract({
    address: ctx.deployment.identity,
    abi: identityAbi,
    functionName: 'getAgentWallet',
    args: [agentId],
  })
}

// -------------------------------------------------------------------------------------------------
// Publish
// -------------------------------------------------------------------------------------------------

export interface PublishInput {
  readonly token: Address
  readonly reward: bigint
  readonly creatorBond?: bigint
  readonly workerBond: bigint
  readonly manifestHash: Hex
  /** The offer's `termsHash`; Holding refuses one it has already listed. */
  readonly termsHash: Hex
  readonly deliveryDeadline: number
  /** Defaults to the creator. */
  readonly approver?: Address
  /** Frozen per offer. */
  readonly reviewWindow?: number
  readonly disputeWindow?: number
  readonly arbitrationWindow?: number
  readonly arbitrator?: Address
}

/** The earliest `expiredAt` the listing accepts: the delivery deadline plus the evaluator's settlement window. */
export async function minExpiry(
  ctx: Ctx,
  deliveryDeadline: number,
  windows?: { reviewWindow: number; disputeWindow: number; arbitrationWindow: number },
): Promise<number> {
  if (windows === undefined) throw new Error('v1 expiry needs the offer windows')
  const margin = await ctx.publicClient.readContract({
    address: ctx.stack.holding,
    abi: sidequestHoldingAbi,
    functionName: 'margin',
  })
  return deliveryDeadline + windows.reviewWindow + windows.disputeWindow + windows.arbitrationWindow + Number(margin)
}

/** Escrows the reward and posts or reserves the creator bond. Returns the job id. */
export async function publish(ctx: Ctx, wallet: Wallet, p: PublishInput) {
  if (p.arbitrator === undefined || p.arbitrator.toLowerCase() === zeroAddress)
    throw new Error('v1 publish needs an explicit arbitrator')
  const policy = await readBondPolicy(ctx)
  const creatorBond = p.creatorBond ?? policy.minimumCreatorBond
  requireCreatorBond(policy, creatorBond)
  const windows = {
    reviewWindow: p.reviewWindow,
    disputeWindow: p.disputeWindow,
    arbitrationWindow: p.arbitrationWindow,
  }
  if (Object.values(windows).some((v) => v === undefined || !Number.isSafeInteger(v) || v <= 0))
    throw new Error('v1 publish needs explicit review, dispute and arbitration windows')
  validateOfferWindows(
    { reviewSeconds: p.reviewWindow!, disputeSeconds: p.disputeWindow!, arbitrationSeconds: p.arbitrationWindow! },
    await readWindowBounds(ctx),
  )
  const expiry = await minExpiry(
    ctx,
    p.deliveryDeadline,
    windows as { reviewWindow: number; disputeWindow: number; arbitrationWindow: number },
  )
  await requireBondHorizon(ctx, expiry, creatorBond, p.workerBond)
  await requireStake(ctx, wallet.account.address, creatorBond)
  await ensureAllowance(ctx, wallet, p.token, ctx.stack.holding, p.reward)
  const receipt = await write(ctx, wallet, ctx.stack.holding, sidequestHoldingAbi, 'publish', [
    {
      approver: p.approver ?? '0x0000000000000000000000000000000000000000',
      arbitrator: p.arbitrator,
      manifestHash: p.manifestHash,
      policyHash: p.termsHash,
      token: p.token,
      reward: p.reward,
      creatorBond,
      workerBond: p.workerBond,
      deliveryDeadline: p.deliveryDeadline,
      expiredAt: expiry,
      ...windows,
    },
  ])
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ctx.stack.holding.toLowerCase()) continue
    try {
      const event = decodeEventLog({ abi: sidequestHoldingAbi, data: log.data, topics: log.topics })
      if (event.eventName === 'Published') return { jobId: event.args.jobId, receipt }
    } catch {
      /* Other logs are not the listing receipt. */
    }
  }
  throw new Error(`publish ${receipt.transactionHash} emitted no Published event`)
}

// -------------------------------------------------------------------------------------------------
// Hire: selection and activation
// -------------------------------------------------------------------------------------------------

/** The creator signs its pick of one applicant. Nothing happens on-chain until the worker activates. */
export function signSelection(ctx: Ctx, creator: Wallet, sel: Selection): Promise<Hex> {
  return creator.signTypedData({
    domain: holdingDomain(ctx.deployment.chainId, ctx.stack.holding),
    types: selectionTypes,
    primaryType: 'Selection',
    message: sel,
  })
}

/** The worker's core `SetBudgetAuthorization`, which Holding applies inside `activate`. */
export async function signBudget(
  ctx: Ctx,
  worker: Wallet,
  a: { jobId: bigint; token: Address; amount: bigint; nonce?: bigint; deadline: bigint },
): Promise<Authorization> {
  const nonce = a.nonce ?? randomNonce()
  const sig = await worker.signTypedData({
    domain: coreDomain(ctx.deployment.chainId, ctx.deployment.core),
    types: setBudgetTypes,
    primaryType: 'SetBudgetAuthorization',
    message: {
      signer: worker.account.address,
      jobId: a.jobId,
      token: a.token,
      amount: a.amount,
      optParamsHash: EMPTY_HASH,
      nonce,
      deadline: a.deadline,
    },
  })
  return { signer: worker.account.address, nonce, deadline: a.deadline, sig }
}

/** The worker's core `SubmitAuthorization` for one exact deliverable. */
export async function signSubmit(
  ctx: Ctx,
  worker: Wallet,
  a: { jobId: bigint; deliverable: Hex; nonce?: bigint; deadline: bigint },
): Promise<Authorization> {
  const nonce = a.nonce ?? randomNonce()
  const sig = await worker.signTypedData({
    domain: coreDomain(ctx.deployment.chainId, ctx.deployment.core),
    types: submitTypes,
    primaryType: 'SubmitAuthorization',
    message: {
      signer: worker.account.address,
      jobId: a.jobId,
      deliverable: a.deliverable,
      optParamsHash: EMPTY_HASH,
      nonce,
      deadline: a.deadline,
    },
  })
  return { signer: worker.account.address, nonce, deadline: a.deadline, sig }
}

/** The chain facts the worker independently accepts, besides the Selection's hash label. */
export interface ActivationTerms {
  creator: Address
  approver: Address
  token: Address
  reward: bigint
  creatorBond: bigint
  workerBond: bigint
  arbitrator: Address
  reviewWindow: number
  disputeWindow: number
  arbitrationWindow: number
  deliveryDeadline: number
}

/** Checks economic terms independently of the Selection's termsHash label (D12). */
export function assertActivationTerms(listing: ActivationTerms, expected: ActivationTerms): void {
  for (const key of ['creator', 'approver', 'token', 'arbitrator'] as const) {
    if (listing[key].toLowerCase() !== expected[key].toLowerCase())
      throw new Error(`Listing ${key} does not match the accepted offer`)
  }
  for (const key of [
    'reward',
    'creatorBond',
    'workerBond',
    'reviewWindow',
    'disputeWindow',
    'arbitrationWindow',
    'deliveryDeadline',
  ] as const) {
    if (listing[key] !== expected[key]) throw new Error(`Listing ${key} does not match the accepted offer`)
  }
}

/** The worker's activation: provider, bond, budget and funding in one transaction. V1 requires accepted chain terms. */
export async function activate(ctx: Ctx, worker: Wallet, sel: Selection, creatorSig: Hex, expected?: ActivationTerms) {
  const listing = await getListing(ctx, sel.jobId)
  if (expected === undefined) throw new Error('v1 activation needs the accepted offer terms')
  assertActivationTerms(listing, expected)
  await requireBondHorizon(ctx, listing.expiredAt, 0n, listing.workerBond)
  if (listing.policyHash.toLowerCase() !== sel.termsHash.toLowerCase())
    throw new Error('Listing policy hash does not match Selection')
  await requireStake(ctx, worker.account.address, listing.workerBond)
  const amount = (await quoteActivation(ctx, sel.jobId, worker.account.address))[2]
  const budgetAuth = await signBudget(ctx, worker, {
    jobId: sel.jobId,
    token: listing.token,
    amount,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
  })
  return write(ctx, worker, ctx.stack.holding, holdingAbi(ctx), 'activate', [sel, creatorSig, budgetAuth])
}

export function cancelSelection(ctx: Ctx, creator: Wallet, nonce: bigint) {
  return write(ctx, creator, ctx.stack.holding, holdingAbi(ctx), 'cancelSelection', [nonce])
}

export function cancel(ctx: Ctx, creator: Wallet, jobId: bigint) {
  return write(ctx, creator, ctx.stack.holding, holdingAbi(ctx), 'cancel', [jobId], V1_GAS.cancel)
}

/** The worker's final submission, sent directly to the core. */
export function submit(ctx: Ctx, worker: Wallet, jobId: bigint, deliverable: Hex) {
  return write(ctx, worker, ctx.deployment.core, coreAbi, 'submit', [jobId, deliverable, '0x'])
}

// -------------------------------------------------------------------------------------------------
// Review, dispute, ruling
// -------------------------------------------------------------------------------------------------

export function accept(ctx: Ctx, approver: Wallet, jobId: bigint) {
  return write(ctx, approver, ctx.stack.evaluator, evaluatorAbi(ctx), 'accept', [jobId], V1_GAS.evaluator)
}

export function reject(ctx: Ctx, approver: Wallet, jobId: bigint, violation: ViolationName, reasonHash: Hex) {
  return write(ctx, approver, ctx.stack.evaluator, evaluatorAbi(ctx), 'reject', [
    jobId,
    Violation[violation],
    reasonHash,
  ])
}

export function dispute(ctx: Ctx, worker: Wallet, jobId: bigint) {
  return write(ctx, worker, ctx.stack.evaluator, evaluatorAbi(ctx), 'dispute', [jobId])
}

export function rule(ctx: Ctx, arbitrator: Wallet, r: Omit<Ruling, 'deadline' | 'nonce'>) {
  return write(
    ctx,
    arbitrator,
    ctx.stack.evaluator,
    evaluatorAbi(ctx),
    'rule',
    [r.jobId, r.forWorker, r.slashLoser, r.reasonHash],
    V1_GAS.evaluator,
  )
}

/** The arbitrator signs a ruling; any harness can do this without gas. */
export function signRuling(ctx: Ctx, arbitrator: Wallet, r: Ruling): Promise<Hex> {
  return arbitrator.signTypedData({
    domain: evaluatorDomain(ctx.deployment.chainId, ctx.stack.evaluator),
    types: rulingTypes,
    primaryType: 'Ruling',
    message: r,
  })
}

/** Anyone relays a signed ruling; it carries only the arbitrator's authority. */
export function ruleWithSignature(ctx: Ctx, relayer: Wallet, r: Ruling, sig: Hex) {
  return write(ctx, relayer, ctx.stack.evaluator, evaluatorAbi(ctx), 'ruleWithSignature', [r, sig], V1_GAS.evaluator)
}

// -------------------------------------------------------------------------------------------------
// Permissionless timeouts and settlement
// -------------------------------------------------------------------------------------------------

export function completeAfterSilence(ctx: Ctx, anyone: Wallet, jobId: bigint) {
  return write(ctx, anyone, ctx.stack.evaluator, evaluatorAbi(ctx), 'completeAfterSilence', [jobId], V1_GAS.evaluator)
}

/** Finalize the undisputed finding; resolve before listing expiry for a bond penalty to apply. */
export function rejectAfterWindow(ctx: Ctx, anyone: Wallet, jobId: bigint) {
  return write(ctx, anyone, ctx.stack.evaluator, evaluatorAbi(ctx), 'rejectAfterWindow', [jobId], V1_GAS.evaluator)
}

export function refundAfterArbitrationTimeout(ctx: Ctx, anyone: Wallet, jobId: bigint) {
  return write(
    ctx,
    anyone,
    ctx.stack.evaluator,
    evaluatorAbi(ctx),
    'refundAfterArbitrationTimeout',
    [jobId],
    V1_GAS.evaluator,
  )
}

/** Resolve missed delivery after its deadline; before listing expiry it penalizes, at or after expiry it releases. */
export function burnMissedDelivery(ctx: Ctx, anyone: Wallet, jobId: bigint) {
  return write(
    ctx,
    anyone,
    ctx.stack.evaluator,
    evaluatorAbi(ctx),
    'rejectAfterDeliveryDeadline',
    [jobId],
    V1_GAS.evaluator,
  )
}

/** Pays whatever of a terminal job is still in Holding to whoever the evaluator says is owed it. */
export function settle(ctx: Ctx, anyone: Wallet, jobId: bigint) {
  return write(ctx, anyone, ctx.stack.holding, holdingAbi(ctx), 'settle', [jobId], V1_GAS.settle)
}

/** C9 deferred decision recovery. A caller must send this before `settle`. */
export function retryDeferred(ctx: Ctx, anyone: Wallet, jobId: bigint) {
  return write(ctx, anyone, ctx.stack.evaluator, sidequestEvaluatorAbi, 'retryDeferred', [jobId], V1_GAS.retryDeferred)
}

/** Waits for the deferred core recovery before settling. Reconcile both calls before retrying. */
export async function settleDeferred(ctx: Ctx, anyone: Wallet, jobId: bigint) {
  const retry = await retryDeferred(ctx, anyone, jobId)
  const settled = await settle(ctx, anyone, jobId)
  return { retry, settled }
}

export async function topUp(ctx: Ctx, contributor: Wallet, jobId: bigint, amount: bigint) {
  if (amount <= 0n) throw new Error('top-up amount must be positive')
  const listing = await getListing(ctx, jobId)
  await ensureAllowance(ctx, contributor, listing.token, ctx.stack.holding, amount)
  return write(ctx, contributor, ctx.stack.holding, sidequestHoldingAbi, 'topUp', [jobId, amount])
}

export function claimTopUpRefund(
  ctx: Ctx,
  caller: Wallet,
  jobId: bigint,
  contributor: Address = caller.account.address,
) {
  return write(
    ctx,
    caller,
    ctx.stack.holding,
    sidequestHoldingAbi,
    'claimTopUpRefund',
    [jobId, contributor],
    V1_GAS.claimTopUpRefund,
  )
}

export async function delegate(ctx: Ctx, staker: Wallet, amount: bigint, account: Address = staker.account.address) {
  if (ctx.deployment.sidequest === null) throw new Error('delegate is only available on sidequest-v1')
  if (amount <= 0n) throw new Error('delegation amount must be positive')
  await ensureAllowance(ctx, staker, ctx.deployment.sidequest.factory, ctx.deployment.sidequest.vault, amount)
  return write(ctx, staker, ctx.deployment.sidequest.vault, stakeVaultAbi, 'delegate', [account, amount])
}

export function delegateWithPermit(
  ctx: Ctx,
  staker: Wallet,
  amount: bigint,
  permit: { deadline: bigint; v: number; r: Hex; s: Hex },
  account: Address = staker.account.address,
) {
  if (ctx.deployment.sidequest === null) throw new Error('delegateWithPermit is only available on sidequest-v1')
  if (amount <= 0n) throw new Error('delegation amount must be positive')
  return write(ctx, staker, ctx.deployment.sidequest.vault, stakeVaultAbi, 'delegateWithPermit', [
    account,
    amount,
    permit.deadline,
    permit.v,
    permit.r,
    permit.s,
  ])
}

export async function delegatePermit(ctx: Ctx, staker: Address, amount: bigint, deadline: bigint) {
  if (ctx.deployment.sidequest === null) throw new Error('delegatePermit is only available on sidequest-v1')
  const factory = ctx.deployment.sidequest.factory
  const [name, nonce] = await Promise.all([
    ctx.publicClient.readContract({ address: factory, abi: sideTokenAbi, functionName: 'name' }),
    ctx.publicClient.readContract({ address: factory, abi: sideTokenAbi, functionName: 'nonces', args: [staker] }),
  ])
  return {
    domain: { name, version: '1', chainId: ctx.deployment.chainId, verifyingContract: factory },
    primaryType: 'Permit' as const,
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    message: { owner: staker, spender: ctx.deployment.sidequest.vault, value: amount, nonce, deadline },
  }
}

/** Convert SIDE assets to an owned, unqueued share amount before preparing an exit. */
export async function undelegationShares(
  ctx: Ctx,
  account: Address,
  delegator: Address,
  amount: bigint,
): Promise<bigint> {
  if (ctx.deployment.sidequest === null) throw new Error('undelegation requires Sidequest v1')
  if (amount <= 0n) throw new Error('undelegation amount must be positive')
  const vault = ctx.deployment.sidequest.vault
  const blockNumber = await ctx.publicClient.getBlockNumber({ cacheTime: 0 })
  const [position, pool, converted] = await Promise.all([
    ctx.publicClient.readContract({
      address: vault,
      abi: stakeVaultAbi,
      functionName: 'positionOf',
      args: [account, delegator],
      blockNumber,
    }),
    ctx.publicClient.readContract({
      address: vault,
      abi: stakeVaultAbi,
      functionName: 'poolOf',
      args: [account],
      blockNumber,
    }),
    ctx.publicClient.readContract({
      address: vault,
      abi: stakeVaultAbi,
      functionName: 'convertToShares',
      args: [account, amount],
      blockNumber,
    }),
  ])
  const owned = position.shares - position.queuedShares
  const value = pool.shares === 0n ? 0n : (owned * pool.assets) / pool.shares
  if (amount > value) throw new Error('undelegation amount exceeds the owned position')
  // MAX must redeem every owned share, including a remainder hidden by asset rounding.
  const shares = amount === value ? owned : converted
  if (shares > owned) throw new Error('undelegation amount exceeds the owned position')
  if (shares === 0n) throw new Error('undelegation amount rounds to zero shares')
  return shares
}

export async function requestUndelegate(
  ctx: Ctx,
  staker: Wallet,
  amount: bigint,
  account: Address = staker.account.address,
) {
  if (ctx.deployment.sidequest === null) throw new Error('requestUndelegate is only available on sidequest-v1')
  const shares = await undelegationShares(ctx, account, staker.account.address, amount)
  return write(ctx, staker, ctx.deployment.sidequest.vault, stakeVaultAbi, 'requestUndelegate', [account, shares])
}

export function cancelUndelegate(ctx: Ctx, staker: Wallet, account: Address = staker.account.address) {
  if (ctx.deployment.sidequest === null) throw new Error('cancelUndelegate is only available on sidequest-v1')
  return write(ctx, staker, ctx.deployment.sidequest.vault, stakeVaultAbi, 'cancelUndelegate', [account])
}

export function withdraw(ctx: Ctx, staker: Wallet, account: Address = staker.account.address) {
  if (ctx.deployment.sidequest === null) throw new Error('withdraw is only available on sidequest-v1')
  return write(ctx, staker, ctx.deployment.sidequest.vault, stakeVaultAbi, 'withdraw', [account])
}

export async function requireStake(ctx: Ctx, account: Address, bond: bigint): Promise<void> {
  if (bond < 0n) throw new Error('bond cannot be negative')
  if (bond === 0n) return
  if (ctx.deployment.sidequest === null) throw new Error('Backing requires Sidequest v1')
  const available = await ctx.publicClient.readContract({
    address: ctx.deployment.sidequest.vault,
    abi: stakeVaultAbi,
    functionName: 'availableOf',
    args: [account],
  })
  if (available < bond)
    throw new Error('Insufficient available stake for the bond; back the account with SIDE before proceeding')
}

export function quoteActivation(ctx: Ctx, jobId: bigint, worker: Address) {
  return ctx.publicClient.readContract({
    address: ctx.stack.holding,
    abi: sidequestHoldingAbi,
    functionName: 'quoteActivation',
    args: [jobId, worker],
  })
}

// -------------------------------------------------------------------------------------------------
// Reads
// -------------------------------------------------------------------------------------------------

export async function getJob(ctx: Ctx, jobId: bigint) {
  const job = await ctx.publicClient.readContract({
    address: ctx.deployment.core,
    abi: coreAbi,
    functionName: 'getJob',
    args: [jobId],
  })
  return { ...job, statusName: JobStatus[job.status] as JobStatusName }
}

export function getListing(ctx: Ctx, jobId: bigint) {
  return getV1Listing(ctx, jobId)
}

export function selectionDigest(ctx: Ctx, sel: Selection) {
  return ctx.publicClient.readContract({
    address: ctx.stack.holding,
    abi: holdingAbi(ctx),
    functionName: 'selectionDigest',
    args: [sel],
  })
}

export function getV1Listing(ctx: Ctx, jobId: bigint) {
  return ctx.publicClient.readContract({
    address: ctx.stack.holding,
    abi: sidequestHoldingAbi,
    functionName: 'getListing',
    args: [jobId],
  })
}

export function termsOf(ctx: Ctx, jobId: bigint) {
  return ctx.publicClient.readContract({
    address: ctx.stack.holding,
    abi: sidequestHoldingAbi,
    functionName: 'termsOf',
    args: [jobId],
  })
}

export function caseOf(ctx: Ctx, jobId: bigint) {
  return ctx.publicClient.readContract({
    address: ctx.stack.evaluator,
    abi: sidequestEvaluatorAbi,
    functionName: 'caseOf',
    args: [jobId],
  })
}

export function cancelRuling(ctx: Ctx, arbitrator: Wallet, nonce: bigint) {
  return write(ctx, arbitrator, ctx.stack.evaluator, sidequestEvaluatorAbi, 'cancelRuling', [nonce])
}

export function withdrawOwed(ctx: Ctx, account: Wallet, token: Address) {
  return write(ctx, account, ctx.stack.holding, holdingAbi(ctx), 'withdraw', [token])
}

export function rulingDigest(ctx: Ctx, r: Ruling) {
  return ctx.publicClient.readContract({
    address: ctx.stack.evaluator,
    abi: evaluatorAbi(ctx),
    functionName: 'rulingDigest',
    args: [r],
  })
}

/** Attaches signed evidence from the worker wallet; use attachEvidenceCall to include it in the submit batch. */
export function attachEvidence(
  ctx: Ctx,
  worker: Wallet,
  attestation: SignedEvidenceAttestation['attestation'],
  verifier: Address,
  sig: Hex,
) {
  const normalized = { ...attestation, jobId: BigInt(attestation.jobId), validUntil: BigInt(attestation.validUntil) }
  return write(ctx, worker, ctx.stack.evaluator, evaluatorAbi(ctx), 'attachEvidence', [
    normalized.jobId,
    normalized,
    verifier,
    sig,
  ])
}
