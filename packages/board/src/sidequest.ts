import { erc20Abi } from 'viem'
/** V1 preparation. Chain facts remain authoritative; the board supplies unsigned calls only. */
import * as sdk from '@sidequest/sdk'
import { type Address, type Hex, encodeFunctionData, formatEther, getAddress, zeroAddress } from 'viem'
import { AgentFailure } from './agent-failure.ts'
import { BoardError } from './board-error.ts'
import { type EvaluatorWindows, type OfferTerms, listingMatches } from './terms.ts'

export const holdingAbi = (_ctx: sdk.Ctx) => sdk.sidequestHoldingAbi
export const evaluatorAbi = (_ctx: sdk.Ctx) => sdk.sidequestEvaluatorAbi

export function rulingNonceUsed(ctx: sdk.Ctx, arbitrator: Address, nonce: bigint) {
  return ctx.publicClient.readContract({
    address: ctx.stack.evaluator,
    abi: sdk.sidequestEvaluatorAbi,
    functionName: 'rulingNonceUsed',
    args: [arbitrator, nonce],
  })
}

export async function offerWindows(
  ctx: sdk.Ctx,
  input: EvaluatorWindows | undefined,
  options: { deliveryDeadline?: number; creatorBond?: bigint; workerBond?: bigint } = {},
): Promise<EvaluatorWindows> {
  if (input !== undefined) return input
  const bounds = await sdk.readWindowBounds(ctx)
  const bond = (options.creatorBond ?? 0n) + (options.workerBond ?? 0n)
  if (options.deliveryDeadline === undefined || bond === 0n) return sdk.standardOfferWindows(bounds)
  const [block, delay, margin] = await Promise.all([
    ctx.publicClient.getBlock(),
    sdk.readUnstakeDelay(ctx),
    ctx.publicClient.readContract({ address: ctx.stack.holding, abi: sdk.sidequestHoldingAbi, functionName: 'margin' }),
  ])
  try {
    return sdk.fitBondedOfferWindows(undefined, bounds, {
      now: Number(block.timestamp),
      deliveryDeadline: options.deliveryDeadline,
      unstakeDelay: delay,
      margin,
      bond,
    })
  } catch (error) {
    if (error instanceof sdk.BondHorizonError) throw new BoardError('invalid', error.message)
    throw error
  }
}

export async function offerArbitrator(ctx: sdk.Ctx, requested?: string): Promise<Address | undefined> {
  return requested === undefined
    ? ctx.publicClient.readContract({
        address: ctx.stack.holding,
        abi: sdk.sidequestHoldingAbi,
        functionName: 'defaultArbitrator',
      })
    : getAddress(requested)
}

export function transaction(ctx: sdk.Ctx, description: string, to: Address, data: Hex, gas?: bigint): sdk.TxRequest {
  return {
    description,
    chainId: ctx.deployment.chainId,
    to,
    data,
    value: '0',
    ...(gas === undefined ? {} : { gas: gas.toString() }),
  }
}

/**
 * A bond needs that much backing still available behind the account. Short, say who and by how much, as a refusal the
 * caller can act on (the SDK's plain error would reach the caller only as an internal failure). With `ask`, a hosted
 * agent is also told how to get it: request_backing, or the operator's link to its backing with the shortfall filled in.
 */
export async function requireBacking(
  ctx: sdk.Ctx,
  account: Address,
  bond: bigint,
  role: 'creator' | 'worker',
  ask?: { origin: string; agentId: string },
): Promise<void> {
  if (bond === 0n || ctx.deployment.sidequest === null) return sdk.requireStake(ctx, account, bond)
  const available = await ctx.publicClient.readContract({
    address: ctx.deployment.sidequest.vault,
    abi: sdk.stakeVaultAbi,
    functionName: 'availableOf',
    args: [account],
  })
  if (available >= bond) return
  const short = formatEther(bond - available)
  const how =
    ask === undefined
      ? ''
      : `. Call request_backing, or send your operator ${ask.origin}/agent/${encodeURIComponent(ask.agentId)}?back=${short} to back it with ${short} SIDE from their wallet`
  throw new AgentFailure(
    'conflict',
    `The ${role} bond is ${formatEther(bond)} SIDE but only ${formatEther(available)} SIDE of backing is available behind ${account}; back it with more SIDE, then retry${how}`,
    'insufficient-backing',
    'after-operator',
  )
}

