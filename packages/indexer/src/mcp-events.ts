import type { AsyncSql } from './store.ts'
import type { Network } from '@sidequest/sdk'
import { cursorOf, migrateFeed, parseCursor, readInbox, type InboxEvent } from './feed.ts'
import type { OAuthGrant } from './oauth-types.ts'
import { telegramChainId } from './telegram.ts'
import { EventRpcError, subscribeWebhook, unsubscribeWebhook, type WebhookFetch } from './webhooks.ts'

const objectSchema = (properties: Record<string, unknown> = {}) => ({
  type: 'object',
  properties,
  additionalProperties: false,
})
const payloadSchema = {
  type: 'object',
  required: ['id', 'kind', 'cursor', 'occurredAt', 'chainId', 'boardId', 'taskId', 'jobId', 'public', 'summary'],
  properties: {
    id: { type: 'string' },
    kind: { type: 'string' },
    cursor: { type: 'string' },
    occurredAt: { type: 'number' },
    chainId: { type: 'number' },
    boardId: { type: ['string', 'null'] },
    taskId: { type: ['string', 'null'] },
    jobId: { type: ['string', 'null'] },
    public: { type: 'boolean' },
    requestId: { type: 'string' },
    role: { type: 'string' },
    summary: { type: 'string' },
    url: { type: 'string' },
    next: { type: 'object' },
  },
}
const descriptors = [
  {
    name: 'sidequest.inbox',
    description:
      'Your job, quote, application and approval events. requestId follows a quote request through its linked hire.',
    inputSchema: objectSchema({
      kinds: { type: 'array', items: { type: 'string' }, maxItems: 20 },
      requestId: { type: 'string', minLength: 1 },
    }),
  },
  {
    name: 'sidequest.jobs',
    description: 'Your job transitions, deferred settlements and owed payouts.',
    inputSchema: objectSchema({ taskId: { type: 'string' } }),
  },
  { name: 'sidequest.approvals', description: 'Your approval decisions and permissions.', inputSchema: objectSchema() },
  { name: 'sidequest.requests', description: 'Public quote requests and published jobs.', inputSchema: objectSchema() },
].map((event) => ({ ...event, payloadSchema, delivery: ['poll', 'webhook'] }))

export function eventArguments(name: unknown, value: unknown): { name: string; args: Record<string, unknown> } {
  if (name === undefined) throw new EventRpcError(-32602, 'name is required: one of the events events/list returns')
  if (typeof name !== 'string' || !descriptors.some((event) => event.name === name))
    throw new EventRpcError(-32602, 'Unknown event name')
  const args = value === undefined ? {} : value
  if (typeof args !== 'object' || args === null || Array.isArray(args))
    throw new EventRpcError(-32602, 'Event arguments must be an object')
  const record = args as Record<string, unknown>
  const allowed = name === 'sidequest.inbox' ? ['kinds', 'requestId'] : name === 'sidequest.jobs' ? ['taskId'] : []
  if (Object.keys(record).some((key) => !allowed.includes(key)))
    throw new EventRpcError(-32602, 'Unknown event argument')
  if (record.taskId !== undefined && (typeof record.taskId !== 'string' || record.taskId.length === 0))
    throw new EventRpcError(-32602, 'taskId must be a nonempty string')
  if (record.requestId !== undefined && (typeof record.requestId !== 'string' || record.requestId.length === 0))
    throw new EventRpcError(-32602, 'requestId must be a nonempty string')
  if (
    record.kinds !== undefined &&
    (!Array.isArray(record.kinds) ||
      record.kinds.length > 20 ||
      !record.kinds.every((kind) => typeof kind === 'string' && /^[a-z]+\.[a-z_]+$/.test(kind)))
  )
    throw new EventRpcError(-32602, 'kinds must contain at most 20 feed kind names')
  // Kinds are a set: ordering and duplicate entries cannot create separate subscriptions.
  return {
    name,
    args:
      record.kinds === undefined
        ? { ...record }
        : { ...record, kinds: [...new Set(record.kinds as string[])].toSorted() },
  }
}

export function eventCursor(value: unknown): number | undefined {
  try {
    return parseCursor(value)
  } catch {
    throw new EventRpcError(-32602, 'Invalid event cursor')
  }
}

export function eventMaxAge(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new EventRpcError(-32602, 'maxAgeMs must be a nonnegative integer')
  return value
}

export function occurrence(name: string, event: InboxEvent) {
  return {
    eventId: `${name}:${event.id}`,
    name,
    timestamp: new Date(event.occurredAt * 1000).toISOString(),
    data: event,
    cursor: event.cursor,
  }
}

