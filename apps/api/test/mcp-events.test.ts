import { DatabaseSync } from 'node:sqlite'
import { fromNodeSqlite, stmt } from '@sidequest/indexer'
import { describe, expect, it } from 'vitest'
import { McpEvents } from '../src/mcp-events.ts'
import { writeFeed, pruneFeed, FEED_RETENTION_SECONDS } from '../src/feed.ts'
import type { OAuthGrant } from '../src/oauth.ts'

const wallet = '0x1111111111111111111111111111111111111111',
  stranger = '0x2222222222222222222222222222222222222222'
const now = 2_000_000
const grant: OAuthGrant = {
  owner: stranger,
  address: wallet.toUpperCase(),
  chainId: 10143,
  scopes: ['sidequest:read'],
  agentIds: ['a1'],
  registryAgentId: '7',
  resource: 'https://sidequest.test/mcp',
  clientId: 'c1',
}
async function setup() {
  const sql = fromNodeSqlite(new DatabaseSync(':memory:'))
  const events = new McpEvents(sql, 'monad-testnet', { now: () => now })
  await writeFeed(
    sql,
    'monad-testnet',
    [
      ...[
        'job.published',
        'job.submitted',
        'settlement.deferred',
        'payout.owed',
        'approval.requested',
        'permission.granted',
        'quote.received',
      ].map((kind, i) => ({
        id: `own-${i}`,
        address: wallet,
        kind,
        taskId: i % 2 === 0 ? 't1' : 't2',
        summary: kind,
        occurredAt: now - i,
      })),
      { id: 'stranger', address: stranger, kind: 'job.submitted', summary: 'secret', occurredAt: now },
      { id: 'public-request', address: '*', kind: 'request.opened', summary: 'public request', occurredAt: now },
      {
        id: 'public-job',
        address: '*',
        kind: 'job.published',
        boardId: 'public',
        taskId: 'tp',
        summary: 'public job',
        occurredAt: now,
      },
      { id: 'public-other', address: '*', kind: 'approval.requested', summary: 'not a request', occurredAt: now },
    ],
    now,
  )
  return {
    sql,
    events,
    poll: (name: string, params: Record<string, unknown> = {}) =>
      events.handle('events/poll', { name, ...params }, grant),
  }
}
const occurrences = (page: Record<string, unknown>) =>
  page.events as Array<{
    eventId: string
    name: string
    timestamp: string
    cursor: string
    data: { id: string; kind: string; public: boolean; taskId: string | null }
  }>

