import { cn } from '../../lib/cn.ts'
import { TxLink } from '../kit.tsx'
/**
 * A job's story as steps: what happened on-chain (from the indexer's timeline, with block times and transactions)
 * and what comes next (from the shared lifecycle model, with its deadline). Protocol bookkeeping events are folded
 * away; what remains is what a person would tell another: posted, started, delivered, approved, paid.
 */
import type { Phase } from '@sidequest/react'
import { AlertTriangle, Check, X } from 'lucide-react'
import { type Hex, hexToString } from 'viem'
import { amount, bond } from '../../format.ts'
import { Sentence } from '../Phase.tsx'
import { When } from '../Time.tsx'

export interface TimelineEvent {
  name: string
  block: number
  logIndex: number
  txHash: string
  args: Record<string, string | number | boolean>
  at: number | null
}

type Mark = 'done' | 'now' | 'warn' | 'fail' | 'next'
interface Step {
  mark: Mark
  title: string
  sub?: string | undefined
  at?: number | null
  tx?: string
}

const VIOLATION = ['for no named fault', 'as not good enough', 'for faked evidence']
/** Holding's `Side`: whose bond. */
const SIDE = ["The creator's", "The agent's"]
/** Holding's `Outcome` of a settled reward. */
const PAID = 1
const TIMEOUT: Record<string, [string, Mark]> = {
  'review-window': ['Accepted: the review window closed without a decision', 'done'],
  'delivery-deadline': ['Closed: nothing was delivered in time', 'fail'],
  'dispute-window': ['The rejection stands: no dispute was filed', 'fail'],
  'arbitration-window': ['Refunded: the arbitrator did not rule in time', 'warn'],
}

const reason = (v: unknown) => {
  try {
    return hexToString(v as Hex).replace(/\0+$/, '')
  } catch {
    return String(v)
  }
}

export interface TimelineJob {
  token: string | null
  reward: string | null
  agentId: string | null
  deliveryDeadline: number | null
  creator: string | null
}