export async function eventPage(
  sql: AsyncSql,
  network: Network,
  principal: string,
  params: Record<string, unknown>,
  now: number,
  limit = 50,
) {
  const { name, args } = eventArguments(params.name, params.arguments)
  eventCursor(params.cursor)
  const maxAgeMs = eventMaxAge(params.maxAgeMs)
  const page = await readInbox(sql, {
    network,
    address: principal.toLowerCase(),
    cursor: params.cursor,
    scope: name === 'sidequest.requests' ? 'public' : 'own',
    ...(name === 'sidequest.inbox'
      ? { kinds: args.kinds, ...(typeof args.requestId === 'string' ? { requestId: args.requestId } : {}) }
      : {}),
    ...(name === 'sidequest.jobs'
      ? {
          kinds: ['settlement.deferred', 'payout.owed'],
          kindPrefixes: ['job.'],
          ...(typeof args.taskId === 'string' ? { taskId: args.taskId } : {}),
        }
      : {}),
    ...(name === 'sidequest.approvals' ? { kindPrefixes: ['approval.', 'permission.'] } : {}),
    ...(name === 'sidequest.requests' ? { kinds: ['request.opened', 'request.picked', 'job.published'] } : {}),
    ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
    limit,
    now,
  })
  return { ...page, events: page.events.map((event) => occurrence(name, event)) }
}

/**
 * Where a subscription or poll starts. An explicit `cursor: null` means "from now" (SEP-3415): nothing older is
 * delivered. Without a cursor it starts before the first selected row, so subscribing never consumes its backlog.
 */
export async function eventStart(
  sql: AsyncSql,
  network: Network,
  principal: string,
  params: Record<string, unknown>,
  now: number,
) {
  await migrateFeed(sql)
  // Capture the empty-feed fallback before reading, so a concurrent append cannot be silently consumed.
  const [last] = await sql.all<{ seq: number | null }>(
    'SELECT max(seq) AS seq FROM feed_events WHERE chain_id = ?',
    telegramChainId(network),
  )
  if (params.cursor === null) return { seq: last?.seq ?? 0, truncated: false }
  const page = await eventPage(sql, network, principal, params, now, 1)
  const after = eventCursor(params.cursor)
  if (after !== undefined) return { seq: after, truncated: page.gap }
  const first = page.events[0]
  if (first !== undefined) return { seq: eventCursor(first.cursor)! - 1, truncated: false }
  return { seq: last?.seq ?? 0, truncated: false }
}

/** One poll: an explicit null cursor answers no events and the head cursor (SEP-3415), else the next page. */
async function pollEvents(
  sql: AsyncSql,
  network: Network,
  principal: string,
  params: Record<string, unknown>,
  now: number,
) {
  if (params.cursor === null) {
    eventArguments(params.name, params.arguments)
    const head = await eventStart(sql, network, principal, params, now)
    return { events: [], cursor: cursorOf(head.seq), truncated: false, hasMore: false, nextPollMs: 60_000 }
  }
  if (
    params.maxEvents !== undefined &&
    (typeof params.maxEvents !== 'number' || !Number.isSafeInteger(params.maxEvents) || params.maxEvents < 1)
  )
    throw new EventRpcError(-32602, 'maxEvents must be a positive integer')
  const page = await eventPage(sql, network, principal, params, now, Math.min((params.maxEvents as number) ?? 50, 100))
  const cursor = page.cursor ?? cursorOf((await eventStart(sql, network, principal, params, now)).seq)
  return {
    events: page.events,
    cursor,
    truncated: page.gap,
    hasMore: page.hasMore,
    nextPollMs: page.hasMore ? 0 : 60_000,
  }
}

export class McpEvents {
  constructor(
    readonly sql: AsyncSql,
    readonly network: Network,
    readonly options: { fetch?: WebhookFetch; now?: () => number } = {},
  ) {}

  async handle(method: string, params: Record<string, unknown>, grant: OAuthGrant): Promise<Record<string, unknown>> {
    if (!grant.scopes.includes('sidequest:read') || grant.chainId !== telegramChainId(this.network))
      throw new EventRpcError(-32003, 'This connection does not grant events on this chain')
    // Whole seconds, like the feed and the subscription table's INTEGER columns.
    const now = this.options.now?.() ?? Math.floor(Date.now() / 1000)
    const principal = grant.address.toLowerCase()
    if (method === 'events/list') return { events: descriptors }
    if (method === 'events/poll') return pollEvents(this.sql, this.network, principal, params, now)
    if (method === 'events/subscribe')
      return subscribeWebhook(this.sql, this.network, principal, params, now, this.options.fetch, grant.grantId)
    if (method === 'events/unsubscribe')
      return unsubscribeWebhook(this.sql, this.network, principal, params, now, grant.grantId)
    throw new EventRpcError(-32601, 'Unknown events method')
  }
}