export async function publishSidequest(ctx: sdk.Ctx, terms: OfferTerms, hash: Hex): Promise<sdk.TxRequest[]> {
  if (terms.arbitrator === undefined || terms.arbitrator.toLowerCase() === zeroAddress)
    throw new Error('v1 publish needs an explicit arbitrator')
  const windows = {
    reviewWindow: terms.windows.reviewSeconds,
    disputeWindow: terms.windows.disputeSeconds,
    arbitrationWindow: terms.windows.arbitrationSeconds,
  }
  const expiredAt = await sdk.minExpiry(ctx, terms.deliveryDeadline, windows)
  await requireCreatorBond(ctx, terms.creatorBond)
  await requireBondHorizon(ctx, expiredAt, terms.creatorBond, terms.workerBond)
  const allowance = await ctx.publicClient.readContract({
    address: terms.token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [terms.creator, ctx.stack.holding],
  })
  const out: sdk.TxRequest[] = []
  if (allowance < terms.reward)
    out.push(
      transaction(
        ctx,
        'Approve the escrowed reward',
        terms.token,
        encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ctx.stack.holding, terms.reward] }),
      ),
    )
  out.push(
    transaction(
      ctx,
      'Publish the funded hire and reserve your bond from stake',
      ctx.stack.holding,
      encodeFunctionData({
        abi: sdk.sidequestHoldingAbi,
        functionName: 'publish',
        args: [
          {
            approver: terms.approver,
            arbitrator: terms.arbitrator,
            manifestHash: hash,
            policyHash: hash,
            token: terms.token,
            reward: terms.reward,
            creatorBond: terms.creatorBond,
            workerBond: terms.workerBond,
            deliveryDeadline: terms.deliveryDeadline,
            expiredAt,
            ...windows,
          },
        ],
      }),
    ),
  )
  return out
}

/** Preserve RPC failures as unavailable; only the trusted horizon refusal is caller-facing. */
export async function requireBondHorizon(
  ctx: sdk.Ctx,
  expiredAt: number,
  creatorBond: bigint,
  workerBond = 0n,
): Promise<void> {
  try {
    await sdk.requireBondHorizon(ctx, expiredAt, creatorBond, workerBond)
  } catch (error) {
    if (error instanceof sdk.BondHorizonError) throw new BoardError('invalid', error.message)
    throw error
  }
}

export async function requireOfferHorizon(
  ctx: sdk.Ctx,
  terms: Pick<OfferTerms, 'deliveryDeadline' | 'windows' | 'creatorBond' | 'workerBond'>,
): Promise<void> {
  await requireCreatorBond(ctx, terms.creatorBond)
  const expiredAt = await sdk.minExpiry(ctx, terms.deliveryDeadline, {
    reviewWindow: terms.windows.reviewSeconds,
    disputeWindow: terms.windows.disputeSeconds,
    arbitrationWindow: terms.windows.arbitrationSeconds,
  })
  await requireBondHorizon(ctx, expiredAt, terms.creatorBond, terms.workerBond)
}

export async function requireCreatorBond(ctx: sdk.Ctx, amount: bigint): Promise<void> {
  const policy = await sdk.readBondPolicy(ctx)
  if (amount < policy.minimumCreatorBond)
    throw new BoardError(
      'invalid',
      `Creator bond must be at least ${formatEther(policy.minimumCreatorBond)} SIDE. Create a new offer; frozen terms cannot be changed.`,
    )
}

function acceptedActivationTerms(terms: OfferTerms): sdk.ActivationTerms {
  if (terms.arbitrator === undefined) throw new Error('v1 offer has no frozen arbitrator')
  return {
    creator: terms.creator,
    approver: terms.approver,
    token: terms.token,
    reward: terms.reward,
    creatorBond: terms.creatorBond,
    workerBond: terms.workerBond,
    arbitrator: terms.arbitrator,
    deliveryDeadline: terms.deliveryDeadline,
    reviewWindow: terms.windows.reviewSeconds,
    disputeWindow: terms.windows.disputeSeconds,
    arbitrationWindow: terms.windows.arbitrationSeconds,
  }
}

function matchesSidequest(
  terms: OfferTerms,
  hash: Hex,
  listing: Awaited<ReturnType<typeof sdk.getV1Listing>>,
): boolean {
  try {
    sdk.assertActivationTerms(listing, acceptedActivationTerms(terms))
  } catch {
    return false
  }
  return listingMatches(terms, hash, listing)
}

export async function activationQuote(ctx: sdk.Ctx, jobId: bigint, worker: Address, terms: OfferTerms) {
  const listing = await sdk.getV1Listing(ctx, jobId)
  sdk.assertActivationTerms(listing, acceptedActivationTerms(terms))
  await requireBondHorizon(ctx, listing.expiredAt, 0n, listing.workerBond)
  await requireBacking(ctx, worker, terms.workerBond, 'worker')
  const [feeBps, fee, net] = await sdk.quoteActivation(ctx, jobId, worker)
  return { feeBps, fee, net }
}

