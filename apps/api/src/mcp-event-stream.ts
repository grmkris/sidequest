import { eventPage, eventStart } from '@sidequest/indexer/mcp-events'
import { cursorOf, parseCursor } from '@sidequest/indexer/feed'
import type { AsyncSql } from '@sidequest/indexer'
import type { Network } from '@sidequest/sdk'
import { deployment } from '@sidequest/sdk'
import { Schema } from 'effect'

const encoder = new TextEncoder()
const SUBSCRIPTION = 'io.modelcontextprotocol/subscriptionId'
const frame = (message: object) => `data: ${JSON.stringify({ jsonrpc: '2.0', ...message })}\n\n`
const notice = (method: string, subscriptionId: string | number, params: object) =>
  frame({ method, params: { ...params, _meta: { [SUBSCRIPTION]: subscriptionId } } })

export interface EventStreamRequest {
  readonly subscriptionId: string | number
  readonly name: string
  readonly arguments: Record<string, unknown>
  readonly cursor?: unknown
  readonly maxAgeMs?: number
}

type Start = Awaited<ReturnType<typeof eventStart>> & { principal: string; network: Network }
interface Stream {
  readonly subscriptionId: string | number
  readonly name: string
  readonly arguments: Record<string, unknown>
  readonly principal: string
  readonly network: Network
  readonly opened: number
  cursorSeq: number
  send: (text: string) => boolean
  end: () => void
}
type Page = Awaited<ReturnType<typeof eventPage>> & { gapSeq?: number }

/** Push acknowledges the retained starting position; webhook gap acknowledgement keeps its original cursor. */
export async function eventStreamStart(
  sql: AsyncSql,
  network: Network,
  principal: string,
  params: Record<string, unknown>,
  now: number,
): Promise<Awaited<ReturnType<typeof eventStart>>> {
  const start = await eventStart(sql, network, principal, params, now)
  if (!start.truncated) return start
  const [retained] = await sql.all<{ seq: number | null }>(
    'SELECT min(seq) AS seq FROM feed_events WHERE chain_id = ?',
    deployment(network).chainId,
  )
  return { seq: retained?.seq === null || retained === undefined ? start.seq : retained.seq - 1, truncated: true }
}

/** The selected page, plus the retained starting position when the stream has fallen behind retention. */
export async function readEventStreamPage(sql: AsyncSql, stream: Stream, now: number): Promise<Page> {
  const params = { name: stream.name, arguments: stream.arguments, cursor: cursorOf(stream.cursorSeq) }
  const page = await eventPage(sql, stream.network, stream.principal, params, now, 50)
  if (!page.gap) return page
  const start = await eventStreamStart(sql, stream.network, stream.principal, params, now)
  return { ...page, gapSeq: start.seq }
}

export class McpEventStreams {
  readonly #byGrant = new Map<string, Set<Stream>>()

  constructor(
    readonly options: { now: () => number; maxPerGrant?: number; lifetimeMs?: number; changed?: () => void } = {
      now: () => Date.now(),
    },
  ) {}