describe('MCP feed streams', () => {
  it('lists four schemas with poll and webhook delivery', async () => {
    const { events } = await setup()
    const list = await events.handle('events/list', {}, grant)
    expect((list.events as Array<{ name: string }>).map((event) => event.name)).toEqual([
      'sidequest.inbox',
      'sidequest.jobs',
      'sidequest.approvals',
      'sidequest.requests',
    ])
    expect(list.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inputSchema: expect.any(Object),
          payloadSchema: expect.any(Object),
          delivery: ['poll', 'webhook'],
        }),
      ]),
    )
  })
  it('pages oldest first, uses ISO seconds conversion, and carries the feed event', async () => {
    const { poll } = await setup()
    const first = await poll('sidequest.inbox', { maxEvents: 2 })
    expect(first).toMatchObject({ cursor: 'v1:2', hasMore: true, truncated: false, nextPollMs: 0 })
    expect(occurrences(first)[0]).toMatchObject({
      eventId: 'sidequest.inbox:own-0',
      name: 'sidequest.inbox',
      timestamp: new Date(now * 1000).toISOString(),
      cursor: 'v1:1',
      data: { id: 'own-0', public: false, kind: 'job.published', taskId: 't1' },
    })
    const second = await poll('sidequest.inbox', { cursor: first.cursor, maxEvents: 100 })
    expect(occurrences(second)).toHaveLength(5)
    expect(second).toMatchObject({ hasMore: false, nextPollMs: 60000 })
  })
  it('scopes own streams to grant.address rather than grant.owner or arbitrary arguments', async () => {
    const { poll } = await setup()
    for (const name of ['sidequest.inbox', 'sidequest.jobs', 'sidequest.approvals']) {
      expect(
        occurrences(await poll(name)).every((event) => event.data.id.startsWith('own-') && !event.data.public),
      ).toBe(true)
    }
    expect(occurrences(await poll('sidequest.jobs')).map((event) => event.data.kind)).toEqual([
      'job.published',
      'job.submitted',
      'settlement.deferred',
      'payout.owed',
    ])
    expect(
      occurrences(await poll('sidequest.jobs', { arguments: { taskId: 't1' } })).map((event) => event.data.kind),
    ).toEqual(['job.published', 'settlement.deferred'])
    expect(occurrences(await poll('sidequest.approvals')).map((event) => event.data.kind)).toEqual([
      'approval.requested',
      'permission.granted',
    ])
  })
  it('requests contains only public request.opened and job.published rows', async () => {
    const { poll } = await setup()
    expect(occurrences(await poll('sidequest.requests')).map((event) => [event.data.id, event.data.public])).toEqual([
      ['public-request', true],
      ['public-job', true],
    ])
  })
  it('filters inbox kinds and gives distinct ids for a row in different streams', async () => {
    const { poll } = await setup()
    const inbox = occurrences(await poll('sidequest.inbox', { arguments: { kinds: ['job.submitted'] } }))
    expect(inbox.map((event) => event.data.kind)).toEqual(['job.submitted'])
    const jobs = occurrences(await poll('sidequest.jobs', { arguments: { taskId: 't2' } }))
    expect(inbox[0]!.eventId).not.toBe(jobs[0]!.eventId)
  })
  it('filters inbox by requestId and exposes the request to task link', async () => {
    const { sql, poll } = await setup()
    await writeFeed(
      sql,
      'monad-testnet',
      [
        {
          id: 'picked',
          address: wallet,
          kind: 'request.picked',
          requestId: 'r1',
          taskId: 't9',
          summary: 'linked',
          occurredAt: now,
        },
      ],
      now,
    )
    expect(
      occurrences(await poll('sidequest.inbox', { arguments: { requestId: 'r1' }, maxAgeMs: 0 })).map(
        (event) => event.data,
      ),
    ).toEqual([expect.objectContaining({ requestId: 'r1', taskId: 't9' })])
  })
  it('caps maxEvents at 100 and defaults to 50', async () => {
    const { sql, poll } = await setup()
    await writeFeed(
      sql,
      'monad-testnet',
      Array.from({ length: 120 }, (_, i) => ({
        id: `many-${i}`,
        address: wallet,
        kind: 'job.submitted',
        summary: 's',
        occurredAt: now,
      })),
      now,
    )
    expect(occurrences(await poll('sidequest.inbox'))).toHaveLength(50)
    expect(occurrences(await poll('sidequest.inbox', { maxEvents: 500 }))).toHaveLength(100)
  })
  it('uses maxAgeMs only at no-cursor start and returns a stable empty cursor', async () => {
    const { sql, poll } = await setup()
    await sql.batch([stmt("UPDATE feed_events SET occurred_at = ? WHERE id = 'own-0'", now - 30)])
    expect(
      occurrences(await poll('sidequest.inbox', { maxAgeMs: 10_000 })).some((event) => event.data.id === 'own-0'),
    ).toBe(false)
    expect(
      occurrences(await poll('sidequest.inbox', { maxAgeMs: 0, cursor: 'v1:0' })).some(
        (event) => event.data.id === 'own-0',
      ),
    ).toBe(true)
    const empty = await poll('sidequest.jobs', { arguments: { taskId: 'missing' }, maxAgeMs: 0 })
    expect(empty.cursor).toMatch(/^v1:\d+$/)
  })
  it('reports a retention gap and never crosses chains', async () => {
    const { sql, poll } = await setup()
    await sql.batch([stmt('UPDATE feed_events SET created_at = ? WHERE seq <= 2', now - FEED_RETENTION_SECONDS - 1)])
    await pruneFeed(sql, now)
    const page = await poll('sidequest.inbox', { cursor: 'v1:0' })
    expect(page.truncated).toBe(true)
    expect(occurrences(page)[0]!.cursor).toBe('v1:3')
    await writeFeed(
      sql,
      'monad-mainnet',
      [{ id: 'other-chain', address: wallet, kind: 'job.published', summary: 'no', occurredAt: now }],
      now,
    )
    expect(occurrences(await poll('sidequest.inbox')).some((event) => event.data.id === 'other-chain')).toBe(false)
  })
  it.each([
    { name: 'unknown' },
    { name: 'sidequest.jobs', arguments: { address: stranger } },
    { name: 'sidequest.approvals', arguments: { kinds: [] } },
    { name: 'sidequest.requests', arguments: { taskId: 't1' } },
    { name: 'sidequest.inbox', arguments: { kinds: ['bad'] } },
    { name: 'sidequest.inbox', arguments: { kinds: [1] } },
    { name: 'sidequest.jobs', arguments: { taskId: 1 } },
    { name: 'sidequest.jobs', arguments: { taskId: '' } },
    { name: 'sidequest.inbox', arguments: [] },
    { name: 'sidequest.inbox', cursor: 'bad' },
    { name: 'sidequest.inbox', maxEvents: 0 },
    { name: 'sidequest.inbox', maxAgeMs: -1 },
  ])('refuses invalid names, arguments and paging: %j', async (params) => {
    const { events } = await setup()
    await expect(events.handle('events/poll', params, grant)).rejects.toMatchObject({ code: -32602 })
  })
  it('names the missing event name rather than calling it unknown', async () => {
    const { events } = await setup()
    await expect(events.handle('events/poll', {}, grant)).rejects.toMatchObject({
      code: -32602,
      message: expect.stringMatching(/^name is required/),
    })
  })
  it.each(['events/list', 'events/poll', 'events/subscribe', 'events/unsubscribe'])(
    'requires read scope and the grant chain for %s',
    async (method) => {
      const { events } = await setup()
      await expect(events.handle(method, {}, { ...grant, scopes: ['sidequest:work'] })).rejects.toMatchObject({
        code: -32003,
      })
      await expect(events.handle(method, {}, { ...grant, chainId: 143 })).rejects.toMatchObject({ code: -32003 })
    },
  )
})
