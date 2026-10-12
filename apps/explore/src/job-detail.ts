/** The public frozen metadata needed by JobPage, available in get_task without scanning the board's offers. */
import type { TaskIndexEntry } from './api.ts'
import { taskIndexQuery } from './queries.ts'

/** Indexed attribution wins over an old current-board cache, including while its get_task is loading. */
export function jobAttribution(
  current: string,
  indexed: { boardId: string; taskId: string } | null | undefined,
  cached: TaskIndexEntry | undefined,
) {
  const boardId = indexed?.boardId ?? current
  const taskId = indexed?.taskId ?? cached?.taskId
  const local = boardId === current && cached?.taskId === taskId ? cached : undefined
  return { boardId, taskId, local }
}

export interface FrozenTask {
  taskId: string
  title: string
  mode: 'hire'
  stack: string
  creator: TaskIndexEntry['creator']
  approver: TaskIndexEntry['approver']
  deliveryDeadline: number
  workerBond: string
  creatorBond: string
  reward: string
  token: TaskIndexEntry['token']
  termsHash: string
  manifestUrl: string
  screening: TaskIndexEntry['screening']
  deliverable?: TaskIndexEntry['deliverable']
  creatorAgentId?: string | null
  createdAt?: number
  terms: {
    brief?: string
    acceptanceCriteria?: string[]
    tags?: TaskIndexEntry['tags']
    quote?: unknown
    evidencePolicy?: { checks?: string[] }
    executionBudget?: TaskIndexEntry['executionBudget']
    windows?: { reviewSeconds: number; disputeSeconds: number; arbitrationSeconds: number }
  }
}

/** A detail answer's frozen offer, in the same shape BudgetPanel and the offer display already consume. */
export function taskFromDetail(
  task: FrozenTask | undefined,
  jobId: string,
  cached?: TaskIndexEntry,
): TaskIndexEntry | undefined {
  if (task === undefined) return cached
  const same = cached?.taskId === task.taskId ? cached : undefined
  return {
    ...same,
    taskId: task.taskId,
    jobId,
    kind: 'sidequest-v1',
    title: task.title,
    mode: task.mode,
    stack: task.stack,
    creator: task.creator,
    approver: task.approver,
    token: task.token,
    reward: task.reward,
    creatorBond: task.creatorBond,
    workerBond: task.workerBond,
    deliveryDeadline: task.deliveryDeadline,
    termsHash: task.termsHash,
    manifestUrl: task.manifestUrl,
    screening: task.screening,
    brief: task.terms.brief ?? '',
    acceptanceCriteria: task.terms.acceptanceCriteria ?? [],
    requiredChecks: task.terms.evidencePolicy?.checks ?? [],
    quoted: task.terms.quote != null,
    executionBudget: task.terms.executionBudget ?? null,
    ...(task.deliverable === undefined ? {} : { deliverable: task.deliverable }),
    ...(task.terms.tags === undefined ? {} : { tags: task.terms.tags }),
    ...(task.creatorAgentId === undefined ? {} : { creatorAgentId: task.creatorAgentId }),
    // Older APIs did not expose this field; the detail page does not display a posting time.
    createdAt: task.createdAt ?? same?.createdAt ?? 0,
  }
}

/** The current board can still place a local publication that the chain index has not attributed yet. */
export function jobListingFallback(boardId: string, jobId: string, enabled: boolean) {
  return {
    ...taskIndexQuery(boardId),
    enabled: enabled && /^\d+$/.test(jobId),
    select: (tasks: TaskIndexEntry[]) => tasks.find((task) => task.jobId === jobId),
    refetchInterval: enabled ? 10_000 : false,
    refetchIntervalInBackground: false,
  } as const
}