export async function sidequestChainView(ctx: sdk.Ctx, jobId: bigint, offer: OfferTerms, hash: Hex, now: number) {
  const state = await sdk.sidequestState(ctx, jobId)
  const { job, listing, decision, terms } = state
  const status =
    job.statusName === 'Open'
      ? now > terms.deliveryDeadline
        ? 'lapsed'
        : 'open'
      : job.statusName === 'Rejected' && job.provider === zeroAddress
        ? 'cancelled'
        : state.status
  return {
    status,
    coreStatus: job.statusName,
    listingMatchesOffer: matchesSidequest(offer, hash, listing),
    provider: job.provider === zeroAddress ? null : job.provider,
    submittedAt: job.submittedAt === 0 ? null : job.submittedAt,
    timely: job.submittedAt > 0 && job.submittedAt <= terms.deliveryDeadline,
    deliveryDeadline: terms.deliveryDeadline,
    expiredAt: listing.expiredAt,
    reviewEndsAt: state.reviewEndsAt,
    disputeEndsAt: state.disputeEndsAt,
    arbitrationEndsAt: state.arbitrationEndsAt,
    violation: decision.rejectedAt === 0 ? null : (['None', 'Quality', 'Falsified'][decision.violation] ?? null),
    outcome: state.outcome,
    deferredDecision: state.deferredDecision,
    collectPending: state.collectPending,
    feeBps: listing.feeBps,
    fee: listing.fee.toString(),
    net: terms.funded.toString(),
    bonus: listing.bonus.toString(),
    paused: state.paused,
  }
}

export async function settleSidequest(
  ctx: sdk.Ctx,
  jobId: bigint,
  wallet: Address | undefined,
  now: number,
): Promise<sdk.TxRequest[]> {
  const state = await sdk.sidequestState(ctx, jobId)
  const out: sdk.TxRequest[] = []
  const terminal = ['Completed', 'Rejected', 'Expired'].includes(state.job.statusName)
  const settle = () =>
    transaction(
      ctx,
      'Settle the agreed reward, fee, bonus and bonds',
      ctx.stack.holding,
      encodeFunctionData({ abi: sdk.sidequestHoldingAbi, functionName: 'settle', args: [jobId] }),
      sdk.V1_GAS.settle,
    )
  if (!state.paused && state.deferredDecision) out.push(...sdk.deferredCollectTransactions(ctx, jobId))
  else if (terminal && state.collectPending) out.push(settle())
  else if (!terminal && !state.paused) {
    let fn:
      | 'completeAfterSilence'
      | 'rejectAfterWindow'
      | 'refundAfterArbitrationTimeout'
      | 'rejectAfterDeliveryDeadline'
      | undefined
    if (state.status === 'disputed' && state.arbitrationEndsAt !== null && now > state.arbitrationEndsAt)
      fn = 'refundAfterArbitrationTimeout'
    else if (state.status === 'rejected-pending' && state.disputeEndsAt !== null && now > state.disputeEndsAt)
      fn = 'rejectAfterWindow'
    else if (
      state.status === 'submitted' &&
      state.job.submittedAt <= state.terms.deliveryDeadline &&
      state.reviewEndsAt !== null &&
      now > state.reviewEndsAt
    )
      fn = 'completeAfterSilence'
    else if (
      (state.status === 'active' ||
        (state.status === 'submitted' && state.job.submittedAt > state.terms.deliveryDeadline)) &&
      now > state.terms.deliveryDeadline
    )
      fn = 'rejectAfterDeliveryDeadline'
    if (fn !== undefined)
      out.push(
        transaction(
          ctx,
          'Finalize the elapsed window',
          ctx.stack.evaluator,
          encodeFunctionData({ abi: sdk.sidequestEvaluatorAbi, functionName: fn, args: [jobId] }),
          sdk.V1_GAS.evaluator,
        ),
        settle(),
      )
  }
  if (wallet !== undefined) {
    const [owed, topUp] = await Promise.all([
      ctx.publicClient.readContract({
        address: ctx.stack.holding,
        abi: sdk.sidequestHoldingAbi,
        functionName: 'owed',
        args: [state.listing.token, wallet],
      }),
      ctx.publicClient.readContract({
        address: ctx.stack.holding,
        abi: sdk.sidequestHoldingAbi,
        functionName: 'topUpOf',
        args: [jobId, wallet],
      }),
    ])
    if (topUp > 0n && state.listing.outcome === 2) out.push(sdk.topUpRefundTransaction(ctx, jobId, wallet))
    if (owed > 0n)
      out.push(
        transaction(
          ctx,
          'Withdraw your refused token payout',
          ctx.stack.holding,
          encodeFunctionData({ abi: sdk.sidequestHoldingAbi, functionName: 'withdraw', args: [state.listing.token] }),
        ),
      )
  }
  return out
}
