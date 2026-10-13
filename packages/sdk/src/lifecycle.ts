/**
 * One lifecycle model for every surface (Explore, the widget, MCP text): where a job stands, who acts next, by when,
 * and which actions the contracts accept now. It folds the indexer's words (`packages/indexer/src/fold.ts`) and the
 * board's (`packages/board/src/service.ts`, `TaskStatus`) into one set of phases, so a list row and a job page never
 * disagree. Pure: no viem, no React, no clock unless `now` is omitted.
 *
 * Deadlines follow the contracts: an action is allowed at its deadline and refused strictly after it, so a window has
 * passed only when `now > end`. Silence after a timely submission is acceptance, and every timeout is permissionless.
 */

import type { ViolationName } from './actions.ts'

/** The board's status words (`TaskStatus`), the indexer's, and the list's literal for an unpublished offer. */
export type JobStatusWord =
  | 'awaiting-publish'
  | 'awaiting publish'
  | 'draft'
  | 'unknown'
  | 'open'
  | 'lapsed'
  | 'active'
  | 'submitted'
  | 'rejected-pending'
  | 'disputed'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'expired'

/** How a finished job ended, when the caller knows it (from the job's events); the label falls back without it. */
export type JobOutcome =
  | 'accepted'
  | 'silence'
  | 'ruled-worker'
  | 'ruled-creator'
  | 'arbitration-timeout'
  | 'missed'
  | 'rejection-final'

export interface LifecycleInput {
  kind?: 'sidequest-v1' | null
  mode?: 'hire'
  status: JobStatusWord | (string & {})
  deliveryDeadline: number | null
  /** Holding stops bond penalties at this timestamp, including equality. */
  expiredAt?: number | null
  /** Whether the final submission landed by the delivery deadline; unknown from the indexer alone. */
  timely?: boolean | null
  reviewEndsAt?: number | null
  disputeEndsAt?: number | null
  arbitrationEndsAt?: number | null
  violation?: ViolationName | null
  /** The worker's bond in base units; a slash is mentioned only when there is one. */
  workerBond?: bigint | string | null
  outcome?: JobOutcome | null
  /** A terminal job whose reward still sits in Holding (a timeout refunded without `settle`). */
  settlePending?: boolean
  /** The evaluator decided, but the core still needs the recorded decision retried. */
  deferredDecision?: boolean
  /** A terminal reward, fee, bonus, refund or refused push is still available to collect. */
  collectPending?: boolean
  listingMatchesOffer?: boolean | null
  paused?: boolean
  parties: { creator?: string | null; approver?: string | null; worker?: string | null }
}

export type PhaseKey =
  | 'payout-deferred'
  | 'collect'
  | 'draft'
  | 'draft-stale'
  | 'hire-open'
  | 'hire-lapsed'
  | 'active'
  | 'overdue'
  | 'in-review'
  | 'accepted-by-silence'
  | 'delivered-late'
  | 'rejected-pending'
  | 'rejection-final'
  | 'disputed'
  | 'arbitration-lapsed'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'unknown'
  | 'quotes-open'
  | 'quotes-closed'
  | 'quote-picked'

export type Tone = 'neutral' | 'info' | 'attention' | 'success' | 'danger'
export type Role = 'creator' | 'approver' | 'worker'
export type Actor = Role | 'arbitrator' | 'agents' | 'anyone'
export type JobAction = 'publish' | 'select' | 'cancel' | 'approve' | 'reject' | 'pick' | 'settle'
/** The permissionless evaluator or holding call a phase waits for (`settlement_actions` returns it with `settle`). */
export type Timeout =
  | 'completeAfterSilence'
  | 'rejectAfterWindow'
  | 'refundAfterArbitrationTimeout'
  | 'rejectAfterDeliveryDeadline'
  | 'retryDeferred'

/** A sentence as parts, so a surface can render the time as a live countdown; `phaseText` joins it for plain text. */
export type Segment = string | { time: number }

export interface Phase {
  key: PhaseKey
  label: string
  tone: Tone
  /** Who moves the job on next, and the deadline they have. */
  actor: Actor | null
  deadline: number | null
  /** Said to everyone. */
  next: Segment[]
  /** Said to the viewer when they are the one to act (or the one a permissionless step pays); null otherwise. */
  toYou: Segment[] | null
  youAct: boolean
  /** The viewer's roles on this job. */
  roles: Role[]
  /** What the contracts accept from this viewer now. `settle` is anyone's, offered to any viewer. */
  actions: JobAction[]
  timeout: Timeout | null
  /** Whom a permissionless step pays out to. */
  beneficiary: 'creator' | 'worker' | null
  terminal: boolean
  warnings: string[]
}

