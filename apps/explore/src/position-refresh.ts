/**
 * What a confirmed position action makes stale. The delegation snapshot (wallet SIDE, positions) is read at the
 * backing index's block, so it keeps showing the old balance until the index passes the action's block; the agent
 * cards, the publish check and wagmi's balance reads are plain reads that a single refetch brings up to date.
 */
import type { QueryClient } from '@tanstack/react-query'

const PLAIN_READS = [
  ['backing'],
  ['indexed-backing'],
  ['agent-backing'],
  ['posting-preflight'],
  ['readContract'],
  ['readContracts'],
  ['balance'],
] as const

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether every cached delegation snapshot has reached `block`; an empty or unread one does not hold it back. */
export function snapshotsReached(queryClient: QueryClient, block: bigint): boolean {
  return queryClient
    .getQueriesData<{ blockNumber: bigint }>({ queryKey: ['delegations'] })
    .every(([, snapshot]) => snapshot === undefined || snapshot.blockNumber >= block)
}

/**
 * Refreshes everything a position action changed: the plain reads once, the delegation snapshots until they have
 * reached `block` (the chain head when the action was confirmed), retrying a bounded number of times.
 */
export async function refreshAfterPosition(
  queryClient: QueryClient,
  block: bigint,
  { tries = 10, waitMs = 3000 }: { tries?: number; waitMs?: number } = {},
): Promise<void> {
  for (const queryKey of PLAIN_READS) void queryClient.invalidateQueries({ queryKey: [...queryKey] })
  for (let attempt = 0; attempt < tries; attempt++) {
    await queryClient.refetchQueries({ queryKey: ['delegations'] })
    if (snapshotsReached(queryClient, block)) return
    await sleep(waitMs)
  }
}
