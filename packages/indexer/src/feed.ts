/**
 * The address-scoped event feed (V1.1 WS4): what happened to an agent's jobs, quotes, applications and approvals, read
 * by polling `inbox` (or MCP Events). Rows are metadata only, never briefs or worker-written text, with deterministic
 * ids so every producer is replay-safe (INSERT OR IGNORE). The tables are additive runtime DDL (Kris, 6 Oct 2026).
 */
import { BoardError, errorDiagnostics } from '@sidequest/board'
import { type AsyncSql, type Statement, stmt } from './store.ts'
import { foreignOffersForJobs, OFFER_HASH_SQL, type ForeignOffer } from './foreign-offers.ts'
import type { JobRow } from './read.ts'
import type { Network } from '@sidequest/sdk'
import { telegramChainId, publicOrigin } from './telegram.ts'

export const FEED_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS feed_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    chain_id INTEGER NOT NULL,
    address TEXT NOT NULL,
    kind TEXT NOT NULL,
    board_id TEXT,
    task_id TEXT,
    job_id TEXT,
    data_json TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS feed_events_address ON feed_events (chain_id, address, seq)',
  'CREATE INDEX IF NOT EXISTS feed_events_created ON feed_events (created_at)',
  `CREATE TABLE IF NOT EXISTS feed_request_tasks (
    chain_id INTEGER NOT NULL, board_id TEXT NOT NULL, task_id TEXT NOT NULL, request_id TEXT NOT NULL,
    PRIMARY KEY (chain_id, board_id, task_id), UNIQUE (chain_id, board_id, request_id)
  )`,
  `CREATE TABLE IF NOT EXISTS feed_checkpoints (
    name TEXT PRIMARY KEY,
    chain_id INTEGER NOT NULL,
    block INTEGER NOT NULL,
    log_index INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
] as const

/** Everyone may read rows addressed here: new requests and newly published jobs. */
export const PUBLIC_ADDRESS = '*'
export const FEED_RETENTION_SECONDS = 14 * 86_400
const DEFAULT_LOOKBACK_SECONDS = 7 * 86_400

/** Once per database handle per isolate: the DDL is idempotent, the round trip is not free. */
const migrated = new WeakSet<AsyncSql>()
export async function migrateFeed(sql: AsyncSql): Promise<void> {
  if (migrated.has(sql)) return
  await sql.batch(FEED_SCHEMA.map((query) => stmt(query)))
  migrated.add(sql)
}

/** The next call an agent would make, with the arguments it needs. */
export interface FeedNext {
  readonly tool: string
  readonly args: Record<string, string>
}

export interface FeedEvent {
  readonly id: string
  readonly address: string
  readonly kind: string
  readonly boardId?: string | null
  readonly taskId?: string | null
  readonly jobId?: string | null
  /** A quote request's id; requests have no task until a quote is picked. */
  readonly requestId?: string
  readonly role?: string
  readonly summary: string
  readonly url?: string
  readonly next?: FeedNext
  readonly occurredAt: number
}

export function feedStatements(chainId: number, events: readonly FeedEvent[], now: number): Statement[] {
  return events.map((e) =>
    stmt(
      'INSERT OR IGNORE INTO feed_events (id, chain_id, address, kind, board_id, task_id, job_id, data_json, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      e.id,
      chainId,
      e.address === PUBLIC_ADDRESS ? PUBLIC_ADDRESS : e.address.toLowerCase(),
      e.kind,
      e.boardId ?? null,
      e.taskId ?? null,
      e.jobId ?? null,
      JSON.stringify({
        ...(e.requestId === undefined ? {} : { requestId: e.requestId }),
        ...(e.role === undefined ? {} : { role: e.role }),
        summary: e.summary,
        ...(e.url === undefined ? {} : { url: e.url }),
        ...(e.next === undefined ? {} : { next: e.next }),
      }),
      e.occurredAt,
      now,
    ),
  )
}

export async function writeFeed(
  sql: AsyncSql,
  network: Network,
  events: readonly FeedEvent[],
  now: number,
): Promise<void> {
  if (events.length === 0) return
  await migrateFeed(sql)
  const chainId = telegramChainId(network)
  await sql.batch([
    ...events
      .filter(
        (e) =>
          e.requestId !== undefined &&
          e.taskId !== undefined &&
          e.taskId !== null &&
          e.boardId !== undefined &&
          e.boardId !== null,
      )
      .map((e) =>
        stmt(
          'INSERT OR IGNORE INTO feed_request_tasks (chain_id, board_id, task_id, request_id) VALUES (?, ?, ?, ?)',
          chainId,
          e.boardId!,
          e.taskId!,
          e.requestId!,
        ),
      ),
    ...feedStatements(chainId, events, now),
  ])
}

export interface InboxEvent {
  readonly foreignOffer?: ForeignOffer | undefined
  readonly id: string
  readonly kind: string
  readonly cursor: string
  readonly occurredAt: number
  readonly chainId: number
  readonly boardId: string | null
  readonly taskId: string | null
  readonly jobId: string | null
  readonly public: boolean
  readonly requestId?: string
  readonly role?: string
  readonly summary: string
  readonly url?: string
  readonly next?: FeedNext
}

export const cursorOf = (seq: number) => `v1:${seq}`
export function parseCursor(cursor: unknown): number | undefined {
  if (cursor === undefined || cursor === null || cursor === '') return undefined
  const match = typeof cursor === 'string' ? /^v1:(\d{1,15})$/.exec(cursor) : null
  if (match === null) throw new Error('cursor must be a value returned by inbox')
  return Number(match[1])
}

/**
 * One page of an address's feed, oldest first after `cursor`. Without a cursor it starts seven days back. A cursor older
 * than retention returns `gap: true` with the oldest retained rows, so a poller knows it may have missed events.
 */
export async function readInbox(
  sql: AsyncSql,
  input: {
    network: Network
    address: string
    cursor?: unknown
    kinds?: unknown
    includePublic?: unknown
    scope?: 'own' | 'public'
    taskId?: string
    requestId?: string
    kindPrefixes?: readonly string[]
    maxAgeMs?: number
    limit?: unknown
    now: number
  },
) {
  await migrateFeed(sql)
  const chainId = telegramChainId(input.network)
  const after = parseCursor(input.cursor)
  const limit =
    typeof input.limit === 'number' && Number.isSafeInteger(input.limit) ? Math.min(Math.max(input.limit, 1), 100) : 50
  const kinds = Array.isArray(input.kinds)
    ? input.kinds
        .filter((kind): kind is string => typeof kind === 'string' && /^[a-z]+\.[a-z_]+$/.test(kind))
        .slice(0, 20)
    : []
  const addresses =
    input.scope === 'public'
      ? [PUBLIC_ADDRESS]
      : [
          input.address.toLowerCase(),
          ...(input.scope === 'own' || input.includePublic === false ? [] : [PUBLIC_ADDRESS]),
        ]
  const prefixes = input.kindPrefixes ?? []
  const selectors = [
    ...(kinds.length > 0 ? [`kind IN (${kinds.map(() => '?').join(',')})`] : []),
    ...prefixes.map(() => 'substr(kind, 1, length(?)) = ?'),
  ]
  const where = [
    `chain_id = ?`,
    `address IN (${addresses.map(() => '?').join(',')})`,
    ...(selectors.length > 0 ? [`(${selectors.join(' OR ')})`] : []),
  ]
  const params: (string | number)[] = [
    chainId,
    ...addresses,
    ...kinds,
    ...prefixes.flatMap((prefix) => [prefix, prefix]),
  ]
  if (input.taskId !== undefined) {
    where.push('task_id = ?')
    params.push(input.taskId)
  }
  if (input.requestId !== undefined) {
    where.push("json_extract(data_json, '$.requestId') = ?")
    params.push(input.requestId)
  }
  if (after !== undefined) {
    where.push('seq > ?')
    params.push(after)
  } else {
    where.push('occurred_at >= ?')
    params.push(
      input.now -
        (input.maxAgeMs === undefined
          ? DEFAULT_LOOKBACK_SECONDS
          : Math.min(input.maxAgeMs / 1000, FEED_RETENTION_SECONDS)),
    )
  }
  const rows = await sql.all<{
    seq: number
    id: string
    address: string
    kind: string
    board_id: string | null
    task_id: string | null
    job_id: string | null
    data_json: string
    occurred_at: number
  }>(
    `SELECT seq, id, address, kind, board_id, task_id, job_id, data_json, occurred_at FROM (
      SELECT f.seq, f.id, f.address, f.kind, f.chain_id, f.board_id, coalesce(f.task_id, l.task_id) task_id, f.job_id, f.occurred_at,
        CASE WHEN l.request_id IS NULL THEN f.data_json ELSE json_set(f.data_json, '$.requestId', l.request_id) END data_json
      FROM feed_events f LEFT JOIN feed_request_tasks l ON l.chain_id=f.chain_id AND l.board_id=f.board_id
        AND (l.task_id=f.task_id OR l.request_id=json_extract(f.data_json, '$.requestId'))
    ) WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`,
    ...params,
    limit + 1,
  )
  const page = rows.slice(0, limit)
  const [oldest] =
    after === undefined
      ? [undefined]
      : await sql.all<{ seq: number }>('SELECT min(seq) AS seq FROM feed_events WHERE chain_id = ?', chainId)
  const offers = await foreignOffersForJobs(
    sql,
    chainId,
    page.map((row) => row.job_id),
  )
  const events: InboxEvent[] = page.flatMap((row) => {
    const event: InboxEvent = {
      id: row.id,
      kind: row.kind,
      cursor: cursorOf(row.seq),
      occurredAt: row.occurred_at,
      chainId,
      boardId: row.board_id,
      taskId: row.task_id,
      jobId: row.job_id,
      foreignOffer: offers.get(row.job_id),
      public: row.address === PUBLIC_ADDRESS,
      ...(JSON.parse(row.data_json) as Pick<InboxEvent, 'requestId' | 'role' | 'summary' | 'url' | 'next'>),
    }
    // A public job.published row for a job published outside every board (a direct contract call) names no task and
    // no offer, so no reader can act on it; the creator keeps its own row. The cursor still moves past it.
    const orphan =
      event.public && event.kind === 'job.published' && event.taskId === null && event.foreignOffer === undefined
    return orphan ? [] : [event]
  })
  const last = page.at(-1)
  return {
    events,
    cursor: last === undefined ? (after === undefined ? null : cursorOf(after)) : cursorOf(last.seq),
    hasMore: rows.length > limit,
    gap: after !== undefined && oldest?.seq !== undefined && oldest.seq !== null && oldest.seq > after + 1,
    nextPollSeconds: rows.length > limit ? 0 : 60,
  }
}

const FEED_KINDS =
  'job.published, job.activated, job.submitted, job.rejected, job.disputed, job.ruled, job.completed, job.closed, job.expired, ' +
  'job.cancelled, settlement.deferred, payout.owed, quote.received, application.received, selection.received, invite.received, quote.invited, request.opened, request.picked, ' +
  'approval.requested, approval.decided, permission.granted, ' +
  'message.posted, message.mention, message.reply, roadmap.proposed, roadmap.status, gap.reported, message.hidden'

/** The `inbox` read tool, served by the Worker from D1 for the signed-in wallet or the agent's OAuth grant. */
export const feedTools = {
  inbox: {
    description:
      'What happened to your jobs, quotes, applications and approvals, oldest first. Poll it from a routine: pass back the returned ' +
      'cursor, act on each event’s next tool, and wait nextPollSeconds. Without a cursor it starts 7 days back; events are kept 14 days, and ' +
      `gap: true means some were missed. Kinds: ${FEED_KINDS}. Public rows (new requests and jobs) are included unless includePublic is false.`,
    inputSchema: {
      type: 'object',
      properties: {
        cursor: { type: 'string', description: 'The cursor from your previous inbox call.' },
        requestId: { type: 'string', description: 'Follow one quote request through its linked hire.' },
        kinds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only these kinds, e.g. ["selection.received", "job.submitted"].',
        },
        includePublic: { type: 'boolean', description: 'Include new public requests and jobs; default true.' },
        limit: { type: 'number', description: 'At most 100; default 50.' },
      },
    },
    run: async (
      deps: { sql: AsyncSql; network: Network; now: number },
      caller: string | undefined,
      args: Record<string, unknown>,
    ) => {
      if (caller === undefined) throw new BoardError('unauthenticated', 'Sign in to read your inbox')
      try {
        if (args.requestId !== undefined && (typeof args.requestId !== 'string' || args.requestId.length === 0))
          throw new BoardError('invalid', 'requestId must be a nonempty string')
        return await readInbox(deps.sql, {
          network: deps.network,
          address: caller,
          cursor: args.cursor,
          kinds: args.kinds,
          ...(typeof args.requestId === 'string' ? { requestId: args.requestId } : {}),
          includePublic: args.includePublic,
          limit: args.limit,
          now: deps.now,
        })
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('cursor '))
          throw new BoardError('invalid', error.message)
        throw error
      }
    },
  },
} as const

/** A feed failure never fails its caller; log bounded diagnostics only. */
export function reportFeedFailure(error: unknown): void {
  console.error(JSON.stringify({ event: 'feed-failed', ...errorDiagnostics(error) }))
}

export async function pruneFeed(sql: AsyncSql, now: number, limit = 1000): Promise<void> {
  await migrateFeed(sql)
  await sql.batch([
    stmt(
      'DELETE FROM feed_events WHERE seq IN (SELECT seq FROM feed_events WHERE created_at < ? ORDER BY seq LIMIT ?)',
      now - FEED_RETENTION_SECONDS,
      limit,
    ),
  ])
}

type ChainEvent = {
  contract: string
  block: number
  log_index: number
  tx_hash: string
  job_id: string
  name: string
  args_json: string
  timestamp: number | null
}

/** Which chain events become feed events, for whom, and what each recipient might do next. */
const CHAIN_KINDS: Readonly<
  Record<string, { kind: string; to: (job: JobRow, args: Record<string, unknown>) => Array<[string | null, string]> }>
> = {
  Published: {
    kind: 'job.published',
    to: (job) => [
      [job.creator, 'creator'],
      [PUBLIC_ADDRESS, 'public'],
    ],
  },
  Activated: {
    kind: 'job.activated',
    to: (job) => [
      [job.creator, 'creator'],
      [job.worker, 'worker'],
    ],
  },
  JobSubmitted: {
    kind: 'job.submitted',
    to: (job) => [
      [job.creator, 'creator'],
      [job.approver, 'approver'],
    ],
  },
  Rejected: {
    kind: 'job.rejected',
    to: (job) => [
      [job.creator, 'creator'],
      [job.worker, 'worker'],
    ],
  },
  Disputed: {
    kind: 'job.disputed',
    to: (job) => [
      [job.creator, 'creator'],
      [job.worker, 'worker'],
    ],
  },
  Ruled: {
    kind: 'job.ruled',
    to: (job) => [
      [job.creator, 'creator'],
      [job.worker, 'worker'],
    ],
  },
  JobCompleted: {
    kind: 'job.completed',
    to: (job) => [
      [job.creator, 'creator'],
      [job.worker, 'worker'],
    ],
  },
  JobRejected: {
    kind: 'job.closed',
    to: (job) => [
      [job.creator, 'creator'],
      [job.worker, 'worker'],
    ],
  },
  JobExpired: {
    kind: 'job.expired',
    to: (job) => [
      [job.creator, 'creator'],
      [job.worker, 'worker'],
    ],
  },
  Cancelled: {
    kind: 'job.cancelled',
    to: (job) => [
      [job.creator, 'creator'],
      [job.worker, 'worker'],
    ],
  },
  PayoutDeferred: {
    kind: 'settlement.deferred',
    to: (job) => [
      [job.creator, 'creator'],
      [job.worker, 'worker'],
    ],
  },
  RefundDeferred: {
    kind: 'settlement.deferred',
    to: (job) => [
      [job.creator, 'creator'],
      [job.worker, 'worker'],
    ],
  },
  PayoutOwed: {
    kind: 'payout.owed',
    to: (_job, args) => [[typeof args.to === 'string' ? args.to : null, 'recipient']],
  },
  RewardOwed: {
    kind: 'payout.owed',
    to: (_job, args) => [[typeof args.to === 'string' ? args.to : null, 'recipient']],
  },
}

const SUMMARY: Readonly<Record<string, (jobId: string, role: string) => string>> = {
  'job.published': (jobId, role) =>
    role === 'public' ? `Job #${jobId} is open for applications.` : `Your job #${jobId} is published and escrowed.`,
  'job.activated': (jobId, role) =>
    role === 'worker' ? `You are hired on job #${jobId}; deliver before the deadline.` : `Job #${jobId} is active.`,
  'job.submitted': (jobId, role) =>
    role === 'worker'
      ? `Job #${jobId} was submitted.`
      : `A delivery was submitted on job #${jobId}; review it before silence accepts it.`,
  'job.rejected': (jobId, role) =>
    role === 'worker'
      ? `Your delivery on job #${jobId} was rejected; you may dispute within the window.`
      : `You rejected the delivery on job #${jobId}.`,
  'job.disputed': (jobId) => `Job #${jobId} is disputed; the arbitrator decides.`,
  'job.ruled': (jobId) => `The arbitrator ruled on job #${jobId}.`,
  'job.completed': (jobId) => `Job #${jobId} completed.`,
  'job.closed': (jobId) => `Job #${jobId} closed after a rejection.`,
  'job.expired': (jobId) => `Job #${jobId} expired.`,
  'job.cancelled': (jobId) => `Job #${jobId} was cancelled.`,
  'settlement.deferred': (jobId) => `Job #${jobId} has a deferred settlement step to finish.`,
  'payout.owed': (jobId) => `Job #${jobId} owes you a payout to withdraw.`,
}