const eq = (a: string | null | undefined, b: string | null | undefined) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

/** Too close to a deadline for a transaction the viewer must send to be safe. */
export const DEADLINE_MARGIN_SECONDS = 120

export function rolesOf(parties: LifecycleInput['parties'], viewer: string | null | undefined): Role[] {
  if (!viewer) return []
  const roles: Role[] = []
  if (eq(parties.creator, viewer)) roles.push('creator')
  if (eq(parties.approver, viewer)) roles.push('approver')
  if (eq(parties.worker, viewer)) roles.push('worker')
  return roles
}

interface Draft {
  key: PhaseKey
  label: string
  tone: Tone
  actor: Actor | null
  deadline: number | null
  next: Segment[]
  toActor?: Segment[]
  /** Actions by role; `anyone` for permissionless steps. */
  can?: Partial<Record<Role | 'anyone', JobAction[]>>
  timeout?: Timeout
  beneficiary?: 'creator' | 'worker'
  terminal?: boolean
}

function hasBond(bond: LifecycleInput['workerBond']): boolean {
  if (bond === null || bond === undefined) return false
  try {
    return BigInt(bond) > 0n
  } catch {
    return false
  }
}

function draftOf(input: LifecycleInput, now: number): Draft {
  const s = input.status
  const due = input.deliveryDeadline
  const burn = !hasBond(input.workerBond)
    ? ''
    : input.expiredAt != null && now >= input.expiredAt
      ? " and the agent's bond is released because penalties end at expiry"
      : " and the agent's bond is sent to the treasury only if resolved before expiry"
  const penaltyReminder = hasBond(input.workerBond) ? ' Resolve before expiry for the bond penalty to apply.' : ''
  const past = (t: number | null | undefined) => typeof t === 'number' && now > t

  if (s === 'draft' || s === 'awaiting-publish' || s === 'awaiting publish') {
    if (past(due)) {
      return {
        key: 'draft-stale',
        label: 'Draft · deadline passed',
        tone: 'neutral',
        actor: 'creator',
        deadline: null,
        next: ['Its deadline passed before it was published. Nothing was locked.'],
        toActor: ['Its deadline passed before you published it. Post it again with new dates.'],
      }
    }
    return {
      key: 'draft',
      label: 'Draft · not funded',
      tone: 'neutral',
      actor: 'creator',
      deadline: due,
      next: ["Not published yet: nothing is locked and agents can't see it."],
      toActor: ['Publish it to lock the reward in escrow.'],
      can: { creator: ['publish'] },
    }
  }

  if (s === 'unknown') {
    return {
      key: 'unknown',
      label: 'Indexing…',
      tone: 'neutral',
      actor: null,
      deadline: null,
      next: ['Chain facts appear about a minute after the block is final.'],
    }
  }

  if (input.deferredDecision || input.collectPending) {
    const workerEarned = input.outcome === 'accepted' || input.outcome === 'silence' || input.outcome === 'ruled-worker'
    return {
      key: input.deferredDecision ? 'payout-deferred' : 'collect',
      label: input.deferredDecision ? 'Decision recorded · payment deferred' : 'Ready to collect',
      tone: 'attention',
      actor: 'anyone',
      deadline: null,
      beneficiary: workerEarned ? 'worker' : 'creator',
      next: input.deferredDecision
        ? [
            'The decision is final. Anyone can retry the deferred core call and settle the Holding; the agreed payee stays the same.',
          ]
        : ['The job is decided. Collect the remaining settlement, refund or refused payout.'],
      can: { anyone: ['settle'] },
      terminal: true,
      ...(input.deferredDecision ? { timeout: 'retryDeferred' as const } : {}),
    }
  }

  if (s === 'open' || s === 'lapsed') {
    if (s === 'lapsed' || past(due)) {
      return {
        key: 'hire-lapsed',
        label: 'Not started · deadline passed',
        tone: 'attention',
        actor: 'creator',
        deadline: null,
        next: ['Nobody started before the deadline. The creator can cancel to get the reward and bond back.'],
        toActor: ['Nobody started in time. Cancel to get the reward and your bond back.'],
        can: { creator: ['cancel'] },
        beneficiary: 'creator',
      }
    }
    return {
      key: 'hire-open',
      label: 'Open · hiring',
      tone: 'info',
      actor: 'creator',
      deadline: due,
      next: ['Agents apply. It starts when the selected agent activates it and posts its bond.'],
      toActor: ['Select an agent from the applications. Selecting is a signature, not a transaction.'],
      can: { creator: ['select', 'cancel'] },
    }
  }

  if (s === 'active') {
    if (past(due)) {
      return {
        key: 'overdue',
        label: 'Missed deadline',
        tone: 'danger',
        actor: 'anyone',
        deadline: null,
        next: [
          'Nothing was delivered by ',
          { time: due as number },
          `. Anyone can close it: the reward goes back to the creator${burn}.`,
        ],
        toActor: [`Nothing was delivered in time. Close it to get the reward back.${penaltyReminder}`],
        can: { anyone: ['settle'] },
        timeout: 'rejectAfterDeliveryDeadline',
        beneficiary: 'creator',
      }
    }
    return {
      key: 'active',
      label: 'In progress',
      tone: 'info',
      actor: 'worker',
      deadline: due,
      next: due === null ? ['The agent is working on it.'] : ['The agent is working on it, due ', { time: due }, '.'],
      toActor: due === null ? ['Deliver the work.'] : ['Deliver by ', { time: due }, '.'],
    }
  }

  if (s === 'submitted') {
    if (input.timely === false) {
      return {
        key: 'delivered-late',
        label: 'Delivered late',
        tone: 'attention',
        actor: 'approver',
        deadline: null,
        next: [
          `It arrived after the deadline. The approver may still accept it; until then anyone can end it as missed, refunding the creator${burn}.`,
        ],
        toActor: [`It arrived after the deadline. Accept it anyway, or let it close as missed.${penaltyReminder}`],
        can: { approver: ['approve'], anyone: ['settle'] },
        timeout: 'rejectAfterDeliveryDeadline',
        beneficiary: 'creator',
      }
    }
    const end = input.reviewEndsAt ?? null
    if (past(end)) {
      return {
        key: 'accepted-by-silence',
        label: 'Accepted · payment ready',
        tone: 'success',
        actor: 'anyone',
        deadline: null,
        next: [
          'The review window closed without a decision, so the work is accepted. Anyone can release the payment to the agent.',
        ],
        toActor: ['The review window closed without a decision: the work is accepted. Release the payment.'],
        can: { approver: ['approve'], anyone: ['settle'] },
        timeout: 'completeAfterSilence',
        beneficiary: 'worker',
      }
    }
    return {
      key: 'in-review',
      label: 'In review',
      tone: 'attention',
      actor: 'approver',
      deadline: end,
      next:
        end === null
          ? ['The approver can approve or reject it. No answer within the review window counts as acceptance.']
          : [
              'The approver can approve or reject it until ',
              { time: end },
              '. No answer by then counts as acceptance, and anyone can release the payment.',
            ],
      toActor:
        end === null
          ? ['Approve or reject it. If you do nothing within the review window, the work is accepted and paid.']
          : ['Approve or reject by ', { time: end }, '. If you do nothing, the work is accepted and paid.'],
      can: { approver: ['approve', 'reject'] },
    }
  }

  if (s === 'rejected-pending') {
    const end = input.disputeEndsAt ?? null
    const why =
      input.violation === 'Quality'
        ? ' as not good enough'
        : input.violation === 'Falsified'
          ? ' for faked evidence'
          : ''
    const stake = input.violation === 'Quality' || input.violation === 'Falsified' ? burn : ''
    if (past(end)) {
      return {
        key: 'rejection-final',
        label: 'Rejection stands',
        tone: 'danger',
        actor: 'anyone',
        deadline: null,
        next: [`Rejected${why} and not disputed. Anyone can finalize it: the reward goes back to the creator${stake}.`],
        toActor: [
          `The dispute window closed. Finalize the rejection to get the reward back.${stake ? penaltyReminder : ''}`,
        ],
        can: { approver: ['approve'], anyone: ['settle'] },
        timeout: 'rejectAfterWindow',
        beneficiary: 'creator',
      }
    }
    return {
      key: 'rejected-pending',
      label: 'Rejected · can be disputed',
      tone: 'attention',
      actor: 'worker',
      deadline: end,
      next:
        end === null
          ? [
              `Rejected${why}. The agent can dispute it; nothing moves before the dispute window ends, and the approver can still approve instead.`,
            ]
          : [
              `Rejected${why}. The agent can dispute until `,
              { time: end },
              '. Nothing moves before then, and the approver can still approve instead.',
            ],
      toActor:
        end === null
          ? ['Dispute it if the work meets the criteria.']
          : ['Dispute by ', { time: end }, ' if the work meets the criteria.'],
      can: { approver: ['approve'] },
    }
  }

  if (s === 'disputed') {
    const end = input.arbitrationEndsAt ?? null
    if (past(end)) {
      return {
        key: 'arbitration-lapsed',
        label: 'Arbitrator timed out',
        tone: 'attention',
        actor: 'anyone',
        deadline: null,
        next: [
          'No ruling arrived in time. Anyone can refund the creator; both bonds come back and the agent gets no rating.',
        ],
        toActor: ['No ruling arrived in time. Close it to refund the creator and return both bonds.'],
        can: { anyone: ['settle'] },
        timeout: 'refundAfterArbitrationTimeout',
        beneficiary: 'creator',
      }
    }
    return {
      key: 'disputed',
      label: 'In arbitration',
      tone: 'attention',
      actor: 'arbitrator',
      deadline: end,
      next:
        end === null
          ? [
              "The arbitrator rules on the dispute. If they don't in time, anyone can refund the creator and return both bonds.",
            ]
          : [
              'The arbitrator rules by ',
              { time: end },
              ". If they don't, anyone can refund the creator and return both bonds.",
            ],
    }
  }

  // A refused core payout may finish as Rejected/Expired while the worker's recorded payment right stays final.
  if (
    ['completed', 'rejected', 'expired'].includes(s) &&
    ['accepted', 'silence', 'ruled-worker'].includes(input.outcome ?? '')
  ) {
    return {
      key: 'completed',
      label: 'Paid',
      tone: 'success',
      actor: null,
      deadline: null,
      next: ['The work was accepted; the worker payment is settled.'],
      terminal: true,
      beneficiary: 'worker',
    }
  }

  const settle: Pick<Draft, 'can' | 'beneficiary'> = input.settlePending
    ? { can: { anyone: ['settle'] }, beneficiary: 'creator' }
    : {}
  const pending = input.settlePending ? ' It is still in escrow: anyone can release it.' : ''

  if (s === 'completed') {
    const how =
      input.outcome === 'silence'
        ? 'Accepted when the review window closed without a decision; the reward is paid.'
        : input.outcome === 'ruled-worker'
          ? 'The arbitrator ruled for the agent; the reward is paid.'
          : 'Approved; the reward is paid and the bonds returned.'
    return {
      key: 'completed',
      label: 'Paid',
      tone: 'success',
      actor: null,
      deadline: null,
      next: [how],
      terminal: true,
    }
  }

  if (s === 'rejected') {
    const [label, tone, why]: [string, Tone, string] =
      input.outcome === 'missed'
        ? ['Not delivered', 'danger', 'Nothing timely was delivered; the reward went back to the creator.']
        : input.outcome === 'ruled-creator'
          ? [
              'Ruled for the creator',
              'danger',
              'The arbitrator upheld the rejection; the reward went back to the creator.',
            ]
          : input.outcome === 'arbitration-timeout'
            ? [
                'Refunded · arbitrator timed out',
                'neutral',
                'No ruling arrived in time; the creator was refunded and both bonds returned.',
              ]
            : ['Rejected · refunded', 'danger', 'The reward went back to the creator.']
    return {
      key: 'rejected',
      label,
      tone,
      actor: input.settlePending ? 'anyone' : null,
      deadline: null,
      next: [why + pending],
      terminal: true,
      ...settle,
    }
  }

  if (s === 'cancelled') {
    return {
      key: 'cancelled',
      label: 'Cancelled',
      tone: 'neutral',
      actor: input.settlePending ? 'anyone' : null,
      deadline: null,
      next: ['Cancelled before anyone started; the reward and bond went back to the creator.' + pending],
      terminal: true,
      ...settle,
    }
  }
  if (s === 'expired') {
    return {
      key: 'expired',
      label: 'Expired · refunded',
      tone: 'neutral',
      actor: input.settlePending ? 'anyone' : null,
      deadline: null,
      next: ['The job expired; the creator was refunded.' + pending],
      terminal: true,
      ...settle,
    }
  }
  return {
    key: 'unknown',
    label: 'Unknown',
    tone: 'neutral',
    actor: null,
    deadline: null,
    next: [`Status "${s}" is not one this app knows.`],
  }
}

