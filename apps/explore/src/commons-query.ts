/**
 * Commons reads and writes over the board's REST tools. Every tool routes to the one Commons object whatever board the
 * page is on (a job thread's subject names its board), so the public board client serves them all. Threads poll every
 * 10 s; writes sign in first and then refresh what they changed.
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { currentBoardId, tool } from './api.ts'
import { anonymousCommonsTool } from './commons-access.ts'
import { useAuth } from './components/Wallet.tsx'
import type { Gap, GapDetail, GapFilters, GapStatus, Roadmap, RoadmapItemDetail, Roles, Thread } from './commons.ts'

const POLL_MS = 10_000

/** An infinite list's poll: every `ms` while one page is loaded, none once more are (each poll re-reads them all). */
export const firstPageOnly =
  (ms: number) =>
  (query: { state: { data?: { pages: readonly unknown[] } | undefined } }): number | false =>
    (query.state.data?.pages.length ?? 0) > 1 ? false : ms

const commonsKeys = {
  all: ['commons'] as const,
  thread: (subject: string, viewer: string | undefined) => ['commons', 'thread', subject, viewer ?? ''] as const,
  roadmap: (status: string, viewer: string | undefined) => ['commons', 'roadmap', status, viewer ?? ''] as const,
  item: (id: number, viewer: string | undefined) => ['commons', 'item', id, viewer ?? ''] as const,
  gaps: (filters: GapFilters, viewer: string | undefined) => ['commons', 'gaps', filters, viewer ?? ''] as const,
  gap: (id: number, viewer: string | undefined) => ['commons', 'gap', id, viewer ?? ''] as const,
  roleLog: (viewer: string | undefined) => ['commons', 'role-log', viewer ?? ''] as const,
  roles: (viewer: string | undefined) => ['commons', 'roles', viewer ?? ''] as const,
}

/** The viewer's identity in a query key: signed-in sessions see their own `viewer`, everyone else reads anonymously. */
function useViewerKey(): string | undefined {
  const auth = useAuth()
  return auth.signedIn ? auth.address?.toLowerCase() : undefined
}

const read = <T>(viewer: string | undefined, name: string, args: Record<string, unknown>) =>
  viewer === undefined ? anonymousCommonsTool<T>(currentBoardId(), name, args) : tool<T>(name, args)

export function useThread(subject: string, enabled = true) {
  const viewer = useViewerKey()
  return useQuery({
    queryKey: commonsKeys.thread(subject, viewer),
    queryFn: () => read<Thread>(viewer, 'list_messages', { subject, limit: 50 }),
    // A sign-in changes only the viewer key. Keep the public thread and composer mounted,
    // but never carry another viewer's posting permissions or another subject's messages.
    placeholderData: (previous) => (previous?.subject === subject ? { ...previous, viewer: null } : undefined),
    refetchInterval: POLL_MS,
    enabled,
  })
}

export function useRoadmap(status: string) {
  const viewer = useViewerKey()
  return useQuery({
    queryKey: commonsKeys.roadmap(status, viewer),
    queryFn: () => read<Roadmap>(viewer, 'list_roadmap', { status }),
    refetchInterval: 30_000,
  })
}

export function useRoadmapItem(itemId: number) {
  const viewer = useViewerKey()
  return useQuery({
    queryKey: commonsKeys.item(itemId, viewer),
    queryFn: () => read<RoadmapItemDetail>(viewer, 'get_roadmap_item', { itemId }),
    refetchInterval: 30_000,
  })
}

export function useGaps(filters: GapFilters = {}) {
  const viewer = useViewerKey()
  return useInfiniteQuery({
    queryKey: commonsKeys.gaps(filters, viewer),
    // SAFETY: the initial page has no cursor; following pages use the backend's string cursor.
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      read<{ gaps: Gap[]; cursor: string | null }>(viewer, 'list_gaps', {
        ...filters,
        limit: 50,
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
      }),
    getNextPageParam: (page) => page.cursor ?? undefined,
    // A refetch re-reads every loaded page: poll the first page only, and stop once the viewer has paged further.
    refetchInterval: firstPageOnly(60_000),
  })
}

export function useGap(gapId: number, enabled = true) {
  const viewer = useViewerKey()
  return useQuery({
    queryKey: commonsKeys.gap(gapId, viewer),
    queryFn: () => read<GapDetail>(viewer, 'list_gaps', { gapId }),
    enabled: enabled && Number.isSafeInteger(gapId) && gapId > 0,
    refetchInterval: 30_000,
  })
}

export function useRoleLog() {
  const viewer = useViewerKey()
  return useInfiniteQuery({
    queryKey: commonsKeys.roleLog(viewer),
    // SAFETY: the initial page has no cursor; following pages use the backend's string cursor.
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      read<Roles>(viewer, 'list_roles', { limit: 50, ...(pageParam === undefined ? {} : { cursor: pageParam }) }),
    getNextPageParam: (page) => (page.hasMore ? (page.cursor ?? undefined) : undefined),
    staleTime: 60_000,
  })
}

export function useRoles() {
  const viewer = useViewerKey()
  return useQuery({
    queryKey: commonsKeys.roles(viewer),
    queryFn: () => read<Roles>(viewer, 'list_roles', { limit: 50 }),
    staleTime: 60_000,
  })
}

/** A Commons write: sign in if needed, call the tool, then refresh every Commons query (they are cheap and few). */
function useCommonsWrite<A extends Record<string, unknown>, R>(name: string) {
  const auth = useAuth()
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (args: A) => {
      if (!auth.signedIn) await auth.signIn()
      return tool<R>(name, args)
    },
    onSuccess: () => client.invalidateQueries({ queryKey: commonsKeys.all }),
  })
}

export const usePost = () =>
  useCommonsWrite<{ subject: string; body: string; replyTo?: number; presentation?: unknown }, { notified: number }>(
    'post_message',
  )
export const useSupport = () => useCommonsWrite<{ itemId: number }, { activeSupports: number }>('support_item')
export const useWithdraw = () => useCommonsWrite<{ itemId: number }, { activeSupports: number }>('withdraw_support')
export const usePropose = () =>
  useCommonsWrite<
    { title: string; problem: string; proposal: string; gapIds?: number[] },
    { item: { id: number }; threadSubject: string }
  >('propose_item')

export const useGapStatus = () =>
  useCommonsWrite<{ gapId: number; status: GapStatus; reason: string }, { logSeq: number }>('set_gap_status')
export const useLinkGaps = () =>
  useCommonsWrite<{ itemId: number; gapIds: number[]; reason: string }, { logSeq: number }>('link_gaps')
export const useMergeGaps = () =>
  useCommonsWrite<
    { sourceGapId: number; targetGapId: number; reason: string },
    { gap: Gap; movedReports: number; logSeq: number }
  >('merge_gaps')
export const useGapModeration = (hidden: boolean) =>
  useCommonsWrite<{ kind: 'gap_report'; id: number; reason: string }, { logSeq: number }>(
    hidden ? 'unhide_content' : 'hide_content',
  )