function chainNext(kind: string, role: string, taskId: string | null): FeedNext | undefined {
  if (taskId === null) return undefined
  if (kind === 'job.submitted' && role !== 'worker') return { tool: 'get_task', args: { taskId } }
  if (kind === 'job.rejected' && role === 'worker') return { tool: 'get_task', args: { taskId } }
  if (kind === 'job.activated' && role === 'worker') return { tool: 'get_task', args: { taskId } }
  if (kind === 'settlement.deferred' || kind === 'payout.owed') return { tool: 'settlement_actions', args: { taskId } }
  if (kind === 'job.published' && role === 'public') return { tool: 'get_task', args: { taskId } }
  return undefined
}

/**
 * Turns finalized chain events after the feed checkpoint into feed rows, only while the index is caught up. The
 * checkpoint advances in the same batch as the rows, and the ids are deterministic, so a crash repeats nothing.
 */
export async function feedFromChain(
  sql: AsyncSql,
  network: Network,
  now: number,
  options: { caughtUp: boolean; limit?: number },
) {
  await migrateFeed(sql)
  const chainId = telegramChainId(network)
  const [checkpoint] = await sql.all<{ updated_at: number }>(
    'SELECT updated_at FROM checkpoint WHERE chain_id = ?',
    chainId,
  )
  if (!options.caughtUp || checkpoint === undefined || checkpoint.updated_at < now - 120)
    return { processed: 0, stale: true }
  const name = `chain:${chainId}`
  const names = Object.keys(CHAIN_KINDS)
  const oldest = now - FEED_RETENTION_SECONDS
  // The first run starts after the newest event already past retention, so history never floods every inbox as new.
  const [saved] = await sql.all<{ block: number; log_index: number }>(
    'SELECT block, log_index FROM feed_checkpoints WHERE name = ?',
    name,
  )
  const [position] =
    saved !== undefined
      ? [saved]
      : await sql.all<{ block: number; log_index: number }>(
          `SELECT e.block, e.log_index FROM events e
    JOIN block_times b ON b.chain_id = e.chain_id AND b.block = e.block WHERE e.chain_id = ? AND b.timestamp < ? ORDER BY e.block DESC, e.log_index DESC LIMIT 1`,
          chainId,
          oldest,
        )
  const listed = await sql.all<ChainEvent>(
    `SELECT e.*, b.timestamp FROM events e
    LEFT JOIN block_times b ON b.chain_id = e.chain_id AND b.block = e.block
    WHERE e.chain_id = ? AND e.name IN (${names.map(() => '?').join(',')}) AND (e.block > ? OR (e.block = ? AND e.log_index > ?))
    ORDER BY e.block, e.log_index LIMIT ?`,
    chainId,
    ...names,
    position?.block ?? -1,
    position?.block ?? -1,
    position?.log_index ?? -1,
    options.limit ?? 200,
  )
  // Only the contiguous prefix whose block times are stored: the cursor never passes an event it could not write (VV2-024).
  const gap = listed.findIndex((e) => e.timestamp === null)
  const events = (gap === -1 ? listed : listed.slice(0, gap)) as Array<ChainEvent & { timestamp: number }>
  if (events.length === 0) return { processed: 0, stale: false, waiting: gap !== -1 }
  const rows: FeedEvent[] = []
  // One lookup per job per run: a job's transitions usually arrive together.
  const jobs = new Map<string, (JobRow & { board_id: string | null; task_id: string | null }) | undefined>()
  for (const e of events) {
    if (!jobs.has(e.job_id))
      jobs.set(
        e.job_id,
        (
          await sql.all<JobRow & { board_id: string | null; task_id: string | null }>(
            // The registry's offer hash: a board's manifest hash, which equals the policy hash only on hosted boards.
            `SELECT j.*, o.board_id, o.task_id FROM jobs j
      LEFT JOIN board_offers o ON lower(o.terms_hash) = lower(${OFFER_HASH_SQL}) WHERE j.chain_id = ? AND j.job_id = ?`,
            chainId,
            e.job_id,
          )
        )[0],
      )
    const job = jobs.get(e.job_id)
    if (job === undefined || e.timestamp < oldest) continue
    const spec = CHAIN_KINDS[e.name]!
    const args = JSON.parse(e.args_json) as Record<string, unknown>
    const url = `${publicOrigin()}/job/${encodeURIComponent(e.job_id)}`
    const seen = new Set<string>()
    for (const [address, role] of spec.to(job, args)) {
      if (address === null || seen.has(address.toLowerCase())) continue
      seen.add(address.toLowerCase())
      const next = chainNext(spec.kind, role, job.task_id ?? null)
      rows.push({
        id: `chain:${chainId}:${e.contract}:${e.block}:${e.log_index}:${address.toLowerCase()}`,
        address,
        kind: spec.kind,
        boardId: job.board_id ?? null,
        taskId: job.task_id ?? null,
        jobId: e.job_id,
        role,
        summary: SUMMARY[spec.kind]!(e.job_id, role),
        url,
        ...(next === undefined ? {} : { next }),
        occurredAt: e.timestamp,
      })
    }
  }
  const last = events.at(-1)!
  await sql.batch([
    ...feedStatements(chainId, rows, now),
    stmt(
      'INSERT INTO feed_checkpoints (name, chain_id, block, log_index, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET block = excluded.block, log_index = excluded.log_index, updated_at = excluded.updated_at',
      name,
      chainId,
      last.block,
      last.log_index,
      now,
    ),
  ])
  return { processed: events.length, stale: false, waiting: gap !== -1 }
}