/** Where a job stands for `viewer` (an address, or nothing for a visitor) at `now` (unix seconds). */
export function lifecycle(
  input: LifecycleInput,
  viewer?: string | null,
  now: number = Math.floor(Date.now() / 1000),
): Phase {
  const d = draftOf(input, now)
  const roles = rolesOf(input.parties, viewer)
  const warnings: string[] = []
  let actions: JobAction[] = [
    ...new Set([...roles.flatMap((r) => d.can?.[r] ?? []), ...(viewer ? (d.can?.anyone ?? []) : [])]),
  ]

  // The one who moves the job on, or the one a permissionless step pays.
  const youAct =
    roles.includes(d.actor as Role) ||
    (d.actor === 'anyone' && d.beneficiary !== undefined && roles.includes(d.beneficiary))

  if (input.listingMatchesOffer === false) {
    warnings.push("The on-chain listing doesn't match this offer. Don't act on it.")
    actions = []
  }
  if (input.paused) {
    warnings.push(
      'Paused by the admin. A delivery deadline inside a recorded core pause does not slash the worker bond.',
    )
    if (d.key !== 'collect') actions = []
  }
  if (youAct && d.deadline !== null && d.deadline >= now && d.deadline - now < DEADLINE_MARGIN_SECONDS) {
    warnings.push('Less than two minutes left: a transaction sent now may land too late.')
  }

  return {
    key: d.key,
    label: d.label,
    tone: d.tone,
    actor: d.actor,
    deadline: d.deadline,
    next: d.next,
    toYou: youAct ? (d.toActor ?? d.next) : null,
    youAct,
    roles,
    actions,
    timeout: d.timeout ?? null,
    beneficiary: d.beneficiary ?? null,
    terminal: d.terminal ?? false,
    warnings,
  }
}

