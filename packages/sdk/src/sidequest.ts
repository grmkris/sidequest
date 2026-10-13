/** Sidequest readers and unsigned collect steps shared by hosted services and wallet clients. */
import { parseEventLogs, encodeFunctionData, type Address, type TransactionReceipt } from 'viem'
import { coreAbi, sidequestEvaluatorAbi, sidequestHoldingAbi } from './abi/index.ts'
import { caseOf, getJob, getV1Listing, termsOf, V1_GAS, type Ctx } from './actions.ts'
import type { TxRequest } from './board-client.ts'
import type { LifecycleInput } from './lifecycle.ts'

export const SidequestOutcome = [
  'None',
  'Accepted',
  'Silence',
  'RuledForWorker',
  'RuledForCreator',
  'RejectionFinal',
  'ArbitrationTimeout',
  'DeliveryMissed',
] as const

/** The evaluator records a finding; only Holding's actual bond event proves release or slash to the vault's recipient. */
export function bondSettlementEvent(
  receipts: readonly TransactionReceipt[],
  holding: Address,
  jobId: bigint,
  side: 0 | 1,
) {
  const matches = receipts.flatMap((receipt) => {
    if (receipt.status !== 'success') throw new Error('Bond settlement receipt must be successful')
    return parseEventLogs({
      abi: sidequestHoldingAbi,
      eventName: ['BondReleased', 'BondSlashed'],
      logs: receipt.logs.filter((log) => log.address.toLowerCase() === holding.toLowerCase()),
      strict: true,
    })
      .filter((event) => event.args.jobId === jobId && event.args.side === side)
      .map((event) => ({ burned: event.eventName === 'BondSlashed', receipt }))
  })
  if (matches.length > 1) throw new Error('Multiple bond settlement events for one job and side')
  return matches[0] ?? null
}

/** Reconcile original settlement time on resume, including a penalty resolved exactly at expiry. */
export async function bondBurnExpectation(
  ctx: Ctx,
  receipts: readonly TransactionReceipt[],
  jobId: bigint,
  finding: { side: 0 | 1; penalty: boolean; expiredAt: number },
): Promise<boolean> {
  const event = bondSettlementEvent(receipts, ctx.stack.holding, jobId, finding.side)
  if (event === null) throw new Error('Missing bond settlement event')
  const block = await ctx.publicClient.getBlock({ blockHash: event.receipt.blockHash })
  const expected = finding.penalty && block.timestamp < BigInt(finding.expiredAt)
  if (event.burned !== expected) throw new Error('Bond event disagrees with settlement time and penalty finding')
  return event.burned
}

export function deferredCollectTransactions(ctx: Ctx, jobId: bigint): TxRequest[] {
  if (ctx.stack.kind !== 'sidequest-v1') throw new Error('Deferred collection requires sidequest-v1')
  return [
    {
      description: 'Retry the recorded decision',
      chainId: ctx.deployment.chainId,
      to: ctx.stack.evaluator,
      value: '0',
      gas: V1_GAS.retryDeferred.toString(),
      data: encodeFunctionData({ abi: sidequestEvaluatorAbi, functionName: 'retryDeferred', args: [jobId] }),
    },
    {
      description: 'Settle the Holding',
      chainId: ctx.deployment.chainId,
      to: ctx.stack.holding,
      value: '0',
      gas: V1_GAS.settle.toString(),
      data: encodeFunctionData({ abi: sidequestHoldingAbi, functionName: 'settle', args: [jobId] }),
    },
  ]
}

/** Per-job terms and evaluator windows are chain facts. */
export async function sidequestState(ctx: Ctx, jobId: bigint) {
  const [job, listing, terms, decision, paused] = await Promise.all([
    getJob(ctx, jobId),
    getV1Listing(ctx, jobId),
    termsOf(ctx, jobId),
    caseOf(ctx, jobId),
    ctx.publicClient.readContract({ address: ctx.deployment.core, abi: coreAbi, functionName: 'paused' }),
  ])
  const outcome = SidequestOutcome[decision.outcome] ?? 'None'
  const terminal = ['Completed', 'Rejected', 'Expired'].includes(job.statusName)
  const deferredDecision = !terminal && outcome !== 'None'
  const collectPending =
    terminal &&
    (!listing.rewardSettled ||
      !listing.creatorBondSettled ||
      (listing.workerBondReserved && !listing.workerBondSettled))
  const status =
    job.statusName === 'Open'
      ? 'open'
      : job.statusName === 'Funded'
        ? 'active'
        : job.statusName === 'Submitted'
          ? decision.disputedAt > 0
            ? 'disputed'
            : decision.rejectedAt > 0
              ? 'rejected-pending'
              : 'submitted'
          : job.statusName.toLowerCase()
  return {
    job,
    listing,
    terms,
    decision,
    outcome,
    status,
    paused,
    deferredDecision,
    collectPending,
    reviewEndsAt: job.submittedAt === 0 ? null : job.submittedAt + terms.reviewWindow,
    disputeEndsAt: decision.rejectedAt === 0 ? null : decision.rejectedAt + terms.disputeWindow,
    arbitrationEndsAt: decision.disputedAt === 0 ? null : decision.disputedAt + terms.arbitrationWindow,
  }
}

export async function sidequestLifecycle(ctx: Ctx, jobId: bigint): Promise<LifecycleInput> {
  const state = await sidequestState(ctx, jobId)
  const { job, listing, terms, decision, outcome } = state
  const normalized = {
    Accepted: 'accepted',
    Silence: 'silence',
    RuledForWorker: 'ruled-worker',
    RuledForCreator: 'ruled-creator',
    RejectionFinal: 'rejection-final',
    ArbitrationTimeout: 'arbitration-timeout',
    DeliveryMissed: 'missed',
  } as const
  return {
    kind: 'sidequest-v1',
    mode: 'hire',
    status: state.status,
    deliveryDeadline: terms.deliveryDeadline,
    expiredAt: listing.expiredAt,
    workerBond: listing.workerBond,
    outcome: outcome === 'None' ? null : normalized[outcome],
    timely: job.submittedAt === 0 ? null : job.submittedAt <= terms.deliveryDeadline,
    reviewEndsAt: state.reviewEndsAt,
    disputeEndsAt: state.disputeEndsAt,
    arbitrationEndsAt: state.arbitrationEndsAt,
    violation: (['None', 'Quality', 'Falsified'] as const)[decision.violation] ?? null,
    deferredDecision: state.deferredDecision,
    collectPending: state.collectPending,
    paused: state.paused,
    parties: { creator: listing.creator, approver: listing.approver, worker: listing.worker },
  }
}

export function topUpRefundTransaction(ctx: Ctx, jobId: bigint, contributor: Address): TxRequest {
  if (ctx.stack.kind !== 'sidequest-v1') throw new Error('Top-up refunds require sidequest-v1')
  return {
    description: 'Collect your top-up refund',
    chainId: ctx.deployment.chainId,
    to: ctx.stack.holding,
    value: '0',
    gas: V1_GAS.claimTopUpRefund.toString(),
    data: encodeFunctionData({
      abi: sidequestHoldingAbi,
      functionName: 'claimTopUpRefund',
      args: [jobId, contributor],
    }),
  }
}
