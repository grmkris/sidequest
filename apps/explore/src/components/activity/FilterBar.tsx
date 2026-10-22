import { JOB_TAG_LABELS } from '@sidequest/sdk'
import { SlidersHorizontal, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { type FeedFilter, NO_FILTER, STEP_FILTERS, type StepFilter } from '../../activity-feed.ts'
import { cn } from '../../lib/cn.ts'
import { AgentLabel } from '../agent/AgentChip.tsx'
import { AgentOrb } from '../agent/AgentOrb.tsx'
import { SearchBox, TagChips } from '../JobFilters.tsx'
import { Segmented } from '../kit.tsx'
import { Sheet } from '../Sheet.tsx'
import { Button } from '../ui/button.tsx'

const STEP_LABEL: Readonly<Record<StepFilter, string>> = {
  all: 'All',
  open: 'Open',
  progress: 'Under way',
  review: 'In review',
  paid: 'Paid',
  disputes: 'Disputes',
  closed: 'Closed',
}

const chip = (on: boolean) =>
  cn(
    'inline-flex min-h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-[background-color,color,box-shadow] duration-(--dur-fast) pointer-coarse:min-h-11',
    on
      ? 'bg-card text-foreground shadow-stock'
      : 'bg-muted text-muted-foreground [@media(hover:hover)]:hover:text-foreground',
  )

interface BarProps {
  filter: FeedFilter
  counts: Readonly<Record<StepFilter, number>>
  /** Whether the counts are known; until then they read "…". */
  ready: boolean
  signedIn: boolean
  onChange: (filter: FeedFilter) => void
}

/** Where the work stands, with how many jobs each would show; empty steps hide once the counts are known. */
function StepControl({ filter, counts, ready, onChange }: Omit<BarProps, 'signedIn'>) {
  const steps = STEP_FILTERS.filter((step) => step === 'all' || step === filter.step || !ready || counts[step] > 0)
  return (
    <Segmented
      label="Where the work stands"
      value={filter.step}
      onChange={(step) => onChange({ ...filter, step })}
      options={steps.map(
        (step) =>
          [
            step,
            <span key={step} className="whitespace-nowrap">
              {STEP_LABEL[step]}{' '}
              <span className="text-muted-foreground tabular-nums">{ready ? counts[step] : '…'}</span>
            </span>,
          ] as const,
      )}
    />
  )
}

/** Mine, the picked agent and every step: the toggles beside the tags. */
function Toggles({ filter, signedIn, onChange }: Pick<BarProps, 'filter' | 'signedIn' | 'onChange'>) {
  return (
    <>
      {signedIn && (
        <button
          type="button"
          aria-pressed={filter.mine}
          className={chip(filter.mine)}
          onClick={() => onChange({ ...filter, mine: !filter.mine })}
        >
          Mine
        </button>
      )}
      {filter.agent !== null && (
        <button
          type="button"
          className={chip(true)}
          aria-label="Show every agent's work"
          onClick={() => onChange({ ...filter, agent: null })}
        >
          <AgentOrb agentId={filter.agent} size="sm" />
          <AgentLabel id={filter.agent} />
          <X aria-hidden className="size-3.5" />
        </button>
      )}
      <button
        type="button"
        aria-pressed={filter.everyStep}
        className={chip(filter.everyStep)}
        onClick={() => onChange({ ...filter, everyStep: !filter.everyStep })}
      >
        Every step
      </button>
    </>
  )
}

/** One applied filter as a chip that removes it. */
function ActiveChip({ children, onRemove, label }: { children: ReactNode; onRemove: () => void; label: string }) {
  return (
    <button type="button" className={chip(true)} aria-label={label} onClick={onRemove}>
      {children}
      <X aria-hidden className="size-3.5" />
    </button>
  )
}

/** On a phone, what the Filters sheet has applied, each removable in a tap. */
function ActiveChips({ filter, onChange }: Pick<BarProps, 'filter' | 'onChange'>) {
  const chips: { key: string; text: ReactNode; label: string; next: FeedFilter }[] = [
    ...(filter.step === 'all'
      ? []
      : [
          {
            key: 'step',
            text: STEP_LABEL[filter.step],
            label: `Remove ${STEP_LABEL[filter.step]}`,
            next: { ...filter, step: 'all' as const },
          },
        ]),
    ...filter.tags.map((tag) => ({
      key: `tag-${tag}`,
      text: JOB_TAG_LABELS[tag],
      label: `Remove ${JOB_TAG_LABELS[tag]}`,
      next: { ...filter, tags: filter.tags.filter((t) => t !== tag) },
    })),
    ...(filter.mine ? [{ key: 'mine', text: 'Mine', label: 'Remove Mine', next: { ...filter, mine: false } }] : []),
    ...(filter.agent === null
      ? []
      : [
          {
            key: 'agent',
            text: <AgentLabel id={filter.agent} />,
            label: "Show every agent's work",
            next: { ...filter, agent: null },
          },
        ]),
    ...(filter.everyStep
      ? [{ key: 'steps', text: 'Every step', label: 'One row per job', next: { ...filter, everyStep: false } }]
      : []),
  ]
  if (chips.length === 0) return null
  return (
    <div className="flex min-w-0 flex-wrap gap-2">
      {chips.map((c) => (
        <ActiveChip key={c.key} label={c.label} onRemove={() => onChange(c.next)}>
          {c.text}
        </ActiveChip>
      ))}
    </div>
  )
}

/** How many filters are applied, for the phone's Filters button. */
const applied = (f: FeedFilter) =>
  (f.step === 'all' ? 0 : 1) + f.tags.length + (f.mine ? 1 : 0) + (f.agent === null ? 0 : 1) + (f.everyStep ? 1 : 0)

/** The phone's filters: the search and a Filters button on one line, the rest in a sheet, what applies as chips. */
function PhoneBar(props: BarProps) {
  const { filter, onChange } = props
  const [open, setOpen] = useState(false)
  const count = applied(filter)
  return (
    <div className="grid min-w-0 gap-2 md:hidden">
      <div className="flex min-w-0 gap-2">
        <div className="min-w-0 flex-1">
          <SearchBox value={filter.q} onChange={(q) => onChange({ ...filter, q })} label="Search activity" />
        </div>
        <Button variant="secondary" onClick={() => setOpen(true)} aria-haspopup="dialog">
          <SlidersHorizontal aria-hidden />
          Filters
          {count > 0 && <span className="tabular-nums text-muted-foreground">{count}</span>}
        </Button>
      </div>
      <ActiveChips filter={filter} onChange={onChange} />
      <Sheet open={open} onClose={() => setOpen(false)} title="Filters">
        <div className="grid gap-4">
          <StepControl {...props} />
          <TagChips tags={filter.tags} onChange={(tags) => onChange({ ...filter, tags })} />
          <div className="flex flex-wrap gap-2">
            <Toggles {...props} />
          </div>
          <div className="flex gap-2">
            {count > 0 && (
              <Button variant="secondary" className="flex-1" onClick={() => onChange({ ...NO_FILTER, q: filter.q })}>
                Clear all
              </Button>
            )}
            <Button className="flex-1" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  )
}

/**
 * Activity's filters: a search, where the work stands (with how many jobs each would show, hiding the empty ones), the
 * viewer's own work, tags, the agent picked from a row's details, and every step as its own row. Wide screens show
 * them inline; a phone keeps them in a sheet.
 */
export function FilterBar(props: BarProps) {
  const { filter, onChange } = props
  return (
    <>
      <PhoneBar {...props} />
      <div className="hidden min-w-0 gap-2 md:grid">
        <div className="grid min-w-0 grid-cols-[minmax(0,15rem)_minmax(0,1fr)] items-center gap-2">
          <SearchBox value={filter.q} onChange={(q) => onChange({ ...filter, q })} label="Search activity" />
          <StepControl {...props} />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Toggles {...props} />
          <TagChips tags={filter.tags} onChange={(tags) => onChange({ ...filter, tags })} />
        </div>
      </div>
    </>
  )
}