export interface QuoteRequestInput {
  quoteDeadline: number
  quotes: number
  picked: boolean
  creator: string
}

/** A quote request before any job exists: nothing is escrowed until a quote is picked. */
export function quoteRequestPhase(
  input: QuoteRequestInput,
  viewer?: string | null,
  now: number = Math.floor(Date.now() / 1000),
): Phase {
  const roles: Role[] = eq(input.creator, viewer) ? ['creator'] : []
  const mine = roles.length > 0
  const n = `${input.quotes} quote${input.quotes === 1 ? '' : 's'}`
  const base = { roles, timeout: null, beneficiary: null, warnings: [] as string[] }
  if (input.picked) {
    return {
      ...base,
      key: 'quote-picked',
      label: 'Quote picked',
      tone: 'success',
      actor: null,
      deadline: null,
      next: ['A quote was picked and published as a hire.'],
      toYou: null,
      youAct: false,
      actions: [],
      terminal: true,
    }
  }
  if (now > input.quoteDeadline) {
    // pick_quote has no deadline of its own: the creator can still pick after quoting closes.
    return {
      ...base,
      key: 'quotes-closed',
      label: 'Quotes closed',
      tone: mine ? 'attention' : 'neutral',
      actor: 'creator',
      deadline: null,
      next: [`Quoting has closed with ${n}. The creator can still pick one.`],
      toYou: mine ? [`Quoting has closed with ${n}. Pick one to publish it, or let it lapse.`] : null,
      youAct: mine && input.quotes > 0,
      actions: mine && input.quotes > 0 ? ['pick'] : [],
      terminal: false,
    }
  }
  return {
    ...base,
    key: 'quotes-open',
    label: 'Taking quotes',
    tone: 'info',
    actor: 'agents',
    deadline: input.quoteDeadline,
    next: [
      'Agents send private quotes until ',
      { time: input.quoteDeadline },
      '. Nothing is escrowed until one is picked.',
    ],
    toYou: mine && input.quotes > 0 ? [`${n} in. Pick one to publish it as a hire at that price.`] : null,
    youAct: mine && input.quotes > 0,
    actions: mine && input.quotes > 0 ? ['pick'] : [],
    terminal: false,
  }
}

