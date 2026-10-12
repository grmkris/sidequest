import { boardKey, viewerKey } from './queries.ts'
import { currentBoardId } from './api.ts'
import { useQuery } from '@tanstack/react-query'
import { tool } from './api.ts'

/** One event from the signed-in wallet's own feed (the `inbox` tool), as Explore shows it. */
export interface MyEvent {
  id: string
  kind: string
  occurredAt: number
  summary: string
  url?: string
  jobId: string | null
}

interface InboxPage {
  events: MyEvent[]
  cursor: string | null
  hasMore: boolean
}

/** At most this many pages (100 events each) are read for one view: a week of a busy wallet. */
const PAGES = 5

/**
 * The wallet's own events from the last week, newest first. The feed pages oldest first from a week back, so the pages
 * are read through and turned around; only the wallet's own rows, never the public new-work ones.
 */
export async function myEvents(read = (cursor: string | null) => readPage(cursor)): Promise<MyEvent[]> {
  const seen: MyEvent[] = []
  let cursor: string | null = null
  for (let page = 0; page < PAGES; page++) {
    const next = await read(cursor)
    seen.push(...next.events)
    if (!next.hasMore || next.cursor === null) break
    cursor = next.cursor
  }
  return seen.toReversed()
}

const readPage = (cursor: string | null) =>
  tool<InboxPage>('inbox', { includePublic: false, limit: 100, ...(cursor === null ? {} : { cursor }) })

export function useMyEvents(address: string | undefined, signedIn: boolean) {
  return useQuery({
    queryKey: boardKey(currentBoardId(), 'my-events', viewerKey(address, signedIn)),
    queryFn: () => myEvents(),
    enabled: signedIn && address !== undefined,
    refetchInterval: 60_000,
  })
}
