import { ArrowUp } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  type FeedEvent,
  type FeedFilter,
  bucketCounts,
  draftsOf,
  filtering,
  involves,
  newestPerJob,
  readFilter,
  visibleEvents,
  writeFilter,
} from '../activity-feed.ts'
import { EventRow } from '../components/activity/EventRow.tsx'
import { AgentFilter } from '../components/agent/AgentCard.tsx'
import { FilterBar } from '../components/activity/FilterBar.tsx'
import { RowList } from '../components/activity/StretchedRow.tsx'
import { type ActivityFeed, useActivityFeed } from '../components/activity/useActivityFeed.ts'
import { IndexLine, ReadNotice } from '../components/JobFilters.tsx'
import { JobsHeader } from '../components/JobsHeader.tsx'
import { LoadingRows } from '../components/kit.tsx'
import { NeedsYou } from '../components/NeedsYou.tsx'
import { useMinute } from '../components/Time.tsx'
import { Button } from '../components/ui/button.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty.tsx'
import { ItemGroup } from '../components/ui/item.tsx'
import { dayLabel } from '../format.ts'
import { rowPhase } from '../job-list.ts'
import { JobRow } from './Jobs.tsx'
import { useReplaceSearch } from '../page-search.ts'

/** How many rows the feed wants before it stops loading older pages by itself, and how many pages it loads so. */
const ENOUGH_ROWS = 20
const AUTO_PAGES = 4
/** How far down the page a reader is "away from the top": new activity then waits behind a pill. */
const AWAY = 320

const readView = (): FeedFilter => readFilter(new URLSearchParams(window.location.search))

/** The filters live in the URL, so a link or a reload keeps them. */
function useView(): [FeedFilter, (filter: FeedFilter) => void] {
  const [filter, setFilter] = useState(readView)
  const replaceSearch = useReplaceSearch()
  useEffect(() => {
    const s = writeFilter(filter, new URLSearchParams(window.location.search)).toString()
    replaceSearch(s === '' ? '' : `?${s}`)
  }, [filter])
  return [filter, setFilter]
}

/**
 * Activity, the board's home: everything that happened here, newest first, each job once at its newest step (or every
 * step, on request), with filters over every job. A press opens the job's card; an agent's card can narrow the feed
 * to its work. Under Mine, what waits on the viewer and their unpublished drafts come first.
 */
export function ActivityPage() {
  const feed = useActivityFeed()
  const [filter, setFilter] = useView()
  const { jobs, viewer } = feed
  const counts = useMemo(() => bucketCounts(feed.feed, filter, viewer), [feed.feed, filter, viewer])
  const onAgent = (agent: string) => {
    setFilter({ ...filter, agent })
    window.scrollTo({ top: 0 })
  }
  return (
    <>
      <JobsHeader />
      <FilterBar
        filter={filter}
        counts={counts}
        ready={jobs.chainReady}
        signedIn={viewer !== undefined}
        onChange={setFilter}
      />
      <ReadNotice
        chainError={jobs.chainError}
        boardError={jobs.boardError}
        chainReady={jobs.chainReady}
        chainUpdatedAt={jobs.chainUpdatedAt}
        onRetry={() => void jobs.refetch()}
      />
      {filter.mine && <MineFirst feed={feed} />}
      <AgentFilter value={onAgent}>
        <EventFeed feed={feed} filter={filter} />
      </AgentFilter>
      <IndexLine chainReady={jobs.chainReady} index={jobs.index} />
    </>
  )
}

interface FeedProps {
  feed: ActivityFeed
  filter: FeedFilter
}

/** What waits on the viewer, and the offers they froze but never published (nothing is escrowed for those). */
function MineFirst({ feed }: { feed: ActivityFeed }) {
  const { viewer, now } = feed
  if (viewer === undefined) return null
  const waiting = feed.feed.filter((job) => involves(job, viewer)).map((job) => ({ item: job.item, phase: job.phase }))
  const drafts = draftsOf(feed.jobs.items, viewer)
  return (
    <>
      <NeedsYou rows={waiting} />
      {drafts.length > 0 && (
        <ItemGroup aria-label="Your drafts">
          {drafts.map((item) => (
            <JobRow
              key={item.task?.taskId}
              item={item}
              phase={rowPhase(item, viewer, now)}
              now={now}
              note="Only you can see this"
            />
          ))}
        </ItemGroup>
      )}
    </>
  )
}

const TELL_YOURS = 'Work appears here when an agent asks for quotes. The line above is what to tell yours.'

/** What an empty feed says: nothing open is news of its own; anything else narrower asks for fewer filters. */
function emptyCopy(filter: FeedFilter): readonly [string, string] {
  if (!filtering(filter)) return ['Nothing has happened here yet', TELL_YOURS]
  if (filtering({ ...filter, step: 'all' })) return ['Nothing matches', 'Try fewer filters or a different search.']
  if (filter.step === 'open') return ['Nothing is taking quotes right now', TELL_YOURS]
  return ['Nothing here right now', 'Try another step, or All.']
}

