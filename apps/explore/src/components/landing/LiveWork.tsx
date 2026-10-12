import { publicKey } from '../../queries.ts'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { LoadingRows } from '../kit.tsx'
import { EventRow } from '../activity/EventRow.tsx'
import { RowList } from '../activity/StretchedRow.tsx'
import { type ActivityFeed, useActivityFeed } from '../activity/useActivityFeed.ts'
import { data } from '../../api.ts'
import { chain } from '../../wallet.ts'
import { SectionHeading } from './landing-shared.tsx'
import { boardActivityText, landingEvents } from './live-work.ts'

/**
 * The latest of Activity: indexed chain steps and open requests only; illustrative cards never enter this section.
 * Hidden while the board has nothing to show (a new network), so the landing never leads with an empty board.
 */
export function LiveWork() {
  const feed = useActivityFeed()
  const { jobs } = feed
  const read = !jobs.loading && !feed.steps.isPending && !jobs.chainUnavailable
  if (read && landingEvents(feed.events, jobs.items, feed.now).length === 0) return null
  return (
    <section className="landing-live-work">
      <div className="landing-live-heading">
        <SectionHeading kicker="Live on the board" title="Work happening here." />
        <Link to="/jobs" className="landing-text-link">
          All activity <ArrowRight aria-hidden="true" />
        </Link>
      </div>
      <LatestEvents feed={feed} />
      {jobs.chainError !== null && !jobs.chainUnavailable && (
        <Alert variant="destructive">
          <AlertDescription>Showing last-known chain records. The latest read failed.</AlertDescription>
        </Alert>
      )}
      <BoardLine indexedThrough={jobs.index === null ? null : jobs.index.next_block - 1} />
    </section>
  )
}

function LatestEvents({ feed }: { feed: ActivityFeed }) {
  const { jobs, steps } = feed
  if (jobs.chainUnavailable)
    return (
      <Alert variant="destructive">
        <AlertDescription>Chain discovery is unavailable. Job status cannot be confirmed.</AlertDescription>
      </Alert>
    )
  if (jobs.loading || steps.isPending) return <LoadingRows rows={3} />
  const latest = landingEvents(feed.events, jobs.items, feed.now)
  return (
    <RowList label="Latest activity">
      {latest.map((event) => (
        <EventRow key={event.key} event={event} />
      ))}
    </RowList>
  )
}

interface BoardNumbers {
  jobs: number
  completed: number
  agents: number
}

function BoardLine({ indexedThrough }: { indexedThrough: number | null }) {
  const stats = useQuery({
    queryKey: publicKey('landing-stats'),
    queryFn: () => data<BoardNumbers>('stats'),
    refetchInterval: 60000,
  })
  const parts = [
    stats.data === undefined ? null : boardActivityText(stats.data.completed, stats.data.agents),
    chain.testnet ? 'testnet activity included' : null,
    indexedThrough === null ? null : `indexed through block ${indexedThrough.toLocaleString()}`,
  ].filter((part) => part !== null)
  return <p className="landing-caption tabular-nums">{parts.join(' · ')}</p>
}
