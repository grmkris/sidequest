import { DatabaseSync } from 'node:sqlite'
import { fromNodeSqlite, stmt } from '@sidequest/indexer'
import { writeFeed, pruneFeed, FEED_RETENTION_SECONDS } from '@sidequest/indexer/feed'
import { afterEach, expect, it } from 'vitest'
import { Schema } from 'effect'
import { McpEventStreams, readEventStreamPage, eventStreamAccess, eventStreamStart } from '../src/mcp-event-stream.ts'

const wallet = '0x1111111111111111111111111111111111111111'
const other = '0x2222222222222222222222222222222222222222'
const meta = (id: string | number) => ({ _meta: { 'io.modelcontextprotocol/subscriptionId': id } })
const message = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
async function frame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunk = await reader.read()
  expect(chunk.done).toBe(false)
  const text = new TextDecoder().decode(chunk.value)
  expect(text.startsWith('data: ')).toBe(true)
  expect(text.endsWith('\n\n')).toBe(true)
  return message(text.slice(6).trim())
}
async function fixture() {
  let now = 2_000_000_000
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  const streams = new McpEventStreams({ now: () => now })
  const append = (id: string, address = wallet) =>
    writeFeed(
      sql,
      'monad-testnet',
      [{ id, address, kind: 'job.overdue', summary: 'Deadline passed', occurredAt: now / 1000 }],
      now / 1000,
    )
  const open = async (id: number, cursor?: unknown, name = 'sidequest.inbox', grantId = 'grant') => {
    const request = { subscriptionId: id, name, arguments: {}, ...(cursor === undefined ? {} : { cursor }) }
    const start = await eventStreamStart(sql, 'monad-testnet', wallet, request, now / 1000)
    return streams.open(grantId, request, { ...start, principal: wallet, network: 'monad-testnet' })
  }
  return {
    sql,
    streams,
    append,
    open,
    advance: (ms: number) => {
      now += ms
    },
    deliver: () => streams.deliver((stream) => readEventStreamPage(sql, stream, now / 1000)),
  }
}

it('sends active first, then a newly appended occurrence with the request id metadata and its cursor', async () => {
  const f = await fixture()
  const response = await f.open(7)
  expect(Object.fromEntries(response.headers)).toMatchObject({
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  })
  const reader = response.body!.getReader()
  expect(await frame(reader)).toEqual({
    jsonrpc: '2.0',
    method: 'notifications/events/active',
    params: { cursor: 'v1:0', truncated: false, ...meta(7) },
  })
  await f.append('new')
  await f.deliver()
  expect(await frame(reader)).toEqual({
    jsonrpc: '2.0',
    method: 'notifications/events/event',
    params: {
      eventId: 'sidequest.inbox:new',
      name: 'sidequest.inbox',
      timestamp: new Date(2_000_000_000).toISOString(),
      cursor: 'v1:1',
      data: expect.objectContaining({
        kind: 'job.overdue',
        title: 'Delivery overdue',
        summary: 'Deadline passed',
        cursor: 'v1:1',
      }),
      ...meta(7),
    },
  })
  await reader.cancel()
})

it('cursor:null skips backlog while omission starts before selected rows, and selectors stay private', async () => {
  const f = await fixture()
  await f.append('backlog')
  await f.append('stranger', other)
  const live = (await f.open(1, null)).body!.getReader()
  const backlog = (await f.open(2)).body!.getReader()
  expect(await frame(live)).toMatchObject({ params: { cursor: 'v1:2' } })
  expect(await frame(backlog)).toMatchObject({ params: { cursor: 'v1:0' } })
  await f.deliver()
  expect(await frame(backlog)).toMatchObject({ params: { eventId: 'sidequest.inbox:backlog' } })
  await f.append('new')
  await f.deliver()
  expect(await frame(live)).toMatchObject({ params: { eventId: 'sidequest.inbox:new' } })
  await live.cancel()
  await backlog.cancel()
})

it('marks stale cursors at open, and re-activates before retained events if a running cursor falls out of retention', async () => {
  const f = await fixture()
  await f.append('old')
  const live = (await f.open(1, 'v1:0')).body!.getReader()
  await frame(live)
  await f.sql.batch([stmt('UPDATE feed_events SET created_at = ?', 2_000_000 - FEED_RETENTION_SECONDS - 1)])
  await f.append('retained')
  await pruneFeed(f.sql, 2_000_000)
  const stale = (await f.open(2, 'v1:0')).body!.getReader()
  expect(await frame(stale)).toMatchObject({ params: { cursor: 'v1:1', truncated: true } })
  await f.deliver()
  expect(await frame(live)).toMatchObject({
    method: 'notifications/events/active',
    params: { cursor: 'v1:1', truncated: true },
  })
  expect(await frame(live)).toMatchObject({
    method: 'notifications/events/event',
    params: { eventId: 'sidequest.inbox:retained', cursor: 'v1:2' },
  })
  await live.cancel()
  await stale.cancel()
})

