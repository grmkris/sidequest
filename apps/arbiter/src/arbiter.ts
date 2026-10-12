/**
 * One arbiter pass (plan B2.4): hold the lease, then for every open dispute on the board without a decision, read
 * the bundle, let the model propose, and sign only what the deterministic gate allows. The board records the
 * decision per dispute and prepares the signed ruling; the arbitrator pays MON to send it; the harness sends a locally rebuilt cancellation on a v1 retry
 * from the arbitrator wallet, and never signs a message it did not rebuild itself: the Ruling it signs uses the evaluator domain from the SDK deployment, the
 * job from the bundle and exactly the validated proposal.
 */
import { type DisputeBundle, type DisputeThread, checkRulingRequest, validateProposal } from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import { type Hex, type LocalAccount, encodeFunctionData } from 'viem'
import type { RulingSend } from './ruling-journal.ts'
import type { RulingResult } from './runtime.ts'

export interface BoardLike {
  call<T = any>(tool: string, args?: Record<string, unknown>): Promise<T>
}

export interface ArbiterDeps {
  readonly sendRuling?: (intended: RulingSend) => Promise<RulingResult>
  readonly resumeRuling?: (taskId: string) => Promise<RulingResult | undefined>
  readonly board: BoardLike
  readonly account: LocalAccount
  readonly network: sdk.Network
  readonly runner: string
  /** The model's proposal for a bundle; anything it returns goes through `validateProposal`. */
  readonly propose: (bundle: DisputeBundle, thread: DisputeThread) => Promise<unknown>
  readonly now?: () => number
  readonly log?: (message: string) => void
  readonly leaseSeconds?: number
  /** Recorded with a new decision (R114-08). */
  readonly model?: string
  readonly promptVersion?: string
  /** Only sends a locally rebuilt cancelRuling call from this arbitrator's own wallet. */
  readonly sendCancellation?: (transaction: sdk.TxRequest) => Promise<void>
}

export type Outcome =
  | {
      readonly taskId: string
      readonly result: 'ruled'
      readonly forWorker: boolean
      readonly slashLoser: boolean
      readonly txHash: string | null
    }
  | { readonly taskId: string; readonly result: 'skipped'; readonly why: string }

interface DisputeRow {
  taskId: string
  stack: string
  arbitrationEndsAt: number
  decision: { forWorker: boolean; slashLoser: boolean; reason: string | null; txHash: string | null } | null
}

export async function arbitrateOnce(deps: ArbiterDeps): Promise<{ lease: boolean; outcomes: Outcome[] }> {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  const lease = await deps.board.call<{ held: boolean; holder: string | null }>('arbiter_lease', {
    runner: deps.runner,
    ttlSeconds: deps.leaseSeconds ?? 300,
  })
  if (!lease.held) {
    log(`lease held by ${lease.holder}; idle`)
    return { lease: false, outcomes: [] }
  }
  const outcomes: Outcome[] = []
  for (const d of await deps.board.call<DisputeRow[]>('list_disputes')) {
    if (d.decision?.txHash != null) continue
    try {
      outcomes.push(await decide(deps, d, now, log))
    } catch (e) {
      outcomes.push({ taskId: d.taskId, result: 'skipped', why: (e as Error).message })
    }
  }
  for (const o of outcomes)
    log(
      o.result === 'ruled'
        ? `${o.taskId}: ruled forWorker=${o.forWorker} slashLoser=${o.slashLoser} ${o.txHash ?? ''}`
        : `${o.taskId}: skipped (${o.why})`,
    )
  return { lease: true, outcomes }
}

async function decide(deps: ArbiterDeps, d: DisputeRow, now: () => number, log: (m: string) => void): Promise<Outcome> {
  const resumed = await deps.resumeRuling?.(d.taskId)
  if (resumed !== undefined && d.decision !== null) {
    if (resumed.txHash !== null)
      await deps.board.call('report_transaction', { taskId: d.taskId, txHash: resumed.txHash })
    return {
      taskId: d.taskId,
      result: 'ruled',
      forWorker: d.decision.forWorker,
      slashLoser: d.decision.slashLoser,
      txHash: resumed.txHash,
    }
  }
  if (now() >= d.arbitrationEndsAt) return { taskId: d.taskId, result: 'skipped', why: 'the window has closed' }
  const {
    bundle,
    bundleHash,
    thread = [],
  } = await deps.board.call<{ bundle: DisputeBundle; bundleHash: Hex; thread?: DisputeThread }>('get_dispute_bundle', {
    taskId: d.taskId,
  })
  // The evaluator must be the configured v1 pair on this network.
  const stack = sdk
    .allStacks(sdk.deployment(deps.network))
    .find(([, s]) => s.evaluator.toLowerCase() === bundle.evaluator.toLowerCase())?.[1]
  const chainId = sdk.deployment(deps.network).chainId
  if (stack === undefined || bundle.chainId !== chainId) {
    return { taskId: d.taskId, result: 'skipped', why: 'the bundle names another chain or evaluator' }
  }
  if (bundle.arbitrator.toLowerCase() !== deps.account.address.toLowerCase()) {
    return { taskId: d.taskId, result: 'skipped', why: 'not this key’s dispute' }
  }

  // A decision already recorded for this dispute (by this runner before a crash, or by another harness) is final:
  // re-use it and never ask the model again (R114-08). It still passes the same deterministic gate.
  const recorded = d.decision
  if (recorded !== null && (await cancelRecordedRuling(deps, d.taskId, chainId, stack.evaluator)))
    return { taskId: d.taskId, result: 'skipped', why: 'the dispute is already resolved on-chain' }

  const raw =
    recorded !== null && recorded.reason !== null
      ? { forWorker: recorded.forWorker, slashLoser: recorded.slashLoser, reason: recorded.reason }
      : await deps.propose(bundle, thread)
  const checked = validateProposal(bundle, raw)
  if (!checked.ok) return { taskId: d.taskId, result: 'skipped', why: `proposal refused: ${checked.error}` }
  const proposal = checked.proposal
  log(
    `${d.taskId}: ${recorded === null ? 'proposal' : 're-using the recorded decision'} forWorker=${proposal.forWorker} slashLoser=${proposal.slashLoser}`,
  )

  const prepared = await deps.board.call<{ sign: { typedData: string } }>('prepare_ruling', {
    taskId: d.taskId,
    forWorker: proposal.forWorker,
    slashLoser: proposal.slashLoser,
    reason: proposal.reason,
    bundleHash,
    runner: deps.runner,
    ...(deps.model === undefined ? {} : { model: deps.model }),
    ...(deps.promptVersion === undefined ? {} : { promptVersion: deps.promptVersion }),
  })
  const request = checkRulingRequest(bundle, proposal, prepared.sign.typedData, {
    chainId,
    evaluator: stack.evaluator,
    now: now(),
  })
  if (!request.ok) return { taskId: d.taskId, result: 'skipped', why: `ruling request refused: ${request.error}` }
  const signature = await deps.account.signTypedData({
    domain: sdk.evaluatorDomain(chainId, stack.evaluator),
    types: sdk.rulingTypes,
    primaryType: 'Ruling',
    message: request.ruling,
  })
  const sent = await submitAndSendRuling(deps, d.taskId, {
    chainId,
    evaluator: stack.evaluator,
    ruling: request.ruling,
    signature,
  })

  return {
    taskId: d.taskId,
    result: 'ruled',
    forWorker: proposal.forWorker,
    slashLoser: proposal.slashLoser,
    txHash: sent.txHash,
  }
}

