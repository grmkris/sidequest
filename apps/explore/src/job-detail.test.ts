import { describe, expect, it } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { jobAttribution, jobListingFallback, taskFromDetail, type FrozenTask } from './job-detail.ts'

const creator: `0x${string}` = '0x0000000000000000000000000000000000000001'
const token: `0x${string}` = '0x0000000000000000000000000000000000000002'

const detail: FrozenTask = {
  taskId: 'task-7',
  title: 'A targeted detail',
  mode: 'hire',
  stack: 'main',
  creator,
  approver: creator,
  deliveryDeadline: 1234,
  workerBond: '22',
  creatorBond: '11',
  reward: '99',
  token,
  termsHash: `0x${'ab'.repeat(32)}`,
  manifestUrl: '/offers/detail.json',
  screening: { verdict: 'clean', reasons: [] },
  creatorAgentId: '42',
  createdAt: 1200,
  deliverable: { accepts: ['git'] },
  terms: {
    brief: 'Read one task.',
    acceptanceCriteria: ['Only this task is read'],
    tags: ['research'],
    quote: {},
    evidencePolicy: { checks: ['ci'] },
    executionBudget: { kind: 'call', target: creator, function: 'run()', cap: '7', expiresAt: 1300 },
    windows: { reviewSeconds: 1, disputeSeconds: 2, arbitrationSeconds: 3 },
  },
}

describe('targeted job detail metadata', () => {
  it('uses indexed foreign-board attribution and never flashes a different cached offer', () => {
    const cached = taskFromDetail(detail, '7')!
    expect(jobAttribution('public', { boardId: 'other', taskId: cached.taskId }, cached)).toEqual({
      boardId: 'other',
      taskId: cached.taskId,
      local: undefined,
    })
    expect(jobAttribution('public', { boardId: 'public', taskId: 'replaced' }, cached).local).toBeUndefined()
    expect(jobAttribution('public', null, cached)).toEqual({ boardId: 'public', taskId: cached.taskId, local: cached })
  })
  it('reconstructs the task-index display shape from get_task frozen terms', () => {
    const task = taskFromDetail(detail, '7')
    expect(task).toMatchObject({
      taskId: 'task-7',
      jobId: '7',
      title: detail.title,
      quoted: true,
      creatorAgentId: '42',
      createdAt: 1200,
      requiredChecks: ['ci'],
      executionBudget: detail.terms.executionBudget,
      deliverable: detail.deliverable,
      tags: ['research'],
    })
  })

  it('keeps a cached local row when an older detail answer lacks optional metadata', () => {
    const cached = { ...taskFromDetail(detail, '7')!, title: 'cached title', creatorAgentId: 'old-agent' }
    const { creatorAgentId: _agent, createdAt: _created, ...withoutOptional } = detail
    const { tags: _tags, ...withoutTags } = detail.terms
    const older = { ...withoutOptional, terms: withoutTags }
    const task = taskFromDetail(older, '7', cached)
    expect(task?.title).toBe(detail.title)
    expect(task?.creatorAgentId).toBe('old-agent')
    expect(task?.createdAt).toBe(1200)
    expect(task?.tags).toEqual(['research'])
  })

  it('serves warm local metadata without discovery and scans only after attribution fails', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let reads = 0
    const cached = taskFromDetail(detail, '7')!
    const options = (enabled: boolean) => ({
      ...jobListingFallback('public', '7', enabled),
      queryFn: async () => {
        reads++
        return [{ ...cached, title: 'Refreshed offer' }]
      },
      staleTime: 0,
    })
    client.setQueryData(options(false).queryKey, [cached])
    const observer = new QueryObserver(client, options(false))
    const release = observer.subscribe(() => {})
    expect(observer.getCurrentResult().data?.title).toBe(detail.title)
    await Promise.resolve()
    expect(reads).toBe(0)
    observer.setOptions(options(true))
    await observer.refetch()
    expect(reads).toBeGreaterThan(0)
    expect(observer.getCurrentResult().data?.title).toBe('Refreshed offer')
    release()
    client.clear()
  })

  it('does not read a task index for an invalid job ID and separates board caches', () => {
    const client = new QueryClient()
    const options = jobListingFallback('public', 'invalid', true)
    expect(options.enabled).toBe(false)
    const local = jobListingFallback('public', '7', false)
    client.setQueryData(local.queryKey, [taskFromDetail(detail, '7')!])
    const other = new QueryObserver(client, jobListingFallback('other', '7', false))
    expect(other.getCurrentResult().data).toBeUndefined()
    client.clear()
  })

  it('keeps the local publication while indexed details are absent and discards a different cached task', () => {
    const cached = taskFromDetail(detail, '7')!
    expect(taskFromDetail(undefined, '7', cached)).toBe(cached)
    const { creatorAgentId: _agent, ...withoutAgent } = detail
    expect(taskFromDetail({ ...withoutAgent, taskId: 'other' }, '7', cached)?.creatorAgentId).toBeUndefined()
  })
})
