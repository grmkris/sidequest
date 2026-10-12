import type { McpTool } from './mcp.ts'
import { hiringHtml } from './generated/hiring.ts'

// A breaking App contract gets ui://sidequest/hiring/v2.html; this URI is a host cache key.
export const HIRING_URI = 'ui://sidequest/hiring/v1.html'
export const hiringResource = {
  uri: HIRING_URI,
  mimeType: 'text/html;profile=mcp-app',
  text: hiringHtml,
  _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } },
}
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
const _meta = {
  ui: { resourceUri: HIRING_URI },
  'openai/outputTemplate': HIRING_URI,
  'openai/toolInvocation/invoking': 'Reading hiring activity',
  'openai/toolInvocation/invoked': 'Hiring activity ready',
}
export const hiringTools: Record<string, McpTool> = {
  show_hiring_dashboard: {
    title: 'Hiring desk',
    description:
      'Read your requests and created hires, grouped by stage. Funding comes from chain state; operation state is separate. Works as complete text without the App.',
    inputSchema: { type: 'object', properties: {} },
    annotations,
    _meta,
  },
  show_task: {
    title: 'Hire details',
    description:
      'Read frozen terms, chain state, parties, deadlines, quotes and submitted delivery beside acceptance criteria. The next actor is derived by the server. App buttons use the existing separately granted write tools.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
    annotations,
    _meta,
  },
}

type Row = Record<string, unknown>
const row = (value: unknown): Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : {}
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.map(row) : [])
type Read = (name: string, args: Row, agentId: string) => Promise<unknown>

/** An open request's dashboard group: accepting quotes; quotes closed, so the creator picks before delivery; or expired. */
function requestGroup(status: string): string {
  if (status.startsWith('Accepting')) return 'accepting quotes'
  if (status.startsWith('Expired')) return 'finished'
  return 'needs your action'
}

/** Public display data only. Never forward grants, signatures, headers or arbitrary nested metadata to the App. */
function termsView(value: unknown) {
  const v = row(value)
  return {
    title: v.title,
    brief: v.brief,
    acceptanceCriteria: v.acceptanceCriteria,
    rewardAsset: v.token,
    reward: v.reward,
    creatorBond: v.creatorBond,
    workerBond: v.workerBond,
    creator: v.creator,
    approver: v.approver,
    arbitrator: v.arbitrator,
    deliveryDeadline: v.deliveryDeadline,
    windows: safe(v.windows),
    deliverable: safe(v.deliverable),
    executionBudget: safe(v.executionBudget),
  }
}

/** Rename asset keys; omit secret-shaped keys and signing material even in worker-supplied descriptors. */
export function safe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safe)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const assetKey = key === 'token' ? 'assetAddress' : key === 'tokens' ? 'acceptedAssets' : undefined
      if (assetKey !== undefined) return [[assetKey, safe(entry)]]
      if (/token|secret|password|authorization|cookie|private.?key|api.?key|signature|typedData|delegation/i.test(key))
        return []
      return [[key, safe(entry)]]
    }),
  )
}

function taskView(v: Row) {
  return {
    taskId: v.taskId,
    title: v.title,
    rewardAsset: v.token,
    reward: v.reward,
    amountUnit: 'base units',
    creator: v.creator,
    worker: row(v.chain).provider,
    approver: v.approver,
    arbitrator: v.arbitrator,
    creatorBond: v.creatorBond,
    workerBond: v.workerBond,
    windows: safe(v.windows),
    deliveryDeadline: v.deliveryDeadline,
    termsHash: v.termsHash,
    chain: safe(v.chain),
    nextAction: safe(v.nextAction),
    funding: safe(v.funding),
    operationStatus: v.operationStatus,
    quotesCount: v.quotesCount,
    you: safe(v.you),
    terms: termsView(v.terms),
    deliverables: safe(v.deliverables),
    onchainSubmission: safe(v.onchainSubmission),
  }
}

/** Render tools aggregate reads under the same agent/resource/board; they cannot enter the executor's write path. */
export async function renderHiring(name: string, args: Row, agentId: string, call: Read): Promise<unknown> {
  const read = async (tool: string, input: Row = {}) => {
    const reply = row(await call(tool, input, agentId))
    if (reply.ok !== true) throw new Error(String(reply.message ?? `${tool} unavailable`))
    return reply.result
  }
  const requests: Row[] = []
  let cursor: unknown
  // Bound the dashboard; preserve the continuation so history is never silently reported as complete.
  for (let page = 0; page < 4; page++) {
    const reply = row(await read('list_quote_requests', { mine: true, ...(cursor === undefined ? {} : { cursor }) }))
    requests.push(...rows(reply.requests))
    cursor = reply.nextCursor
    if (cursor === undefined) break
  }
  const enrichRequest = async (request: Row) => ({
    ...termsView(request),
    requestId: request.requestId,
    taskId: request.taskId,
    status: request.status,
    quoteDeadline: request.quoteDeadline,
    funding: { state: 'not-escrowed', source: 'chain' },
    quotes: safe(row(await read('list_quotes', { requestId: request.requestId })).quotes),
  })
  if (name === 'show_hiring_dashboard') {
    const tasks = rows(await read('list_tasks', { role: 'creator', limit: 50 })).map(taskView)
    const openRequests = await Promise.all(requests.filter((v) => v.taskId === null).map(enrichRequest))
    const groups: Record<string, unknown[]> = {
      'accepting quotes': [],
      'needs your action': [],
      'in progress': [],
      review: [],
      finished: [],
    }
    for (const request of openRequests) groups[requestGroup(String(request.status))]!.push(request)
    for (const task of tasks) {
      const state = row(task.chain).status
      const stage = ['completed', 'rejected', 'cancelled', 'expired'].includes(String(state))
        ? 'finished'
        : ['submitted', 'rejected-pending', 'disputed'].includes(String(state))
          ? 'review'
          : ['creator', 'anyone'].includes(String(row(task.nextAction).actor))
            ? 'needs your action'
            : 'in progress'
      groups[stage]!.push(task)
    }
    return {
      ok: true,
      result: {
        view: 'dashboard',
        groups,
        requestHistory: safe(requests.map((v) => ({ requestId: v.requestId, taskId: v.taskId, status: v.status }))),
        ...(cursor === undefined ? {} : { nextRequestCursor: cursor }),
        hireLimit: 50,
      },
    }
  }
  if (typeof args.taskId !== 'string' || args.taskId === '') throw new Error('taskId is required')
  const task = row(await read('get_task', { taskId: args.taskId }))
  const linked = requests.find((v) => v.taskId === args.taskId)
  const applications =
    Array.isArray(task.you) && task.you.includes('creator')
      ? safe(await read('list_applications', { taskId: args.taskId }))
      : []
  return {
    ok: true,
    result: {
      view: 'task',
      task: {
        ...taskView(task),
        applications,
        quotes:
          linked === undefined ? [] : safe(row(await read('list_quotes', { requestId: linked.requestId })).quotes),
      },
    },
  }
}
