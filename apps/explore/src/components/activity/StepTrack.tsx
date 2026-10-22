import { type TrackStop } from '../../activity-feed.ts'
import { shortSpan } from '../../format.ts'
import { cn } from '../../lib/cn.ts'

const DOT: Readonly<Record<TrackStop['state'], string>> = {
  done: 'bg-primary',
  todo: 'border border-muted-foreground/40',
  failed: 'bg-destructive-text',
  closed: 'bg-muted-foreground/60',
}

const LABEL: Readonly<Record<TrackStop['state'], string>> = {
  done: 'text-foreground',
  todo: 'text-muted-foreground',
  failed: 'text-destructive-text',
  closed: 'text-muted-foreground',
}

/**
 * A job's way along posted → hired → delivered → paid, as stops joined by a short hairline with the time each step took
 * beside it. Stops still ahead are hollow; a job that left the path ends at a red or grey stop.
 */
export function StepTrack({
  stops,
  className,
  stamp = false,
}: {
  stops: readonly TrackStop[]
  className?: string
  /** Press the settled stop (Paid) into the line, as the feed's ledger does; a card that carries its own stamp leaves it off. */
  stamp?: boolean
}) {
  if (stops.length === 0) return null
  const spoken = stops.map((s) => (s.state === 'todo' ? `${s.label} next` : s.label)).join(', ')
  return (
    <ol
      aria-label={spoken}
      className={cn('m-0 flex min-w-0 list-none flex-wrap items-center gap-y-0.5 p-0 text-xs', className)}
    >
      {stops.map((stop, i) => (
        <li key={stop.label} aria-hidden className="flex items-center whitespace-nowrap">
          {i > 0 && (
            <span className="flex items-center gap-1 px-1.5 text-muted-foreground">
              <span className="h-px w-2 bg-border" />
              {stop.after !== null && <span className="tabular-nums">{shortSpan(stop.after)}</span>}
            </span>
          )}
          {stamp && stop.label === 'Paid' && stop.state === 'done' ? (
            <span className="stamp-paid ms-1 text-sm">{stop.label}</span>
          ) : (
            <span className="flex items-center gap-1">
              <span className={cn('size-1.5 shrink-0 rounded-full', DOT[stop.state])} />
              {/* A phone names the first and last stops; the ones between are dots with their times. */}
              <span className={cn(LABEL[stop.state], i > 0 && i < stops.length - 1 && 'hidden sm:inline')}>
                {stop.label}
              </span>
            </span>
          )}
        </li>
      ))}
    </ol>
  )
}