export function pastSteps(events: TimelineEvent[], job: TimelineJob): Step[] {
  const agent = job.agentId !== null ? `Worker #${job.agentId}` : 'The agent'
  const steps: Step[] = []
  for (const e of events) {
    const a = e.args
    const at = e.at
    const tx = e.txHash
    switch (e.name) {
      case 'Published':
        steps.push({
          mark: 'done',
          title: `Posted · ${amount(String(a.reward ?? job.reward ?? '0'), job.token)} locked in escrow`,
          at,
          tx,
        })
        break
      case 'Activated':
        steps.push({
          mark: 'done',
          title: `Worker #${String(a.agentId)} started`,
          sub:
            String(a.workerBond ?? '0') !== '0'
              ? `Reserved its ${bond(String(a.workerBond))} deposit from backing`
              : undefined,
          at,
          tx,
        })
        break
      case 'ToppedUp':
        steps.push({ mark: 'done', title: `${amount(String(a.amount), job.token)} added to the reward`, at, tx })
        break
      case 'JobSubmitted': {
        const late = job.deliveryDeadline !== null && at !== null && at > job.deliveryDeadline
        steps.push({ mark: late ? 'warn' : 'done', title: late ? 'Delivered after the deadline' : 'Delivered', at, tx })
        break
      }
      case 'EvidenceAttached':
        steps.push({
          mark: Number(a.conclusion) === 1 ? 'done' : 'warn',
          title: Number(a.conclusion) === 1 ? 'Required check passed' : 'Required check failed',
          sub: 'Signed attestation of the GitHub check run',
          at,
          tx,
        })
        break
      case 'Rejected':
        steps.push({ mark: 'warn', title: `Rejected ${VIOLATION[Number(a.violation)] ?? ''}`.trim(), at, tx })
        break
      case 'Disputed':
        steps.push({ mark: 'warn', title: `${agent} disputed the rejection`, at, tx })
        break
      case 'Ruled':
        steps.push({
          mark: a.forWorker === true ? 'done' : 'fail',
          title: a.forWorker === true ? `The arbitrator ruled for ${agent}` : 'The arbitrator ruled for the creator',
          sub:
            a.slashLoser === true
              ? a.forWorker === true
                ? "Bad-faith rejection: the creator's deposit at risk is sent to the treasury"
                : "The agent's deposit at risk is sent to the treasury"
              : undefined,
          at,
          tx,
        })
        break
      case 'Accepted':
        steps.push({ mark: 'done', title: 'Approved', at, tx })
        break
      case 'TimedOut': {
        const [title, mark] = TIMEOUT[reason(a.reason)] ?? [`Timed out (${reason(a.reason)})`, 'warn']
        steps.push({ mark, title, at, tx })
        break
      }
      case 'PaymentReleased':
        steps.push({ mark: 'done', title: `${amount(String(a.amount), job.token)} paid to ${agent}`, at, tx })
        break
      case 'RewardSettled':
        // A completed job's agent was paid by the core already (PaymentReleased); a paid settlement adds the top-ups.
        if (String(a.amount) === '0') break
        steps.push({
          mark: 'done',
          title:
            Number(a.outcome) === PAID
              ? `${amount(String(a.amount), job.token)} paid to ${agent}`
              : `${amount(String(a.amount), job.token)} returned to the creator`,
          at,
          tx,
        })
        break
      case 'FeeCharged':
        steps.push({ mark: 'done', title: `Sidequest's fee: ${amount(String(a.amount), job.token)}`, at, tx })
        break
      case 'TopUpRefunded':
        steps.push({
          mark: 'done',
          title: `${amount(String(a.amount), job.token)} top-up refunded to its contributor`,
          at,
          tx,
        })
        break
      case 'BondReleased':
        steps.push({
          mark: 'done',
          title: `${SIDE[Number(a.side)] ?? 'A'} ${bond(String(a.amount))} deposit at risk released`,
          at,
          tx,
        })
        break
      case 'BondSlashed':
        steps.push({
          mark: 'fail',
          title: `${SIDE[Number(a.side)] ?? 'A'} ${bond(String(a.amount))} deposit at risk slashed`,
          at,
          tx,
        })
        break
      case 'BondForfeited':
        steps.push({
          mark: 'warn',
          title: `${bond(String(a.amount))} of the creator bond forfeited to the treasury`,
          sub: 'This listing ended without activation.',
          at,
          tx,
        })
        break
      case 'PayoutDeferred':
        steps.push({
          mark: 'warn',
          title: 'Payout held: the transfer could not go through',
          sub:
            a.refundedToHolding === true
              ? 'The reward is back in escrow; anyone can retry the payout.'
              : 'Anyone can retry the payout.',
          at,
          tx,
        })
        break
      case 'PayoutOwed':
        steps.push({
          mark: 'warn',
          title: `${amount(String(a.amount), job.token)} owed: the transfer failed`,
          sub: 'The recipient withdraws it from the contract.',
          at,
          tx,
        })
        break
      case 'Cancelled':
        steps.push({ mark: 'fail', title: 'Cancelled before anyone started', at, tx })
        break
      case 'JobExpired':
        steps.push({ mark: 'fail', title: 'Expired and refunded', at, tx })
        break
      case 'FeedbackRecorded':
        steps.push({ mark: 'done', title: `Rated "${String(a.tag)}" on ${agent}'s public record`, at, tx })
        break
      default:
        break
    }
  }
  return steps
}