/** A phase sentence as plain text, with times formatted by `time` (ISO 8601 UTC by default). */
export function phaseText(
  parts: Segment[],
  time: (t: number) => string = (t) => new Date(t * 1000).toISOString(),
): string {
  return parts.map((p) => (typeof p === 'string' ? p : time(p.time))).join('')
}

/** A row of the indexer's `jobs` table (Explore's `/data/jobs`), as lifecycle input. */
export function lifecycleFromIndexed(row: {
  kind?: 'sidequest-v1' | null
  mode?: string | null
  status: string
  creator: string | null
  approver: string | null
  worker: string | null
  delivery_deadline: number | null
  expired_at?: number | null
  worker_bond: string | null
  violation?: string | null
  outcome?: string | null
  settlement_outcome?: string | null
  payout_deferred?: number | null
  refund_deferred?: number | null
  submitted_at?: number | null
  review_window?: number | null
  rejected_at?: number | null
  disputed_at?: number | null
  dispute_window?: number | null
  arbitration_window?: number | null
}): LifecycleInput {
  const decided = row.outcome !== undefined && row.outcome !== null && row.outcome !== 'None'
  const terminal = ['completed', 'rejected', 'cancelled', 'expired'].includes(row.status)
  return {
    kind: row.kind ?? 'sidequest-v1',
    mode: 'hire',
    status: row.status,
    deliveryDeadline: row.delivery_deadline,
    expiredAt: row.expired_at ?? null,
    violation: (row.violation ?? null) as ViolationName | null,
    workerBond: row.worker_bond,
    outcome: protocolOutcome(row.outcome),
    deferredDecision: decided && !terminal && (row.payout_deferred === 1 || row.refund_deferred === 1),
    collectPending: terminal && row.settlement_outcome === 'None',
    reviewEndsAt: row.submitted_at != null && row.review_window != null ? row.submitted_at + row.review_window : null,
    disputeEndsAt: row.rejected_at != null && row.dispute_window != null ? row.rejected_at + row.dispute_window : null,
    arbitrationEndsAt:
      row.disputed_at != null && row.arbitration_window != null ? row.disputed_at + row.arbitration_window : null,
    parties: { creator: row.creator, approver: row.approver, worker: row.worker },
  }
}

