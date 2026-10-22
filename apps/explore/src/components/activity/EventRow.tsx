import { type FeedEvent, type FeedJob, trackOf } from '../../activity-feed.ts'
import { activityIcon } from '../../activity.ts'
import { currentBoardId } from '../../api.ts'
import { jobTarget } from '../../job-list.ts'
import { posterParty } from '../../activity-feed.ts'
import { type LiveItem, type Party, liveSentence } from '../../live-activity.ts'
import { ActivityIcon } from '../ActivityRow.tsx'
import { AgentCardLink, AgentCardOrb } from '../agent/AgentCard.tsx'
import { type LinkTarget, boardRoutes } from '../BoardLink.tsx'
import { Ago } from '../Time.tsx'
import { RollingCountdown } from '../RollingCountdown.tsx'
import { DeliveryImage } from '../delivery/DeliveryImage.tsx'
import { cn } from '../../lib/cn.ts'
import { StepTrack } from './StepTrack.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'
import { type RowDelivery, useRowDelivery } from '../../delivery-preview.ts'
import { type Thumb, previewPlan, thumbOf } from '../../delivery-plan.ts'
import { stage } from '../../wallet.ts'
import { WalletLink, WalletOrb } from '../WalletLink.tsx'
import { JobCard } from './JobCard.tsx'
import { RowThumb } from './RowMeta.tsx'
import { useNear } from './useNear.ts'
import { StretchedRow } from './StretchedRow.tsx'

/** The feed kind whose icon a row borrows when no agent is named. */
const ICON_KIND: Readonly<Record<LiveItem['kind'], string>> = {
  requested: 'request.opened',
  posted: 'job.published',
  hired: 'job.activated',
  delivered: 'job.submitted',
  completed: 'job.completed',
  rejected: 'job.rejected',
  disputed: 'job.disputed',
  ruled: 'job.ruled',
  cancelled: 'job.cancelled',
  expired: 'job.expired',
}

/** Where the event's work opens: its job or request on the board that holds it. */
function eventTarget(event: FeedEvent): LinkTarget {
  if (event.job !== undefined) return jobTarget(event.job.item, currentBoardId())
  const routes = boardRoutes()
  return event.jobId === null ? routes.request(event.requestId ?? '') : routes.job(event.jobId)
}

/** The sentence around the quoted title, so the title can stand out. */
function aroundTitle(text: string, title: string): [string, string] {
  const quoted = `“${title}”`
  const at = text.indexOf(quoted)
  return at === -1 ? [text, ''] : [text.slice(0, at), text.slice(at + quoted.length)]
}

/** The steps after which a row shows what was delivered: the delivery itself and what became of it. */
const DELIVERED: ReadonlySet<LiveItem['kind']> = new Set(['delivered', 'completed', 'rejected', 'disputed', 'ruled'])

/** What a delivered row shows of the delivery, read once the row is near the viewport. */
function useEventDelivery(event: FeedEvent) {
  const [ref, near] = useNear<HTMLParagraphElement>()
  const shows = DELIVERED.has(event.kind) && event.job?.item.chain?.deliverable != null
  // The job's delivery is cached once for all its rows; only rows at or after the delivery show it.
  const read = useRowDelivery(event.job, shows && near).data ?? null
  const delivery: RowDelivery | null = shows ? read : null
  const plan =
    delivery === null
      ? null
      : previewPlan({
          jobId: event.jobId,
          stage,
          deliverable: delivery.deliverable.descriptor,
          preview: delivery.preview,
        })
  return { ref, delivery, thumb: plan === null ? null : thumbOf(plan) }
}

/** A party's mark: an agent's orb with its card, or a wallet's colour mark. */
function PartyOrb({ party, className }: { party: Party; className: string }) {
  return 'agent' in party ? (
    <AgentCardOrb id={party.agent} className={className} />
  ) : (
    <WalletOrb address={party.wallet} className={className} />
  )
}

/** A party named in a sentence: an agent's name with its card, or a wallet's short address. */
function PartyName({ party }: { party: Party }) {
  return 'agent' in party ? <AgentCardLink id={party.agent} /> : <WalletLink address={party.wallet} orb={false} />
}

const partyLabel = (party: Party) => ('agent' in party ? `Agent ${party.agent}` : `Wallet ${party.wallet}`)

/** Who the event is about: its agent, else the wallet that posted, else nobody this page can name. */
function actorOf(event: FeedEvent): Party | null {
  if (event.agentId !== null) return { agent: event.agentId }
  return event.wallet === undefined ? null : { wallet: event.wallet }
}

/** Who did it: the agent's or posting wallet's mark, and the payer's small mark on its corner when a paid step names both. */
function EventMedia({ event, payer }: { event: FeedEvent; payer: Party | undefined }) {
  const actor = actorOf(event)
  if (actor === null) return <ActivityIcon icon={activityIcon(ICON_KIND[event.kind])} />
  return (
    <span className="relative inline-flex">
      <PartyOrb party={actor} className="size-9" />
      {payer !== undefined && (
        <span className="absolute -right-1.5 -bottom-1.5 inline-flex rounded-full ring-2 ring-card">
          <PartyOrb party={payer} className="size-5" />
        </span>
      )}
    </span>
  )
}

/** The word on a delivery that was not accepted: the work stays visible, faded, with what became of it. */
const UNACCEPTED: Partial<Record<LiveItem['kind'], string>> = {
  rejected: 'Rejected',
  disputed: 'In dispute',
  ruled: 'Ruled',
}

/**
 * What was delivered, large: 16:10, beside the sentence on a wide screen (`wide`) or under it, full width, on a phone.
 * A delivery that was not accepted is faded under its status word. The box keeps its size when the picture fails to
 * load, so every row's preview lines up.
 */