/** What is still to come, from the phase the job is in. */
function nextSteps(phase: Phase | null): Step[] {
  if (phase === null || phase.terminal) return []
  const now = (title: string): Step => ({ mark: 'now', title, at: phase.deadline })
  switch (phase.key) {
    case 'draft':
    case 'draft-stale':
      return [
        now('Publish: the reward is locked in escrow'),
        { mark: 'next', title: 'An agent starts' },
        { mark: 'next', title: 'Delivered and reviewed' },
        { mark: 'next', title: 'Paid' },
      ]
    case 'hire-open':
      return [
        now('Taking applications'),
        { mark: 'next', title: 'An agent starts' },
        { mark: 'next', title: 'Delivered and reviewed' },
        { mark: 'next', title: 'Paid' },
      ]
    case 'active':
      return [now('Working on it'), { mark: 'next', title: 'Delivered and reviewed' }, { mark: 'next', title: 'Paid' }]
    case 'in-review':
      return [now('In review'), { mark: 'next', title: 'Paid' }]
    case 'rejected-pending':
      return [now('Dispute window'), { mark: 'next', title: 'Refund, or arbitration if disputed' }]
    case 'disputed':
      return [now('The arbitrator decides'), { mark: 'next', title: 'Paid or refunded' }]
    default:
      return [{ mark: 'now', title: phase.label }]
  }
}

export function Timeline({ events, job, phase }: { events: TimelineEvent[]; job: TimelineJob; phase: Phase | null }) {
  const steps = [...pastSteps(events, job), ...nextSteps(phase)]
  if (steps.length === 0) return null
  return (
    <ol className="grid rounded-xl bg-card px-4 pt-3.5 pb-1">
      {steps.map((s, i) => (
        <li
          key={`${i}-${s.title}`}
          className="relative grid min-w-0 grid-cols-[1.375rem_minmax(0,1fr)] gap-x-3 pb-4 sm:grid-cols-[1.375rem_minmax(0,1fr)_auto]"
        >
          {i < steps.length - 1 && (
            <span
              aria-hidden
              className={cn(
                'absolute top-6 bottom-0 left-[0.625rem] w-0.5',
                s.mark === 'done' ? 'bg-primary/45' : 'bg-border',
              )}
            />
          )}
          <Dot mark={s.mark} />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <span
              className={cn('block leading-snug font-medium', s.mark === 'next' && 'font-normal text-muted-foreground')}
            >
              {s.title}
            </span>
            {s.sub !== undefined && <span className="block text-ui text-muted-foreground">{s.sub}</span>}
            {s.mark === 'now' && phase !== null && phase.next.length > 0 && (
              <span className="block text-ui text-muted-foreground">
                <Sentence parts={phase.next} />
              </span>
            )}
            {s.tx !== undefined && (
              <span className="block">
                <TxLink hash={s.tx} />
              </span>
            )}
          </span>
          <span className="col-start-2 min-w-0 text-ui text-muted-foreground sm:col-start-auto sm:text-right">
            {s.at !== undefined && s.at !== null && <When at={s.at} show={s.mark === 'now' ? 'relative' : 'time'} />}
          </span>
        </li>
      ))}
    </ol>
  )
}

function Dot({ mark }: { mark: Mark }) {
  const base = 'relative z-10 mt-0.5 grid size-[1.375rem] place-items-center rounded-full'
  if (mark === 'done')
    return (
      <span className={cn(base, 'bg-primary text-primary-foreground')}>
        <Check aria-hidden className="size-3" strokeWidth={3.5} />
      </span>
    )
  if (mark === 'fail')
    return (
      <span className={cn(base, 'bg-destructive-text text-background')}>
        <X aria-hidden className="size-3" strokeWidth={3.5} />
      </span>
    )
  if (mark === 'warn')
    return (
      <span className={cn(base, 'bg-warning-text text-background')}>
        <AlertTriangle aria-hidden className="size-3" strokeWidth={3} />
      </span>
    )
  if (mark === 'now')
    return (
      <span className={cn(base, 'bg-card ring-2 ring-primary ring-inset')}>
        <span className="size-2 rounded-full bg-primary" />
      </span>
    )
  return <span className={cn(base, 'bg-accent')} />
}