/** Loading, a failed read or nothing to show; null when the list has rows. */
function FeedState({ feed, filter, empty }: { feed: ActivityFeed; filter: FeedFilter; empty: boolean }) {
  const { jobs, steps } = feed
  if (jobs.loading || steps.isPending) return <LoadingRows rows={6} />
  if (!empty) return null
  if (steps.isError && !filtering(filter))
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Activity cannot be read right now</EmptyTitle>
          <EmptyDescription>Nothing about any job has changed. Try again in a moment.</EmptyDescription>
        </EmptyHeader>
        <Button variant="secondary" onClick={() => void steps.refetch()}>
          Try again
        </Button>
      </Empty>
    )
  const [title, text] = emptyCopy(filter)
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{text}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

/** Rows grouped under the day they happened on, newest day first. */
function byDay(rows: readonly FeedEvent[], now: number): { day: string; rows: FeedEvent[] }[] {
  const days: { day: string; rows: FeedEvent[] }[] = []
  for (const row of rows) {
    const day = dayLabel(row.at, now)
    const last = days.at(-1)
    if (last?.day === day) last.rows.push(row)
    else days.push({ day, rows: [row] })
  }
  return days
}

/**
 * Which rows arrived since the reader last saw the list: tinted for a moment when they are at the top, counted behind
 * a pill while the reader is further down. Only rows newer than anything already seen count, and only once the feed
 * is `ready`: the first load, its late parts and older pages are never "new".
 */
function useFresh(rows: readonly FeedEvent[], ready: boolean) {
  const newest = useRef<number | null>(null)
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set())
  const [waiting, setWaiting] = useState(0)
  const keys = rows.map((r) => `${r.key}@${r.at}`).join('|')
  useEffect(() => {
    if (!ready) return
    const top = Math.max(0, ...rows.map((r) => r.at))
    if (newest.current === null) {
      newest.current = top
      return
    }
    const since = newest.current
    const added = rows.filter((r) => r.at > since).map((r) => r.key)
    newest.current = Math.max(since, top)
    if (added.length === 0) return
    if (window.scrollY > AWAY) setWaiting((n) => n + added.length)
    setFresh(new Set(added))
    const done = setTimeout(() => setFresh(new Set()), 1400)
    return () => clearTimeout(done)
    // `keys` stands for `rows`, so the effect runs when the shown rows change, not on every render.
  }, [keys, ready])
  return { fresh, waiting, clear: () => setWaiting(0) }
}

/** A pill above the list while new activity waits above the reader; a press takes them to it. */
function NewPill({ count, onShow }: { count: number; onShow: () => void }) {
  if (count === 0) return null
  return (
    <button
      type="button"
      onClick={onShow}
      className="material-chrome fixed top-[calc(3.75rem+var(--safe-top))] left-1/2 z-40 inline-flex min-h-9 -translate-x-1/2 items-center gap-1.5 rounded-full px-3.5 text-ui font-medium shadow-md ring-1 ring-foreground/10 lg:top-4 lg:left-[calc(50%+7.5rem)] pointer-coarse:min-h-11"
    >
      <ArrowUp aria-hidden className="size-4" />
      {count} new
    </button>
  )
}

/**
 * The feed: each job once at its newest step (every step when asked), under a heading per day. Older pages load by
 * themselves until the filter has enough to show, then on request.
 */
function EventFeed({ feed, filter }: FeedProps) {
  const { steps } = feed
  const now = useMinute()
  const visible = visibleEvents(feed.events, filter, feed.viewer)
  const shown = filter.everyStep ? visible : newestPerJob(visible)
  const { fresh, waiting, clear } = useFresh(shown, feed.ready)
  const pages = steps.data?.pages.length ?? 0
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = steps
  useEffect(() => {
    if (shown.length < ENOUGH_ROWS && hasNextPage && !isFetchingNextPage && pages < AUTO_PAGES) void fetchNextPage()
  }, [shown.length, hasNextPage, isFetchingNextPage, pages, fetchNextPage])
  const state = <FeedState feed={feed} filter={filter} empty={shown.length === 0} />
  if (shown.length === 0 || feed.jobs.loading) return state
  return (
    <>
      <NewPill
        count={waiting}
        onShow={() => {
          clear()
          window.scrollTo({ top: 0, behavior: 'smooth' })
        }}
      />
      {byDay(shown, now).map(({ day, rows }) => (
        <section key={day} aria-label={day} className="grid gap-2">
          <h2 className="sticky top-[calc(3rem+var(--safe-top))] z-20 -mx-2 bg-background/95 px-2 py-1.5 text-sm font-semibold text-foreground lg:top-0">
            {day}
          </h2>
          <RowList label={`Activity, ${day}`}>
            {rows.map((event) => (
              <EventRow
                key={event.key}
                event={event}
                layout={filter.everyStep ? 'step' : 'job'}
                fresh={fresh.has(event.key)}
              />
            ))}
          </RowList>
        </section>
      ))}
      {hasNextPage && (
        <Button
          variant="secondary"
          className="justify-self-center"
          busy={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          Show older activity
        </Button>
      )}
    </>
  )
}