it('uses data frames for heartbeats with the latest cursor', async () => {
  const f = await fixture()
  const reader = (await f.open(1, null)).body!.getReader()
  await frame(reader)
  await f.append('new')
  await f.deliver()
  await frame(reader)
  f.advance(25_000)
  f.streams.heartbeat()
  expect(await frame(reader)).toEqual({
    jsonrpc: '2.0',
    method: 'notifications/events/heartbeat',
    params: { cursor: 'v1:1', ...meta(1) },
  })
  await reader.cancel()
})

it.each([undefined, { scopes: ['sidequest:work'] }])(
  'terminates and completes streams whose grant disappeared or lost read scope: %j',
  async (access) => {
    const f = await fixture()
    const reader = (await f.open(1)).body!.getReader()
    await frame(reader)
    f.streams.sync(() => access)
    expect(await frame(reader)).toMatchObject({
      method: 'notifications/events/terminated',
      params: { error: { code: -32003 }, ...meta(1) },
    })
    expect(await frame(reader)).toEqual({ jsonrpc: '2.0', id: 1, result: { resultType: 'complete', ...meta(1) } })
    expect((await reader.read()).done).toBe(true)
    expect(f.streams.active()).toBe(false)
  },
)

it('keeps streams with read scope, and cancellation frees them', async () => {
  const f = await fixture()
  const reader = (await f.open(1)).body!.getReader()
  await frame(reader)
  f.streams.sync(() => ({ scopes: ['sidequest:read'] }))
  expect(f.streams.active()).toBe(true)
  await reader.cancel()
  expect(f.streams.active()).toBe(false)
})

it('gives way to a fifth stream on the same grant, leaving another grant alone', async () => {
  const f = await fixture()
  const otherGrant = (await f.open(99, null, 'sidequest.inbox', 'other-grant')).body!.getReader()
  await frame(otherGrant)
  const readers = []
  for (let id = 1; id <= 5; id++) {
    readers.push((await f.open(id)).body!.getReader())
    f.advance(1)
  }
  await frame(readers[0]!)
  expect(await frame(readers[0]!)).toMatchObject({ id: 1, result: { resultType: 'complete' } })
  expect((await readers[0]!.read()).done).toBe(true)
  for (const reader of readers.slice(1)) await reader.cancel()
  expect(f.streams.active()).toBe(true)
  await f.append('other-grant-event')
  await f.deliver()
  expect(await frame(otherGrant)).toMatchObject({
    params: { eventId: 'sidequest.inbox:other-grant-event', ...meta(99) },
  })
  await otherGrant.cancel()
  expect(f.streams.active()).toBe(false)
})

it('ends the one-hour lifetime abruptly without a final result', async () => {
  const f = await fixture()
  const reader = (await f.open(1)).body!.getReader()
  await frame(reader)
  f.advance(3_600_000)
  f.streams.heartbeat()
  expect((await reader.read()).done).toBe(true)
  expect(f.streams.active()).toBe(false)
})

it('delivers at most fifty per tick and keeps draining a stationary head', async () => {
  const f = await fixture()
  const reader = (await f.open(1, null, 'sidequest.jobs')).body!.getReader()
  await frame(reader)
  for (let i = 0; i < 55; i++) await f.append(String(i))
  expect(await f.deliver()).toBe(true)
  for (let i = 0; i < 50; i++) expect(await frame(reader)).toMatchObject({ params: { cursor: `v1:${i + 1}` } })
  expect(await f.deliver()).toBe(false)
  for (let i = 50; i < 55; i++) expect(await frame(reader)).toMatchObject({ params: { cursor: `v1:${i + 1}` } })
  await reader.cancel()
})

it('decodes only current connection scope fingerprints', () => {
  expect(eventStreamAccess('setup')).toBeUndefined()
  expect(eventStreamAccess(undefined)).toBeUndefined()
  expect(eventStreamAccess('invalid')).toBeUndefined()
  expect(eventStreamAccess(JSON.stringify(['a1', ['sidequest:read'], ['work']]))).toEqual({
    scopes: ['sidequest:read'],
  })
})
