import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { fromNodeSqlite as boardSql, migrate as migrateBoard } from '@sidequest/board'
import { fromNodeSqlite, migrate, stmt } from '@sidequest/indexer'
import { boardFeedEvents, recordBoardEvent } from '../src/feed-board.ts'
import { readInbox } from '../src/feed.ts'
import { migrateTelegram } from '../src/telegram.ts'
import { McpEvents } from '../src/mcp-events.ts'
import { deliverWebhooks, type WebhookFetch } from '../src/webhooks.ts'
import type { OAuthGrant } from '../src/oauth.ts'

const creator = '0x1111111111111111111111111111111111111111'
const worker = '0x2222222222222222222222222222222222222222'
const now = 2_000_000
const network = 'monad-testnet' as const

async function setup() {
  const board = boardSql(new DatabaseSync(':memory:'))
  migrateBoard(board)
  board.run(
    "INSERT INTO tasks (id, creator, stack, terms_json, terms_hash, job_id, publish_tx, from_block, created_at) VALUES ('t1', ?, 'main', '{}', '0xaa', NULL, NULL, 1, 1)",
    creator,
  )
  board.run(
    "INSERT INTO applications (id, task_id, worker, agent_id, note, created_at) VALUES ('a1', 't1', ?, '9', 'direct hire invitation', 1)",
    worker,
  )
  board.run(
    "INSERT INTO quote_requests (id, creator, stack, request_json, request_hash, quote_deadline, task_id, created_at) VALUES ('r1', ?, 'main', '{\"brief\":\"secret brief\"}', '0xbb', 9, NULL, 1)",
    creator,
  )
  const d1 = fromNodeSqlite(new DatabaseSync(':memory:'))
  await migrate(d1)
  await migrateTelegram(d1)
  await d1.batch([stmt('INSERT INTO telegram_links VALUES (?, 10143, ?, NULL, 1)', 'chat-worker', worker)])
  return { board, d1 }
}
const call = (tool: string, args: Record<string, unknown>, result: unknown) => ({
  tool,
  args,
  result,
  network,
  boardId: 'public',
  now,
})

