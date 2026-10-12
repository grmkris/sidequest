/**
 * Every job an agent took or posted, in one list, newest first: the Activity feed's rows (a sentence that says who did
 * what, the job's track, a small picture of the work, a card on press), read for the agent's wallet across every board.
 * A job of its record the feed cannot place (an older wallet's, say) follows as a plain row linking the job.
 */
import { taskIndexQuery, boardsQuery } from '../../queries.ts'
import { useQueries, useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { agentEvents, offFeedJobs } from '../../agent-stats.ts'
import type { ChainJob, TaskIndexEntry } from '../../api.ts'
import type { AgentRecord, RecordJob } from '../../routes/Agent.tsx'
import { EventRow } from '../activity/EventRow.tsx'
import { RowList } from '../activity/StretchedRow.tsx'
import { useActivityFeed } from '../activity/useActivityFeed.ts'
import { BoardLink, boardRoutes } from '../BoardLink.tsx'
import { LoadingRows, Section } from '../kit.tsx'
import { PhaseBadge, phaseOf } from '../Phase.tsx'
import { useNow } from '../Time.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'
import { Button } from '../ui/button.tsx'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../ui/item.tsx'
import { useAuth } from '../Wallet.tsx'

/** How many rows show before "Show all". */
const FIRST = 10

/** Every board's task index for the jobs shown, for titles; and the boards' names. */
function useTitles(jobs: readonly ChainJob[]) {
  const boards = useQuery({
    ...boardsQuery(),
    enabled: jobs.length > 0,
  })
  const ids = useMemo(() => [...new Set(jobs.map((j) => j.board_id ?? 'public'))], [jobs])
  const indexes = useQueries({
    queries: ids.map((b) => ({ ...taskIndexQuery(b), staleTime: 60_000 })),
  })
  const tasks = new Map<string, TaskIndexEntry>()
  for (const q of indexes) for (const t of q.data ?? []) if (t.jobId !== null) tasks.set(t.jobId, t)
  return { tasks, names: new Map((boards.data?.boards ?? []).map((b) => [b.id, b.name])) }
}

export function AgentJobs({ record, agentId, wallet }: { record: AgentRecord; agentId: string; wallet: string }) {
  const feed = useActivityFeed(wallet)
  const wallets = useMemo(
    () => [...new Set([wallet, ...record.wallets].map((w) => w.toLowerCase()))],
    [wallet, record.wallets],
  )
  const events = useMemo(() => agentEvents(feed.events, agentId, wallets), [feed.events, agentId, wallets])
  const loading = feed.jobs.loading || feed.steps.isPending
  const rest = loading ? [] : offFeedJobs(record, events)
  const [all, setAll] = useState(false)
  const total = events.length + rest.length
  const shown = all ? events : events.slice(0, FIRST)
  const restShown = all ? rest : rest.slice(0, Math.max(0, FIRST - shown.length))
  const count = record.jobs.length + (record.hiring?.posted ?? record.posted?.length ?? 0)
  return (
    <Section title={`Jobs · ${count}`}>
      {loading ? (
        <LoadingRows rows={3} />
      ) : (
        <>
          {shown.length > 0 && (
            <RowList label="Jobs">
              {shown.map((event) => (
                <EventRow key={event.key} event={event} layout="compact" />
              ))}
            </RowList>
          )}
          {restShown.length > 0 && <RecordRows jobs={restShown} />}
          {!all && total > shown.length + restShown.length ? (
            <Button variant="secondary" className="justify-self-center" onClick={() => setAll(true)}>
              Show all {total}
            </Button>
          ) : (
            all &&
            feed.steps.hasNextPage && (
              <Button
                variant="secondary"
                className="justify-self-center"
                busy={feed.steps.isFetchingNextPage}
                onClick={() => void feed.steps.fetchNextPage()}
              >
                Show older activity
              </Button>
            )
          )}
        </>
      )}
    </Section>
  )
}

/** Jobs of the record the feed could not place: title, where it stands, its board and reward, linking the job. */
function RecordRows({ jobs }: { jobs: readonly RecordJob[] }) {
  const { tasks, names } = useTitles(jobs)
  const { address } = useAuth()
  const minute = Math.floor(useNow() / 60) * 60
  return (
    <ItemGroup className="gap-0 overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      {jobs.map((j) => {
        const board = j.board_id ?? 'public'
        const task = tasks.get(j.job_id)
        return (
          <Item
            key={j.job_id}
            // A function, not an element: an element's own (empty) children would replace the row's.
            render={({ className, children }) => (
              <BoardLink target={boardRoutes(board).job(j.job_id)} className={className ?? ''}>
                {children}
              </BoardLink>
            )}
            className="rounded-none border-0 border-b border-border/70 last:border-b-0"
          >
            <ItemContent className="min-w-0">
              <ItemTitle className="w-full truncate">{task?.title ?? `Job #${j.job_id}`}</ItemTitle>
              <ItemDescription className="flex min-w-0 items-center gap-2">
                <PhaseBadge phase={phaseOf(j, task, address, minute)} />
                <span className="truncate">
                  #{j.job_id} · {board === 'public' ? 'Public board' : (names.get(board) ?? board)}
                </span>
              </ItemDescription>
            </ItemContent>
            <ItemActions className="gap-2">
              <TokenAmount value={j.reward} token={j.token} static className="font-medium" />
              <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        )
      })}
    </ItemGroup>
  )
}
