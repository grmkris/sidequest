/** Mutations refresh affected resource families; unrelated directory, profile and inbox reads stay warm. */
import type { QueryClient, QueryKey } from '@tanstack/react-query'

export const BALANCE_READS = [
  'balance',
  'readContract',
  'readContracts',
  'backing',
  'indexed-backing',
  'delegations',
  'agent-backing',
  'posting-preflight',
  'bond-funding',
  'collect_actions',
  'sponsor_status',
  'managed-agent-status',
] as const

export async function refreshFamilies(client: QueryClient, families: readonly string[]): Promise<void> {
  await client.invalidateQueries({ predicate: (query) => families.includes(String(query.queryKey[0])) })
}

export const refreshBalances = (client: QueryClient) => refreshFamilies(client, BALANCE_READS)

interface JobChange {
  boardId: string
  taskId?: string
  jobId?: string
}

function affectedJob(key: QueryKey, change: JobChange): boolean {
  const kind = key[0]
  if (
    ['chain-jobs', 'activity-feed', 'data-agents', 'data-agent', 'landing-stats', 'landing-numbers'].includes(
      String(kind),
    )
  )
    return true
  if (kind === 'task_index' || kind === 'list_quote_requests') return key[1] === change.boardId
  if (kind === 'job') return change.jobId === undefined || key[1] === change.jobId
  if (['get_task', 'applications', 'bundle', 'delivery-preview'].includes(String(kind)))
    return key[1] === change.boardId && (change.taskId === undefined || key[2] === change.taskId)
  return kind === 'collect_actions'
}

export async function refreshJob(client: QueryClient, change: JobChange): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ predicate: (query) => affectedJob(query.queryKey, change) }),
    refreshBalances(client),
  ])
}