describe('board feed hook', () => {
  it('addresses quotes, applications, selections and requests to the party who must act, metadata only', async () => {
    const { board } = await setup()
    const quote = boardFeedEvents(
      board,
      call('submit_quote', { requestId: 'r1', note: 'worker text' }, { quoteId: 'q1', quoteHash: '0xq1' }),
    )
    expect(quote).toEqual([
      expect.objectContaining({
        id: 'board:public:quote:0xq1',
        address: creator,
        kind: 'quote.received',
        requestId: 'r1',
        next: { tool: 'list_quotes', args: { requestId: 'r1' } },
      }),
    ])
    expect(JSON.stringify(quote)).not.toMatch(/worker text|secret brief/)
    expect(
      boardFeedEvents(board, call('apply', { taskId: 't1', note: 'hi' }, { applicationId: 'a9' }))[0],
    ).toMatchObject({ address: creator, kind: 'application.received', taskId: 't1' })
    expect(
      boardFeedEvents(board, call('submit_selection', { taskId: 't1', nonce: '5' }, { ok: true, worker }))[0],
    ).toMatchObject({ id: 'board:public:selection:t1:5', address: worker, next: { tool: 'prepare_activation' } })
    expect(boardFeedEvents(board, call('request_quotes', {}, { requestId: 'r2' }))[0]).toMatchObject({
      address: '*',
      kind: 'request.opened',
      requestId: 'r2',
      url: 'https://dev.sidequest.exchange/request/r2',
    })
    // A request's page lives in the Jobs list's request route; /quotes/<id> only redirects there.
    expect(quote[0]).toMatchObject({ url: 'https://dev.sidequest.exchange/request/r1' })
    board.run("UPDATE quote_requests SET task_id = 't1' WHERE id = 'r1'")
    expect(boardFeedEvents(board, call('pick_quote', { requestId: 'r1' }, { taskId: 't1' }))).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'request.picked', requestId: 'r1', taskId: 't1' })]),
    )
    expect(boardFeedEvents(board, call('get_task', { taskId: 't1' }, {}))).toEqual([])
    expect(boardFeedEvents(board, call('apply', { taskId: 'nope' }, { applicationId: 'a9' }))).toEqual([])
  })

  it('tells every other bidder its quote lost when the creator picks one, without its text', async () => {
    const { board } = await setup()
    const loser = '0x3333333333333333333333333333333333333333'
    for (const [id, bidder] of [
      ['q1', worker],
      ['q2', loser],
    ] as const)
      board.run(
        "INSERT INTO quotes (id, request_id, worker, agent_id, token, amount, note, quote_hash, created_at) VALUES (?, 'r1', ?, '9', '0xcc', '9000000', 'private note', ?, 1)",
        id,
        bidder,
        `0x${id}`,
      )
    board.run("UPDATE quote_requests SET task_id = 't1' WHERE id = 'r1'")
    const events = boardFeedEvents(board, call('pick_quote', { requestId: 'r1', quoteId: 'q1' }, { taskId: 't1' }))
    expect(events.filter((e) => e.kind === 'quote.lost')).toEqual([
      expect.objectContaining({
        id: `board:public:quote-lost:r1:${loser}`,
        address: loser,
        role: 'bidder',
        requestId: 'r1',
        next: { tool: 'list_quotes', args: { requestId: 'r1' } },
      }),
    ])
    expect(JSON.stringify(events)).not.toContain('private note')
  })

  it('tells an invited worker only once the offer is escrowed on chain', async () => {
    const { board } = await setup()
    expect(boardFeedEvents(board, call('report_transaction', { taskId: 't1' }, {}))).toEqual([])
    board.run("UPDATE tasks SET job_id = '42' WHERE id = 't1'")
    expect(boardFeedEvents(board, call('report_transaction', { taskId: 't1' }, {}))).toEqual([
      expect.objectContaining({
        id: `board:public:invite:t1:${worker}`,
        address: worker,
        kind: 'invite.received',
        jobId: '42',
        url: 'https://dev.sidequest.exchange/job/42',
      }),
    ])
  })

  it('notifies the invited quote bidder when the public request opens', async () => {
    const { board } = await setup()
    board.run('UPDATE quote_requests SET invited_agent = ?, invited_wallet = ? WHERE id = ?', '9', worker, 'r1')
    expect(boardFeedEvents(board, call('request_quotes', {}, { requestId: 'r1' }))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'board:public:request:r1:invited',
          address: worker,
          kind: 'quote.invited',
          role: 'invited',
          summary: 'You were invited to quote on request r1.',
          url: 'https://dev.sidequest.exchange/request/r1',
          next: { tool: 'submit_quote', args: { requestId: 'r1' } },
        }),
      ]),
    )
    const events = boardFeedEvents(board, {
      ...call('request_quotes', { invite: { agentId: 'wrong' } }, { requestId: 'r1' }),
      boardId: 'team',
    })
    expect(events).toHaveLength(3)
    expect(events.filter((event) => event.kind === 'request.opened').map((event) => event.address)).toEqual([
      '*',
      creator,
    ])
    expect(events[2]).toMatchObject({
      id: 'board:team:request:r1:invited',
      address: worker,
      url: 'https://dev.sidequest.exchange/b/team/request/r1',
    })
    expect(JSON.stringify(events)).not.toMatch(/secret brief|wrong/)
  })

  it('replays the invitation once in the inbox and Telegram, using the stored wallet', async () => {
    const { board, d1 } = await setup()
    board.run('UPDATE quote_requests SET invited_agent = ?, invited_wallet = ? WHERE id = ?', '9', worker, 'r1')
    const input = call('request_quotes', { invite: { agentId: 'wrong' } }, { requestId: 'r1' })
    await recordBoardEvent(board, d1, input)
    await recordBoardEvent(board, d1, input)
    const inbox = await readInbox(d1, { network, address: worker, kinds: ['quote.invited'], now })
    expect(inbox.events).toEqual([
      expect.objectContaining({ kind: 'quote.invited', requestId: 'r1', role: 'invited', public: false }),
    ])
    expect(await d1.all('SELECT id, chat_id, text FROM telegram_outbox')).toEqual([
      {
        id: 'telegram:board:public:request:r1:invited',
        chat_id: 'chat-worker',
        text: 'You were invited to quote on request r1. https://dev.sidequest.exchange/request/r1',
      },
    ])
    expect((await readInbox(d1, { network, address: creator, kinds: ['quote.invited'], now })).events).toEqual([])
  })

  it('passes quote.invited through MCP inbox polling and subscribed webhook delivery', async () => {
    const { board, d1 } = await setup()
    board.run('UPDATE quote_requests SET invited_agent = ?, invited_wallet = ? WHERE id = ?', '9', worker, 'r1')
    const deliveries: unknown[] = []
    const transport: WebhookFetch = async (url, init) => {
      const target = url instanceof Request ? new URL(url.url) : new URL(url)
      if (target.origin === 'https://cloudflare-dns.com') {
        const type = target.searchParams.get('type')
        return Response.json({ Status: 0, Answer: type === 'A' ? [{ type: 1, data: '203.0.113.10' }] : [] })
      }
      // SAFETY: webhook verification and challenge payloads are the only JSON values this test transport returns.
      const body = (await new Response(init?.body).json()) as { type?: string; challenge?: string }
      if (body.type === 'verification') return Response.json({ challenge: body.challenge })
      deliveries.push(body)
      return new Response(null, { status: 204 })
    }
    const grant: OAuthGrant = {
      owner: creator,
      address: worker,
      chainId: 10143,
      scopes: ['sidequest:read'],
      agentIds: ['a1'],
      registryAgentId: '9',
      resource: 'https://dev.sidequest.exchange/mcp',
      clientId: 'client',
    }
    const events = new McpEvents(d1, network, { now: () => now, fetch: transport })
    expect(await events.handle('events/list', {}, grant)).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ name: 'sidequest.inbox', delivery: ['poll', 'webhook'] }),
      ]),
    })
    const params = { name: 'sidequest.inbox', arguments: { kinds: ['quote.invited'] }, cursor: 'v1:0' }
    await events.handle(
      'events/subscribe',
      {
        ...params,
        delivery: { mode: 'webhook', url: 'https://events.example/cb', secret: `whsec_${btoa('x'.repeat(32))}` },
      },
      grant,
    )
    await recordBoardEvent(board, d1, call('request_quotes', {}, { requestId: 'r1' }))
    const occurrence = expect.objectContaining({
      name: 'sidequest.inbox',
      data: expect.objectContaining({
        kind: 'quote.invited',
        requestId: 'r1',
        next: { tool: 'submit_quote', args: { requestId: 'r1' } },
      }),
    })
    expect(await events.handle('events/poll', params, grant)).toMatchObject({ events: [occurrence] })
    await deliverWebhooks(d1, network, now, { fetch: transport })
    expect(deliveries).toEqual([occurrence])
  })

  it('writes the inbox and the moved Telegram notice once, and swallows its own failures', async () => {
    const { board, d1 } = await setup()
    const selection = call('submit_selection', { taskId: 't1', nonce: '5' }, { ok: true, worker })
    await recordBoardEvent(board, d1, selection)
    await recordBoardEvent(board, d1, selection)
    expect((await readInbox(d1, { network, address: worker, now })).events.map((e) => e.kind)).toEqual([
      'selection.received',
    ])
    expect(await d1.all('SELECT id, chat_id FROM telegram_outbox')).toEqual([
      { id: 'telegram:selected:public:t1:5', chat_id: 'chat-worker' },
    ])
    const broken = {
      ...d1,
      batch: async () => {
        throw new Error('D1 down: secret-ish detail')
      },
    }
    await expect(recordBoardEvent(board, broken, selection)).resolves.toBeUndefined()
  })
})