function WorkPreview({ thumb, status, wide }: { thumb: Thumb; status: string | undefined; wide: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative aspect-[16/10] shrink-0 overflow-hidden rounded-lg bg-muted ring-1 ring-foreground/10',
        wide ? 'hidden w-40 sm:block' : 'block w-full sm:hidden',
      )}
    >
      <DeliveryImage thumb={thumb} icons={wide ? 8 : 16} className={cn('size-full', status && 'opacity-45')} />
      {status !== undefined && (
        <span className="absolute bottom-1.5 left-1.5 rounded-md bg-background/85 px-1.5 py-0.5 text-xs font-medium text-foreground">
          {status}
        </span>
      )}
    </span>
  )
}

/** An open request's public facts: what it may pay, when quoting closes and how many agents quoted (never amounts). */
function RequestFacts({ job }: { job: FeedJob }) {
  const r = job.item.request
  if (r === undefined || job.bucket !== 'open') return null
  const quotes = r.quotesCount ?? 0
  return (
    <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      {r.budget !== undefined && (
        <span>
          Up to <TokenAmount value={r.budget.max} token={r.budget.token} static />
        </span>
      )}
      <span className="flex items-baseline gap-1">
        Closes in <RollingCountdown to={r.quoteDeadline} passed="closed" />
      </span>
      <span className="tabular-nums">
        {quotes === 0 ? 'No quotes yet' : `${quotes} ${quotes === 1 ? 'quote' : 'quotes'}`}
      </span>
    </span>
  )
}

/**
 * The row's sentence: payer and actor named (agents with their cards, wallets by address), the job's title set apart.
 * A payment's amount stands in the ledger column instead (`ledger`), so the sentence reads who paid whom for what.
 */
function EventSentence({
  event,
  sentence,
  ledger,
}: {
  event: FeedEvent
  sentence: ReturnType<typeof liveSentence>
  ledger: boolean
}) {
  const { actor, text, payer } = sentence
  const [before, after] = aroundTitle(text, event.title)
  const amount =
    event.amount === undefined || ledger ? null : <TokenAmount value={event.amount} token={event.token} static />
  const actorParty = actor ? actorOf(event) : null
  return (
    <>
      {payer !== undefined && (
        <>
          <PartyName party={payer} /> paid{' '}
        </>
      )}
      {actorParty !== null && (
        <>
          <PartyName party={actorParty} />{' '}
        </>
      )}
      {payer !== undefined && amount !== null && <>{amount} </>}
      {before}
      <span className="font-medium">“{event.title}”</span>
      {after}
      {payer === undefined && amount !== null && (
        <span className="text-muted-foreground">
          {' '}
          <TokenAmount value={event.amount} token={event.token} static />
        </span>
      )}
    </>
  )
}

/** A payment's amount, in the ledger column at the row's end, above how long ago it was paid. */
function LedgerAside({ event }: { event: FeedEvent }) {
  return (
    <span className="grid justify-items-end gap-0.5 text-right sm:min-w-28">
      <TokenAmount
        value={event.amount}
        token={event.token}
        static
        className="text-sm font-medium whitespace-nowrap text-foreground tabular-nums"
      />
      <Ago at={event.at} />
    </span>
  )
}

/**
 * One thing that happened, as a sentence: who did it, what, to which job, for how much and how long ago. As a job's
 * row (the feed's usual reading) it also carries the job's track and, once work was delivered, the work itself, large;
 * as a `compact` job row (a profile's list) the track and a small picture of the work; as one step among every step
 * (`step`) the sentence alone. A press opens the job's card; a job this page cannot read links to its page.
 */
export function EventRow({
  event,
  layout = 'job',
  fresh = false,
}: {
  event: FeedEvent
  layout?: 'job' | 'compact' | 'step'
  /** Just arrived in the feed. */
  fresh?: boolean
}) {
  const sentence = liveSentence(event, posterParty(event.job))
  const target = eventTarget(event)
  const actorParty = sentence.actor ? actorOf(event) : null
  const who = actorParty === null ? '' : `${partyLabel(actorParty)} `
  const shown = useEventDelivery(event)
  const status = UNACCEPTED[event.kind]
  const big = layout === 'job' && shown.thumb !== null
  const track = layout !== 'step' && event.job !== undefined ? trackOf(event.job) : []
  // A payment in a job's row reads as a ledger line: who paid whom for what, the amount in its own column.
  const ledger = layout !== 'step' && sentence.payer !== undefined && event.amount !== undefined
  return (
    <StretchedRow
      fresh={fresh}
      label={
        sentence.payer === undefined
          ? `${who}${sentence.text}`
          : `${partyLabel(sentence.payer)} paid ${who}${sentence.text}`
      }
      action={
        event.job === undefined
          ? { kind: 'link', target }
          : { kind: 'card', target, title: event.title, card: <JobCard job={event.job} /> }
      }
      media={<EventMedia event={event} payer={sentence.payer} />}
      aside={ledger ? <LedgerAside event={event} /> : <Ago at={event.at} />}
      thumb={
        shown.thumb === null ? undefined : big ? (
          <WorkPreview thumb={shown.thumb} status={status} wide />
        ) : (
          <RowThumb thumb={shown.thumb} />
        )
      }
    >
      <p ref={shown.ref} className="text-sm leading-snug text-pretty">
        <EventSentence event={event} sentence={sentence} ledger={ledger} />
      </p>
      {big && shown.thumb !== null && <WorkPreview thumb={shown.thumb} status={status} wide={false} />}
      {event.job !== undefined && <RequestFacts job={event.job} />}
      <StepTrack stops={track} />
    </StretchedRow>
  )
}
