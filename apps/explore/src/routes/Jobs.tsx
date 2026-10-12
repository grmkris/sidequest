import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '../components/ui/empty.tsx'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { ItemGroup, Item, ItemTitle, ItemContent, ItemActions } from '../components/ui/item.tsx'
import { LoadingRows, Segmented, shortAddress } from '../components/kit.tsx'
import type { Phase } from '@sidequest/react'
import { JOB_TAG_LABELS, type JobTag } from '@sidequest/sdk'
import { useQueries, useQuery } from '@tanstack/react-query'
import { BriefcaseBusiness, Check, ChevronRight, Tag as TagIcon, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { type QuoteRequest, type TaskIndexEntry, chainJobs, currentBoardId, fetchDirectory, taskIndex } from '../api.ts'
import { BoardLink, boardRoutes } from '../components/BoardLink.tsx'
import { PhaseBadge } from '../components/Phase.tsx'
import { IndexLine, ReadNotice, SearchBox, TagChips, readTags } from '../components/JobFilters.tsx'
import { JobsHeader } from '../components/JobsHeader.tsx'
import { NeedsYou } from '../components/NeedsYou.tsx'
import { useMinute } from '../components/Time.tsx'
import { RollingCountdown } from '../components/RollingCountdown.tsx'

import { useAuth } from '../components/Wallet.tsx'
import { AgentOrb } from '../components/agent/AgentOrb.tsx'
import { AgentLabel } from '../components/agent/AgentChip.tsx'
import { TokenAmount } from '../components/token/TokenAmount.tsx'
import { relative } from '../format.ts'
import {
  type JobListItem,
  type View,
  jobTarget,
  postedAt,
  postedJustNow,
  posterOf,
  rowCountdown,
  rowKey,
  rowPhase,
  sortRows,
  tagsOf,
  titleOf,
  viewOf,
} from '../job-list.ts'
import { useManagedAgents } from '../managed.ts'
import { useQuoteRequests } from '../quote-requests.ts'
import { useToken } from '../useTokens.ts'
import { HostedBy } from '../job-offer.tsx'
import { useReplaceSearch } from '../page-search.ts'

export type { JobListItem } from '../job-list.ts'

/** Stable, so useQueries keeps the combined array until one of the lists changes. */
const dataOf = (
  results: { data?: TaskIndexEntry[] | undefined; error: Error | null; refetch: () => Promise<unknown> }[],
) => results.map((result) => ({ data: result.data, error: result.error, refetch: result.refetch }))

export function useJobs() {
  const tasks = useQuery({
    queryKey: ['task_index', currentBoardId()],
    queryFn: () => taskIndex(),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })
  const boardId = currentBoardId()
  const chain = useQuery({
    queryKey: ['chain-jobs', boardId],
    queryFn: () => chainJobs(boardId),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })
  // The public list also shows jobs published on other boards; their titles and board state come from those boards.
  const others = useMemo(
    () =>
      [
        ...new Set(
          (chain.data?.jobs ?? []).flatMap((c) => (c.board_id != null && c.board_id !== boardId ? [c.board_id] : [])),
        ),
      ].toSorted(),
    [chain.data, boardId],
  )
  const otherData = useQueries({
    queries: others.map((id) => ({
      queryKey: ['task_index', id],
      queryFn: () => taskIndex(id),
      refetchInterval: 60_000,
    })),
    combine: dataOf,
  })
  const items = useMemo(() => {
    const byJob = new Map<string, JobListItem>()
    for (const c of chain.data?.jobs ?? []) byJob.set(c.job_id, { jobId: c.job_id, chain: c, task: undefined })
    const out: JobListItem[] = []
    for (const t of tasks.data ?? []) {
      if (t.jobId !== null && byJob.has(t.jobId)) (byJob.get(t.jobId) as JobListItem).task = t
      // Awaiting publish, or published but not indexed yet (the indexer reads finalized blocks once a minute).
      else out.push({ jobId: t.jobId, task: t, chain: undefined })
    }
    others.forEach((id, i) => {
      for (const t of otherData[i]?.data ?? []) {
        const row = t.jobId === null ? undefined : byJob.get(t.jobId)
        if (row !== undefined && row.chain?.board_id === id) row.task = t
      }
    })
    return [...byJob.values(), ...out].toSorted((a, b) => Number(b.jobId ?? 1e9) - Number(a.jobId ?? 1e9))
  }, [tasks.data, chain.data, others, otherData])
  return {
    items,
    index: chain.data?.index ?? null,
    loading: tasks.isLoading || chain.isLoading,
    error: tasks.error ?? chain.error,
    chainError: chain.error,
    boardError: tasks.error ?? otherData.find((result) => result.error !== null)?.error ?? null,
    chainReady: chain.data !== undefined,
    chainUpdatedAt: chain.dataUpdatedAt,
    chainUnavailable: chain.error !== null && chain.data === undefined,
    refetch: async () => {
      await Promise.all([tasks.refetch(), chain.refetch(), ...otherData.map((result) => result.refetch())])
    },
  }
}

/** The row's second line beside its badge: the step waiting, in a few words. Deadlines are the countdown's. */
function rowNote(phase: Phase | null, agentId: string | null | undefined): string {
  if (phase === null) return ''
  const counting = rowCountdown(phase) !== null
  switch (phase.key) {
    case 'hire-open':
      return 'Taking applications'
    case 'active':
      return counting ? '' : 'Under way'
    case 'in-review':
      return counting ? 'Pays itself if no answer' : 'Waiting for the approver'
    case 'rejected-pending':
      return counting ? '' : 'The agent may dispute'
    case 'disputed':
      return counting ? '' : 'With the arbitrator'
    case 'overdue':
    case 'rejection-final':
    case 'arbitration-lapsed':
      return 'Anyone can close it'
    case 'accepted-by-silence':
      return 'Anyone can release the payment'
    case 'hire-lapsed':
      return 'The creator can cancel for a refund'
    case 'completed':
      return agentId != null ? `Worker #${agentId} paid` : 'Paid'
    case 'draft':
      return 'Only you can see this'
    default:
      return ''
  }
}

/** The hosted or listed agent behind each poster wallet this viewer can name: its own agents, then the directory. */
export function usePosterAgents(): Map<string, string> {
  const managed = useManagedAgents()
  const directory = useQuery({ queryKey: ['directory-first'], queryFn: () => fetchDirectory(), staleTime: 300_000 })
  return useMemo(() => {
    const byWallet = new Map<string, string>()
    for (const a of directory.data?.agents ?? []) byWallet.set(a.wallet.toLowerCase(), a.agentId)
    for (const a of managed.data?.agents ?? [])
      if (a.address !== null && a.agent_id !== null) byWallet.set(a.address.toLowerCase(), a.agent_id)
    return byWallet
  }, [managed.data, directory.data])
}

function readView(): { view: View; q: string; tags: JobTag[] } {
  const p = new URLSearchParams(window.location.search)
  const v = p.get('view')
  return {
    view: v === 'open' || v === 'progress' || v === 'done' || v === 'mine' ? v : 'all',
    q: p.get('q') ?? '',
    tags: readTags(p.get('tags')),
  }
}

export function JobsPage() {
  const {
    items: jobItems,
    index,
    loading,
    error,
    chainError,
    boardError,
    chainReady,
    chainUpdatedAt,
    chainUnavailable,
    refetch,
  } = useJobs()
  const requests = useQuoteRequests()
  const posters = usePosterAgents()
  const { address } = useAuth()
  const minute = useMinute()
  const [{ view, q, tags }, setFilter] = useState(readView)
  // Filters live in the URL, so a link or a reload keeps them.
  const replaceSearch = useReplaceSearch()
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    if (view === 'all') p.delete('view')
    else p.set('view', view)
    if (q === '') p.delete('q')
    else p.set('q', q)
    if (tags.length === 0) p.delete('tags')
    else p.set('tags', tags.toSorted().join(','))
    const s = p.toString()
    replaceSearch(s === '' ? '' : `?${s}`)
  }, [view, q, tags])

  const me = address?.toLowerCase()
  const rows = useMemo(() => {
    // A picked request is its job now; the job row stands for it.
    const open: JobListItem[] = (requests.data ?? [])
      .filter((r) => r.taskId == null)
      .map((request) => ({ jobId: null, task: undefined, chain: undefined, request }))
    return sortRows(
      [...jobItems, ...open]
        // An offer never published is a draft: nothing is escrowed, so only its creator sees it.
        .filter(
          (i) =>
            i.request !== undefined || i.jobId !== null || (me !== undefined && i.task?.creator.toLowerCase() === me),
        )
        .map((i) => ({ item: i, phase: rowPhase(i, address, minute) })),
    )
  }, [jobItems, requests.data, me, address, minute])
  // The Live strip names jobs and their posters from the records this list already holds.
  const mine = (i: JobListItem) =>
    me !== undefined &&
    [i.request?.creator, i.chain?.creator, i.chain?.approver, i.chain?.worker, i.task?.creator, i.task?.approver].some(
      (a) => a?.toLowerCase() === me,
    )
  const counts = { all: rows.length, open: 0, progress: 0, done: 0, mine: 0 }
  for (const r of rows) {
    const category = viewOf(r.phase)
    if (category !== null) counts[category]++
    if (mine(r.item)) counts.mine++
  }
  const needle = q.trim().toLowerCase()
  const shown = rows.filter(
    (r) =>
      (view === 'all' || (r.phase !== null && (view === 'mine' ? mine(r.item) : viewOf(r.phase) === view))) &&
      (needle === '' || titleOf(r.item).toLowerCase().includes(needle) || r.item.jobId === needle.replace(/^#/, '')) &&
      (tags.length === 0 || tags.some((tag) => tagsOf(r.item).includes(tag))),
  )
  const views: Array<readonly [View, string]> = [
    ['all', 'All'],
    ['open', 'Open'],
    ['progress', 'Under way'],
    ['done', 'Done'],
    ...(address !== undefined ? [['mine', 'Mine'] as const] : []),
  ]

  return (
    <>
      <JobsHeader title="Jobs" />

      <div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] md:items-center">
        <SearchBox value={q} onChange={(value) => setFilter({ view, q: value, tags })} />
        <Segmented
          label="Which jobs"
          value={view}
          onChange={(v) => setFilter({ view: v, q, tags })}
          options={views.map(
            ([v, l]) =>
              [
                v,
                <span key={v} className="whitespace-nowrap">
                  {l} <span className="tabular-nums text-muted-foreground">{chainReady ? counts[v] : '—'}</span>
                </span>,
              ] as const,
          )}
        />
      </div>
      <TagChips tags={tags} onChange={(next) => setFilter({ view, q, tags: next })} />

      <ReadNotice
        chainError={chainError}
        boardError={boardError}
        chainReady={chainReady}
        chainUpdatedAt={chainUpdatedAt}
        onRetry={() => void refetch()}
      />

      {chainUnavailable ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Chain jobs are unavailable</EmptyTitle>
            <EmptyDescription>
              The board list is available, but chain status and counts are not. Retry when the chain index is reachable.
              <Button size="default" variant="secondary" onClick={() => void refetch()}>
                Retry chain data
              </Button>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : error !== null && jobItems.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Jobs are unavailable</EmptyTitle>
            <EmptyDescription>
              <Alert variant="destructive">
                <AlertDescription>{(error as Error).message}</AlertDescription>
              </Alert>
              <Button size="default" variant="secondary" onClick={() => void refetch()}>
                Retry
              </Button>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : loading ? (
        <LoadingRows rows={6} />
      ) : shown.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {needle !== '' || tags.length > 0
                ? 'No jobs match'
                : view === 'mine'
                  ? 'Nothing of yours yet'
                  : view === 'open'
                    ? 'Nothing taking quotes right now'
                    : 'No jobs here yet'}
            </EmptyTitle>
            <EmptyDescription>
              {needle !== '' || tags.length > 0
                ? 'Try fewer tags or a different search.'
                : 'Work appears here when an agent asks for quotes. The line above is what to tell yours.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {view === 'mine' && <NeedsYou rows={shown} />}

          <ItemGroup>
            {shown.map(({ item, phase }) => (
              <JobRow
                key={rowKey(item)}
                item={item}
                phase={phase}
                now={minute}
                posterAgent={item.request?.creatorAgentId ?? posters.get(posterOf(item)?.toLowerCase() ?? '') ?? null}
                note={phase === null ? 'Status unavailable · retry chain data' : rowNote(phase, item.chain?.agent_id)}
              />
            ))}
          </ItemGroup>
        </>
      )}

      <IndexLine chainReady={chainReady} index={index}>
        Jobs whose offers are not found on known boards show as “Job #N”.
      </IndexLine>
    </>
  )
}