/** The board's `get_task` result (its summary and `chain` view), as lifecycle input. */
export function lifecycleFromTask(task: {
  kind?: 'sidequest-v1' | null
  mode?: string
  creator: string
  approver: string
  deliveryDeadline: number
  workerBond: string
  chain: {
    status: string
    expiredAt?: number | null
    provider: string | null
    timely: boolean
    submittedAt: number | null
    reviewEndsAt: number | null
    disputeEndsAt: number | null
    arbitrationEndsAt: number | null
    violation: string | null
    listingMatchesOffer: boolean | null
    paused?: boolean
    outcome?: string | null
    deferredDecision?: boolean
    collectPending?: boolean
  }
}): LifecycleInput {
  const c = task.chain
  return {
    kind: task.kind ?? 'sidequest-v1',
    mode: 'hire',
    status: c.status,
    deliveryDeadline: task.deliveryDeadline,
    expiredAt: c.expiredAt ?? null,
    timely: c.submittedAt === null ? null : c.timely,
    reviewEndsAt: c.reviewEndsAt,
    disputeEndsAt: c.disputeEndsAt,
    arbitrationEndsAt: c.arbitrationEndsAt,
    violation: (c.violation ?? null) as ViolationName | null,
    workerBond: task.workerBond,
    listingMatchesOffer: c.listingMatchesOffer,
    paused: c.paused ?? false,
    outcome: protocolOutcome(c.outcome),
    deferredDecision: c.deferredDecision ?? false,
    collectPending: c.collectPending ?? false,
    parties: { creator: task.creator, approver: task.approver, worker: c.provider },
  }
}

function protocolOutcome(value: string | null | undefined): JobOutcome | null {
  const outcomes: Record<string, JobOutcome> = {
    Accepted: 'accepted',
    Silence: 'silence',
    RuledForWorker: 'ruled-worker',
    RuledForCreator: 'ruled-creator',
    ArbitrationTimeout: 'arbitration-timeout',
    DeliveryMissed: 'missed',
    RejectionFinal: 'rejection-final',
  }
  return value === undefined || value === null ? null : (outcomes[value] ?? null)
}
