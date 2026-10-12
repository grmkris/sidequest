import { publicKey } from '../../queries.ts'
import { type InfiniteData, useInfiniteQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { type FeedEvent, type FeedJob, feedEvents, feedJobs } from '../../activity-feed.ts'
import { data } from '../../api.ts'
import type { ActivityStep } from '../../live-activity.ts'
import { useQuoteRequests } from '../../quote-requests.ts'
import { useJobs, usePosterAgents } from '../../routes/Jobs.tsx'
import { useMinute } from '../Time.tsx'
import { useAuth } from '../Wallet.tsx'

interface ActivityPage {
  steps: ActivityStep[]
  nextCursor: string | null
}

const activityPage = (cursor: string | undefined, wallet: string | undefined) =>
  data<ActivityPage>(
    `activity?limit=50${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}${
      wallet === undefined ? '' : `&wallet=${encodeURIComponent(wallet)}`
    }`,
  )

/**
 * The board's chain steps, newest first, a page of 50 at a time; with `wallet`, only the steps of jobs it posted,
 * approves or works. Only the first page polls: refetching an infinite query re-reads every loaded page in turn, so
 * once someone has loaded more, the list holds still until they reload.
 */
function useSteps(wallet: string | undefined) {
  return useInfiniteQuery<ActivityPage, Error, InfiniteData<ActivityPage>, readonly unknown[], string | undefined>({
    queryKey: publicKey('activity-feed', 'infinite', wallet?.toLowerCase()),
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => activityPage(pageParam, wallet),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: (query) => ((query.state.data?.pages.length ?? 0) > 1 ? false : 20_000),
    refetchIntervalInBackground: false,
  })
}

export interface ActivityFeed {
  jobs: ReturnType<typeof useJobs>
  steps: ReturnType<typeof useSteps>
  /** Every job and open request, newest activity first. */
  feed: FeedJob[]
  /** The loaded steps and the requests as events, newest first. */
  events: FeedEvent[]
  requestsError: Error | null
  /** Jobs, requests and the first page of steps have all answered: what is shown now is the board as it stands. */
  ready: boolean
  viewer: string | undefined
  now: number
}

/**
 * The Activity page's data: the jobs list's records, the board's requests and its chain steps, joined. A wallet's page
 * passes the wallet, so the steps it reads are that wallet's, however far back they go.
 */
export function useActivityFeed(wallet?: string): ActivityFeed {
  const jobs = useJobs()
  const requests = useQuoteRequests()
  const posters = usePosterAgents()
  const { address } = useAuth()
  const now = useMinute()
  const steps = useSteps(wallet)
  const loaded = useMemo(() => steps.data?.pages.flatMap((page) => page.steps) ?? [], [steps.data])
  const feed = useMemo(
    () => feedJobs({ items: jobs.items, requests: requests.data ?? [], steps: loaded, posters, viewer: address, now }),
    [jobs.items, requests.data, loaded, posters, address, now],
  )
  const events = useMemo(() => feedEvents(loaded, feed, steps.hasNextPage), [loaded, feed, steps.hasNextPage])
  const ready = !jobs.loading && steps.isSuccess && (requests.isSuccess || requests.isError)
  return { jobs, steps, feed, events, requestsError: requests.error, ready, viewer: address, now }
}

/**
 * Every job and request as the feed files them, without their steps: enough to say where each stands and who took
 * part, for a card or a record that needs no history. On Activity every read here is already cached.
 */
export function useFeedJobs(): { feed: FeedJob[]; loading: boolean } {
  const jobs = useJobs()
  const requests = useQuoteRequests()
  const posters = usePosterAgents()
  const { address } = useAuth()
  const now = useMinute()
  const feed = useMemo(
    () => feedJobs({ items: jobs.items, requests: requests.data ?? [], steps: [], posters, viewer: address, now }),
    [jobs.items, requests.data, posters, address, now],
  )
  return { feed, loading: jobs.loading }
}