/** "3 quotes", "No quotes yet": public counts only, never amounts or bidders. */
const quotesText = (r: QuoteRequest) => {
  const n = r.quotesCount ?? 0
  return n === 0
    ? r.status?.startsWith('Accepting') === true
      ? 'No quotes yet'
      : 'No quotes'
    : `${n} quote${n === 1 ? '' : 's'}`
}

/**
 * One row of work: what it is and where it stands, its price and live countdown in the right column, and who posted
 * it when. A quote request shows its public budget and how many agents quoted; a job its escrowed reward.
 */
export function JobRow({
  item,
  phase,
  note,
  now,
  posterAgent = null,
}: {
  item: JobListItem
  phase: Phase | null
  note: string
  now?: number
  posterAgent?: string | null
}) {
  const routes = boardRoutes()
  const request = item.request
  const agentId = item.chain?.agent_id
  const reward = request?.budget?.max ?? item.chain?.reward ?? item.task?.reward
  const token = request?.budget?.token ?? item.chain?.token ?? item.task?.token
  const meta = useToken(token)
  const priced = request === undefined || request.budget !== undefined
  // Inside the row's link the chip is plain (no popover button nested in a link); a long symbol may wrap in the row.
  const price = !priced ? (
    <span className="font-normal text-muted-foreground">Open budget</span>
  ) : meta === 'reading' ? (
    'Reading token…'
  ) : meta === 'none' ? (
    'Token unavailable'
  ) : (
    <>
      {request !== undefined && <span className="text-ui font-normal text-muted-foreground">Up to </span>}
      <TokenAmount value={reward} token={token} static className="whitespace-normal" />
    </>
  )
  const other =
    routes.boardId === 'public' && item.chain?.board_id != null && item.chain.board_id !== 'public'
      ? item.chain.board_id
      : null
  const target = jobTarget(item, routes.boardId)
  const countdown = rowCountdown(phase)
  const posted = postedAt(item)
  const poster = posterOf(item)
  const tags = tagsOf(item)
  const screened = (request === undefined ? item.task?.screening?.verdict : undefined) === 'reject'
  return (
    <Item className="items-start py-3 active:bg-muted sm:items-center" render={<BoardLink target={target} />}>
      {request !== undefined ? (
        // Not hired yet: an open ring, where a job shows its worker's orb.
        <span className="grid size-10 shrink-0 place-items-center rounded-full border border-dashed border-muted-foreground/45 text-muted-foreground">
          <TagIcon aria-hidden className="size-4" />
        </span>
      ) : agentId != null && agentId !== '0' ? (
        <AgentOrb agentId={agentId} />
      ) : (
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-muted-foreground">
          {item.task?.quoted === true ? (
            <TagIcon aria-hidden className="size-[1.1rem]" />
          ) : (
            <BriefcaseBusiness aria-hidden className="size-[1.1rem]" />
          )}
        </span>
      )}
      {/* One grid: on a phone the price and countdown are a line under the badges; wider, they are the right column. */}
      <ItemContent className="grid min-w-0 flex-1 grid-cols-1 gap-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-6">
        <ItemTitle className="block truncate font-medium sm:col-start-1 sm:row-start-1">
          {titleOf(item) || `Job #${item.jobId}`}
        </ItemTitle>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui text-muted-foreground sm:col-start-1 sm:row-start-2">
          <PhaseBadge phase={phase} />
          {tags.map((tag) => (
            <Badge key={tag} variant="neutral">
              {JOB_TAG_LABELS[tag]}
            </Badge>
          ))}
          {other !== null && <Badge variant="info">{other}</Badge>}
          <HostedBy origin={item.chain?.foreign_offer?.origin} />
          {request === undefined && item.task === undefined && item.chain?.foreign_offer === undefined && (
            <span>offer not found on known boards</span>
          )}
          {screened && <Badge variant="warning">Screener flagged</Badge>}
          {request !== undefined && <span className="tabular-nums">{quotesText(request)}</span>}
          {note !== '' && <span className="truncate">{note}</span>}
        </span>
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 sm:col-start-2 sm:row-span-3 sm:row-start-1 sm:flex-col sm:items-end sm:justify-center sm:self-center sm:text-right">
          <span className="tabular-nums whitespace-normal font-semibold [overflow-wrap:anywhere]">{price}</span>
          {countdown !== null ? (
            <span className="flex items-baseline gap-1 text-ui">
              <span className="text-muted-foreground">{countdown.verb}</span>
              <RollingCountdown to={countdown.to} passed={countdown.passed} />
            </span>
          ) : request === undefined ? (
            <span className="text-xs text-muted-foreground">{item.jobId !== null ? `#${item.jobId}` : 'Draft'}</span>
          ) : null}
        </span>
        {(posted !== null || poster !== null || request?.budgetCovered != null) && (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-ui text-muted-foreground sm:col-start-1 sm:row-start-3">
            {(posted !== null || poster !== null) && (
              <span className="min-w-0">
                {posted !== null &&
                  `Posted ${postedJustNow(posted, now ?? Math.floor(Date.now() / 1000)) ? 'just now' : relative(posted, now ?? Math.floor(Date.now() / 1000))}`}
                {poster !== null && (
                  <>
                    {posted !== null ? ' by ' : 'By '}
                    {posterAgent !== null ? (
                      <AgentLabel id={posterAgent} />
                    ) : (
                      <span className="font-mono text-xs">{shortAddress(poster)}</span>
                    )}
                  </>
                )}
              </span>
            )}
            {request?.budgetCovered === true && (
              <span className="inline-flex items-center gap-1 text-success-text">
                <Check aria-hidden className="size-3.5" />
                Budget covered
              </span>
            )}
            {request?.budgetCovered === false && (
              <span className="inline-flex items-center gap-1 text-warning-text">
                <TriangleAlert aria-hidden className="size-3.5" />
                Budget not covered
              </span>
            )}
          </span>
        )}
      </ItemContent>
      <ItemActions className="self-center">
        <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </ItemActions>
    </Item>
  )
}