async function cancelRecordedRuling(
  deps: ArbiterDeps,
  taskId: string,
  chainId: number,
  evaluator: Hex,
): Promise<boolean> {
  const cancellation = await deps.board.call<{
    resolved: boolean
    nonce: string | null
    transactions: sdk.TxRequest[]
  }>('cancel_ruling', { taskId: taskId })
  if (cancellation.resolved) return true
  if (cancellation.transactions.length > 0) {
    if (cancellation.nonce === null || !/^\d+$/.test(cancellation.nonce) || BigInt(cancellation.nonce) >= 2n ** 256n) {
      throw new Error('invalid ruling cancellation nonce')
    }
    const transaction: sdk.TxRequest = {
      description: 'Cancel the previous ruling authorization',
      chainId,
      to: evaluator,
      value: '0',
      data: encodeFunctionData({
        abi: sdk.sidequestEvaluatorAbi,
        functionName: 'cancelRuling',
        args: [BigInt(cancellation.nonce)],
      }),
    }
    const offered = cancellation.transactions[0]!
    if (
      cancellation.transactions.length !== 1 ||
      offered.chainId !== chainId ||
      offered.to.toLowerCase() !== evaluator.toLowerCase() ||
      offered.data !== transaction.data ||
      offered.value !== '0'
    ) {
      throw new Error('ruling cancellation request refused')
    }
    if (!deps.sendCancellation) throw new Error('ruling cancellation needs the arbitrator wallet')
    await deps.sendCancellation(transaction)
  }
  return false
}

async function submitAndSendRuling(
  deps: ArbiterDeps,
  taskId: string,
  prepared: { chainId: number; evaluator: Hex; ruling: sdk.Ruling; signature: Hex },
): Promise<RulingResult> {
  const { chainId, evaluator, ruling, signature } = prepared
  const submitted = await deps.board.call<{
    txHash: Hex | null
    landed: boolean
    nonce: string
    transactions: sdk.TxRequest[]
    relayed?: boolean
  }>('submit_ruling', {
    taskId: taskId,
    signature,
  })
  // A board from before ADR-0023 (prod until it is promoted) relays the ruling itself and answers with its hash.
  if (submitted.relayed === true) return { txHash: submitted.txHash ?? null }
  const transaction: sdk.TxRequest = {
    description: 'Send the signed ruling',
    chainId,
    to: evaluator,
    value: '0',
    data: encodeFunctionData({
      abi: sdk.sidequestEvaluatorAbi,
      functionName: 'ruleWithSignature',
      args: [ruling, signature],
    }),
  }
  const offered = submitted.transactions[0]
  if (
    submitted.nonce !== ruling.nonce.toString() ||
    submitted.transactions.length !== 1 ||
    offered === undefined ||
    offered.chainId !== chainId ||
    offered.to.toLowerCase() !== transaction.to.toLowerCase() ||
    offered.value !== '0' ||
    offered.data !== transaction.data
  )
    throw new Error('ruling transaction request refused')
  if (!submitted.landed && deps.sendRuling === undefined) throw new Error('ruling needs the funded arbitrator wallet')
  const sent = submitted.landed
    ? { txHash: submitted.txHash }
    : await deps.sendRuling!({
        taskId: taskId,
        nonce: submitted.nonce,
        // The evaluator pushes payouts and reverts with TransferGasTooLow below its reserve, which an estimate misses.
        transaction: { ...transaction, value: '0', gas: sdk.V1_GAS.evaluator.toString() },
      })
  if (sent.txHash !== null) await deps.board.call('report_transaction', { taskId: taskId, txHash: sent.txHash })

  return sent
}