  /** The active notice is enqueued before the response leaves the management object. */
  open(grantId: string, request: EventStreamRequest, start: Start): Response {
    const streams = this.#byGrant.get(grantId) ?? new Set<Stream>()
    const oldest = [...streams].toSorted((a, b) => a.opened - b.opened)
    for (const stale of oldest.slice(0, Math.max(0, oldest.length - (this.options.maxPerGrant ?? 4) + 1)))
      this.#drop(grantId, stale, true)
    this.#byGrant.set(grantId, streams)
    let stream: Stream | undefined
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          let open = true
          stream = {
            subscriptionId: request.subscriptionId,
            name: request.name,
            arguments: request.arguments,
            principal: start.principal,
            network: start.network,
            opened: this.options.now(),
            cursorSeq: start.seq,
            send: (text) => {
              if (!open) return false
              try {
                // Bound memory if a connected host stops reading; it can reconnect with its last received cursor.
                if ((controller.desiredSize ?? 0) < 0) return false
                controller.enqueue(encoder.encode(text))
                return true
              } catch {
                return false
              }
            },
            end: () => {
              if (!open) return
              open = false
              try {
                controller.close()
              } catch {
                /* The host cancelled first. */
              }
            },
          }
          streams.add(stream)
          stream.send(
            notice('notifications/events/active', request.subscriptionId, {
              cursor: cursorOf(start.seq),
              truncated: start.truncated,
            }),
          )
        },
        cancel: () => {
          if (stream !== undefined) this.#drop(grantId, stream, false)
        },
      },
      { highWaterMark: 256 * 1024, size: (chunk) => chunk.byteLength },
    )
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
    })
  }

  /** True while any stream still has selected rows to drain, even if the database head stays still. */
  async deliver(readPage: (stream: Stream) => Promise<Page>): Promise<boolean> {
    this.expire()
    let pending = false
    const entries = Array.from(this.#byGrant.entries()).flatMap(([grantId, streams]) =>
      Array.from(streams, (stream) => ({ grantId, stream })),
    )
    for (const { grantId, stream } of entries) {
      const page = await readPage(stream)
      if (!this.#byGrant.get(grantId)?.has(stream)) continue
      pending ||= page.hasMore
      this.#deliverPage(grantId, stream, page)
    }
    return pending
  }

  #deliverPage(grantId: string, stream: Stream, page: Page): void {
    if (page.gap) {
      stream.cursorSeq = page.gapSeq ?? stream.cursorSeq
      if (
        !stream.send(
          notice('notifications/events/active', stream.subscriptionId, {
            cursor: cursorOf(stream.cursorSeq),
            truncated: true,
          }),
        )
      ) {
        this.#drop(grantId, stream, false)
        return
      }
    }
    for (const event of page.events.slice(0, 50)) {
      if (!stream.send(notice('notifications/events/event', stream.subscriptionId, event))) {
        this.#drop(grantId, stream, false)
        return
      }
      stream.cursorSeq = parseCursor(event.cursor)!
    }
    if (page.cursor !== null) stream.cursorSeq = Math.max(stream.cursorSeq, parseCursor(page.cursor)!)
  }

  heartbeat(): void {
    this.expire()
    for (const [grantId, streams] of this.#byGrant)
      for (const stream of streams)
        if (
          !stream.send(
            notice('notifications/events/heartbeat', stream.subscriptionId, { cursor: cursorOf(stream.cursorSeq) }),
          )
        )
          this.#drop(grantId, stream, false)
  }

  /** Access is the current grant, or undefined after revocation, disconnection, expiry or loss of read scope. */
  sync(access: (grantId: string) => { readonly scopes: readonly string[] } | undefined): void {
    for (const grantId of this.#byGrant.keys())
      if (!access(grantId)?.scopes.includes('sidequest:read'))
        this.close([grantId], { code: -32003, message: 'This connection no longer grants events' })
  }

  active(): boolean {
    return this.#byGrant.size > 0
  }

  /** A deliberate server close sends a final result; access loss also explains why the stream terminated. */
  close(grantIds: readonly string[], error?: { code: number; message: string }): void {
    for (const grantId of grantIds)
      for (const stream of this.#byGrant.get(grantId) ?? []) {
        if (error !== undefined)
          stream.send(notice('notifications/events/terminated', stream.subscriptionId, { error }))
        this.#drop(grantId, stream, true)
      }
  }

  expire(): void {
    const expired = this.options.now() - (this.options.lifetimeMs ?? 3_600_000)
    for (const [grantId, streams] of this.#byGrant)
      for (const stream of streams) if (stream.opened <= expired) this.#drop(grantId, stream, false)
  }

  #drop(grantId: string, stream: Stream, complete: boolean): void {
    if (complete)
      stream.send(
        frame({
          id: stream.subscriptionId,
          result: { resultType: 'complete', _meta: { [SUBSCRIPTION]: stream.subscriptionId } },
        }),
      )
    stream.end()
    const streams = this.#byGrant.get(grantId)
    streams?.delete(stream)
    if (streams?.size === 0) this.#byGrant.delete(grantId)
    this.options.changed?.()
  }
}

/** connectionAccess's fingerprint is [agentId, scopes, roles]; decode only its scope field. */
export function eventStreamAccess(access: string | undefined): { scopes: readonly string[] } | undefined {
  if (access === undefined || access === 'setup') return undefined
  try {
    const decoded = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.Array(Schema.String), Schema.Unknown])),
    )(access)
    return { scopes: decoded[1] }
  } catch {
    return undefined
  }
}
