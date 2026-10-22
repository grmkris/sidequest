/**
 * The job page's parts around its terms: who hired whom (under the title), the delivery (first, large), the brief
 * clamped with its criteria as a checklist, and the side column's four milestones with every chain event folded below.
 */
import type { Phase } from '@sidequest/react'
import { Circle, CircleCheck } from 'lucide-react'
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { type DeliveryWhere, useJobDelivery } from '../../delivery-preview.ts'
import { previewPlan } from '../../delivery-plan.ts'
import { type Milestone, milestones } from '../../job-milestones.ts'
import { cn } from '../../lib/cn.ts'
import { stage } from '../../wallet.ts'
import { AgentCardLink, AgentCardOrb } from '../agent/AgentCard.tsx'
import { DeliveryPreview } from '../delivery/DeliveryPreview.tsx'
import { Details, textLinkClass } from '../kit.tsx'
import { Skeleton } from '../ui/skeleton.tsx'
import { WalletLink } from '../WalletLink.tsx'
import { type TimelineEvent, type TimelineJob, Timeline } from './Timeline.tsx'

/** "Kava & Crumb hired Quill": the poster (its agent, else its wallet) and the hired agent, each opening its card. */
export function Parties({
  creator,
  posterAgent,
  workerAgent,
  paid,
}: {
  creator: string | null
  posterAgent: string | null
  workerAgent: string | null
  paid: boolean
}) {
  const poster =
    posterAgent !== null ? (
      <span className="inline-flex items-center gap-1.5">
        <AgentCardOrb id={posterAgent} className="size-6" />
        <AgentCardLink id={posterAgent} />
      </span>
    ) : creator !== null ? (
      <WalletLink address={creator} />
    ) : null
  if (poster === null && workerAgent === null) return null
  return (
    // A div, not a p: an agent's orb is a block.
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
      {workerAgent === null ? (
        <>Posted by {poster}</>
      ) : (
        <>
          {poster ?? 'Someone'} {paid ? 'paid' : 'hired'}
          <span className="inline-flex items-center gap-1.5 text-foreground">
            <AgentCardOrb id={workerAgent} className="size-6" />
            <AgentCardLink id={workerAgent} />
          </span>
        </>
      )}
    </div>
  )
}

/** What was delivered, as large as the column: its picture, its 3D model or its kind's glyph. */
export function DeliveryHero({ where, jobId }: { where: DeliveryWhere; jobId: string }) {
  const read = useJobDelivery(where)
  if (where.hash == null) return null
  if (read.isPending) return <Skeleton className="aspect-[16/9] w-full rounded-xl" />
  const delivery = read.data ?? null
  const descriptor = delivery?.deliverable.descriptor ?? null
  const plan = previewPlan({ jobId, stage, deliverable: descriptor, preview: delivery?.preview ?? null })
  return (
    <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
      <DeliveryPreview plan={plan} deliverable={descriptor} />
    </div>
  )
}

/** Whether a clamped paragraph hides lines, measured as it lays out and again whenever its width changes. */
function useClamped<T extends HTMLElement>(text: string) {
  const ref = useRef<T>(null)
  const [clamped, setClamped] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const check = () => setClamped(el.scrollHeight > el.clientHeight + 1)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text])
  return [ref, clamped] as const
}

/** The brief, folded to eight lines when longer, and what it is accepted on as a checklist, ticked once accepted. */
export function Brief({ brief, criteria, met }: { brief: string; criteria: readonly string[]; met: boolean }) {
  const [all, setAll] = useState(false)
  const [ref, clamped] = useClamped<HTMLParagraphElement>(brief)
  return (
    <div className="grid min-w-0 gap-4 rounded-xl bg-card px-4 py-3.5 leading-relaxed shadow-stock">
      <div className="grid justify-items-start gap-1">
        <p
          ref={ref}
          className={cn('min-w-0 whitespace-pre-wrap text-pretty [overflow-wrap:anywhere]', !all && 'line-clamp-8')}
        >
          {brief}
        </p>
        {(all || clamped) && (
          <button
            type="button"
            aria-expanded={all}
            onClick={() => setAll(!all)}
            className={cn(textLinkClass, 'inline-flex items-center text-ui font-medium pointer-coarse:min-h-11')}
          >
            {all ? 'Show less' : 'Read all'}
          </button>
        )}
      </div>
      {criteria.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-ui text-muted-foreground">{met ? 'Accepted on' : 'Accepted when'}</p>
          <ul className="m-0 grid list-none gap-1.5 p-0">
            {criteria.map((criterion) => (
              <li key={criterion} className="flex gap-2 [overflow-wrap:anywhere]">
                {met ? (
                  <CircleCheck aria-hidden className="mt-1 size-4 shrink-0 text-success-text" />
                ) : (
                  <Circle aria-hidden className="mt-1 size-4 shrink-0 text-muted-foreground/60" />
                )}
                <span className="min-w-0">{criterion}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** "Oct 10, 11:08": the day and the minute, without the weekday a column has no room for. */
const STAMP = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

const DOT: Readonly<Record<Milestone['state'], string>> = {
  done: 'bg-primary',
  todo: 'border border-muted-foreground/40',
  failed: 'bg-destructive-text',
  closed: 'bg-muted-foreground/60',
}

/**
 * Posted, hired, delivered and paid, with when, as a receipt's lines on dotted leaders; or where a job that left that
 * path ended. Below the money when there is a head, parted from it by a dashed tear line.
 */
function Milestones({ events, below }: { events: readonly TimelineEvent[]; below: boolean }) {
  return (
    <ol
      aria-label="Milestones"
      className={cn('m-0 grid list-none p-0 px-4 py-2', below && 'border-t border-dashed border-border')}
    >
      {milestones(events).map((m) => (
        <li key={m.label} className="flex min-h-9 items-center gap-2.5 text-sm">
          <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT[m.state])} />
          <span
            className={cn(
              'min-w-0 shrink-0',
              m.state === 'todo' && 'text-muted-foreground',
              m.state === 'failed' && 'text-destructive-text',
            )}
          >
            {m.label}
            {m.state === 'todo' && <span className="sr-only">, not yet</span>}
          </span>
          <span
            aria-hidden
            className="min-w-4 flex-1 translate-y-[0.3em] border-b border-dotted border-foreground/25"
          />
          {m.at !== null && (
            <time
              dateTime={new Date(m.at * 1000).toISOString()}
              title={new Date(m.at * 1000).toUTCString()}
              className="shrink-0 text-ui text-muted-foreground tabular-nums"
            >
              {STAMP.format(m.at * 1000)}
            </time>
          )}
        </li>
      ))}
    </ol>
  )
}

/** The side column's story: the milestones, and every chain event with its transaction one fold away. */
export function JobStory({
  events,
  job,
  phase,
  money,
}: {
  events: readonly TimelineEvent[]
  job: TimelineJob
  phase: Phase | null
  /** What the job pays, at the head of the same slip. */
  money?: ReactNode
}) {
  if (events.length === 0 && money === undefined) return null
  return (
    <>
      <Receipt>
        {money}
        {events.length > 0 && <Milestones events={events} below={money !== undefined} />}
      </Receipt>
      {events.length > 0 && (
        <Details summary="All chain events">
          <Timeline events={[...events]} job={job} phase={phase} />
        </Details>
      )}
    </>
  )
}

/** One cotton slip on the desk: the job's money and its milestones read as a single receipt. */
export function Receipt({ children }: { children: ReactNode }) {
  return <div className="grid min-w-0 rounded-lg bg-card shadow-stock">{children}</div>
}
