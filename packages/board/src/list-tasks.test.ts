import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { Board } from './service.ts'
import { fromNodeSqlite } from './store.ts'
import { canonicalJson, termsHash, type OfferTerms } from './terms.ts'

const alice = '0x1111111111111111111111111111111111111111' as const
const bob = '0x2222222222222222222222222222222222222222' as const
const carol = '0x3333333333333333333333333333333333333333' as const
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixture() {
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const read = vi.fn(async ({ functionName }: { functionName: string }): Promise<string | number | boolean> => {
    if (functionName === 'policyListed' || functionName === 'paused') return false
    throw new Error(`unexpected chain read: ${functionName}`)
  })
  const ctx = { ...base, publicClient: { ...base.publicClient, readContract: read } } as unknown as sdk.Ctx
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  const board = new Board(sql, {
    network: 'monad-testnet',
    contexts: { main: ctx },
    domain: 'list.test',
    uri: 'https://list.test',
    manifestBaseUrl: 'https://list.test/offers',
    now: () => 1000,
  })
  const add = (
    taskId: string,
    creator: `0x${string}`,
    approver: `0x${string}`,
    createdAt: number,
    quote: OfferTerms['quote'] = null,
  ) => {
    const terms: OfferTerms = {
      v: 2,
      mode: 'hire',
      taskId,
      projectId: null,
      policyVersion: null,
      title: taskId,
      brief: 'Listed',
      acceptanceCriteria: [],
      deployment: {
        chainId: ctx.deployment.chainId,
        core: ctx.deployment.core,
        holding: ctx.stack.holding,
        evaluator: ctx.stack.evaluator,
        identity: ctx.deployment.identity,
      },
      creator,
      approver,
      token: ctx.deployment.rewardTokens[0]!,
      reward: 5n,
      creatorBond: 0n,
      workerBond: 0n,
      deliveryDeadline: 2000,
      windows: { reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 },
      eligibility: null,
      evidencePolicy: null,
      quote,
      salt: sdk.EMPTY_HASH,
    }
    sql.run(
      'INSERT INTO tasks (id,creator,stack,terms_json,terms_hash,job_id,from_block,created_at) VALUES (?,?,?,?,?,?,?,?)',
      taskId,
      creator,
      'main',
      canonicalJson(terms),
      termsHash(terms),
      null,
      0,
      createdAt,
    )
  }
  const apply = (taskId: string, worker: `0x${string}`, note: string) =>
    sql.run(
      'INSERT INTO applications (id, task_id, worker, agent_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      `${taskId}-${worker.slice(2, 6)}`,
      taskId,
      worker,
      '7',
      note,
      0,
    )
  add('alice-own', alice, alice, 1)
  add('alice-judges', bob, alice, 2)
  add('invited', bob, bob, 3)
  add('picked', carol, carol, 4)
  add('applied', carol, carol, 5)
  apply('invited', alice, 'direct hire invitation')
  apply('picked', alice.toUpperCase().replace('0X', '0x') as `0x${string}`, 'picked quote q1')
  apply('applied', alice, 'I can do this')
  apply('applied', bob, 'direct hire invitation')
  return { board, read, sql, add }
}

const ids = (tasks: readonly { taskId: string }[]) => tasks.map((task) => task.taskId)

it('filters by role from board records, newest first', async () => {
  const { board } = fixture()
  const me = { address: alice }
  expect(ids(await board.listTasks(me, { role: 'creator' }))).toEqual(['alice-own'])
  expect(ids(await board.listTasks(me, { role: 'approver' }))).toEqual(['alice-judges', 'alice-own'])
  expect(ids(await board.listTasks(me, { role: 'worker' }))).toEqual(['applied', 'picked', 'invited'])
  expect(ids(await board.listTasks(me, { role: 'invited' }))).toEqual(['picked', 'invited'])
  expect(ids(await board.listTasks({ address: bob }, { role: 'invited' }))).toEqual(['applied'])
  expect(ids(await board.listTasks(me, { role: 'invited', limit: 1 }))).toEqual(['picked'])
})

it('filters by chain status and refuses unknown roles, statuses and anonymous role filters', async () => {
  const { board } = fixture()
  expect(ids(await board.listTasks({}, { status: ['awaiting-publish'] }))).toEqual([
    'applied',
    'picked',
    'invited',
    'alice-judges',
    'alice-own',
  ])
  expect(await board.listTasks({}, { status: ['open', 'active'] })).toEqual([])
  expect(ids(await board.listTasks({ address: alice }, { role: 'invited', status: ['awaiting-publish'] }))).toEqual([
    'picked',
    'invited',
  ])
  await expect(board.listTasks({}, { role: 'creator' })).rejects.toMatchObject({ code: 'unauthenticated' })
  await expect(board.listTasks({ address: alice }, { role: 'owner' as never })).rejects.toMatchObject({
    code: 'invalid',
  })
  await expect(board.listTasks({}, { status: ['done' as never] })).rejects.toMatchObject({ code: 'invalid' })
})

it('reads no chain state for tasks a role filter excludes', async () => {
  const { board, read } = fixture()
  await board.listTasks({ address: alice }, { role: 'creator' })
  // One task listed: its publish recovery and pause reads only.
  expect(read.mock.calls.length).toBeLessThanOrEqual(2)
})

it('owned requests include picked and expired history and page identical timestamps without leaks', async () => {
  const { board, sql } = fixture()
  for (let i = 0; i < 53; i++) {
    const id = `r${String(i).padStart(3, '0')}`
    sql.run(
      'INSERT INTO quote_requests (id, creator, stack, request_json, request_hash, quote_deadline, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      i === 52 ? bob : alice,
      'main',
      '{"title":"Request"}',
      id,
      i === 0 ? 999 : 1100,
      i === 1 ? 'alice-own' : null,
      100,
    )
  }
  const first = await board.listQuoteRequests({ address: alice }, { mine: true })
  expect(first.requests).toHaveLength(50)
  expect(first.nextCursor).toBeDefined()
  const second = await board.listQuoteRequests({ address: alice }, { mine: true, cursor: first.nextCursor! })
  expect(second.requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ requestId: 'r001', taskId: 'alice-own', status: 'Picked — hire linked' }),
      expect.objectContaining({ requestId: 'r000', status: 'Expired — reward not escrowed' }),
    ]),
  )
  expect([...first.requests, ...second.requests].map((r) => r.requestId)).toHaveLength(52)
  expect(new Set([...first.requests, ...second.requests].map((r) => r.requestId)).size).toBe(52)
  expect((await board.listQuoteRequests({})).some((r) => r.requestId === 'r001' || r.requestId === 'r000')).toBe(false)
  await expect(board.listQuoteRequests({}, { mine: true })).rejects.toThrow(/Sign in/)
  await expect(board.listQuoteRequests({ address: alice }, { mine: true, cursor: 'bad' })).rejects.toThrow(/cursor/)
})

it('the public list carries record time and bidder count; recent adds the last week of closed and picked requests', async () => {
  const { board, sql } = fixture()
  const week = 7 * 86_400
  // now = 1000; quote deadlines straddle it and the 7-day recent window.
  const rows: [string, number, string | null][] = [
    ['open', 1100, null],
    ['closed', 999, null],
    ['picked', 1100, 'alice-own'],
    ['stale', 1000 - week, null],
    ['stale-picked', 1000 - week - 1, 'alice-judges'],
  ]
  rows.forEach(([id, deadline, taskId], i) =>
    sql.run(
      'INSERT INTO quote_requests (id, creator, stack, request_json, request_hash, quote_deadline, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      alice,
      'main',
      '{"title":"Request","quotesCount":99,"status":"forged"}',
      id,
      deadline,
      taskId,
      500 + i,
    ),
  )
  for (const worker of [bob, carol]) {
    sql.run(
      'INSERT INTO quotes (id, request_id, worker, agent_id, token, amount, note, quote_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      `q-${worker}`,
      'open',
      worker,
      '7',
      alice,
      '1',
      '',
      '0x',
      900,
    )
  }
  const open = await board.listQuoteRequests({})
  expect(open.map((r) => r.requestId)).toEqual(['open'])
  // The board's own facts win over anything stored in the request JSON.
  expect(open[0]).toMatchObject({
    createdAt: 500,
    quotesCount: 2,
    status: 'Accepting quotes — reward not escrowed',
    taskId: null,
  })
  const recent = await board.listQuoteRequests({}, { recent: true })
  expect(recent.map((r) => [r.requestId, r.status, r.quotesCount])).toEqual([
    ['open', 'Accepting quotes — reward not escrowed', 2],
    ['picked', 'Picked — hire linked', 0],
    ['closed', 'Expired — reward not escrowed', 0],
  ])
  expect(recent.find((r) => r.requestId === 'picked')).toMatchObject({ taskId: 'alice-own' })
  await expect(board.listQuoteRequests({ address: alice }, { mine: true, recent: true } as never)).rejects.toThrow(
    /recent applies to the public list/,
  )
  expect(
    (await board.listQuoteRequests({ address: alice }, { mine: true })).requests.find((r) => r.requestId === 'open'),
  ).toMatchObject({ createdAt: 500, quotesCount: 2 })
})

it('creator dashboard keeps chain status, funding, operation and next actor separate', async () => {
  const { board } = fixture()
  const list = await board.listTasks({ address: alice }, { role: 'creator' })
  expect(list[0]).toMatchObject({
    taskId: 'alice-own',
    quotesCount: 0,
    chain: { status: 'awaiting-publish' },
    funding: { state: 'not-escrowed', source: 'chain' },
    operationStatus: null,
    nextAction: { actor: 'creator', action: 'publish', deadline: 2000 },
  })
  expect(await board.getTask({ address: alice }, { taskId: 'alice-own' })).toMatchObject({
    nextAction: { actor: 'creator', action: 'publish', deadline: 2000 },
  })
})

it('tells a bidder whether its quote won, and every bidder the winning price', async () => {
  const { board, read, sql, add } = fixture()
  const token: Readonly<Record<string, string | number>> = { decimals: 6, symbol: 'mUSD' }
  read.mockImplementation(async ({ functionName }) => token[functionName] ?? false)
  add('hire', alice, alice, 6, { requestHash: '0xreq', quoteHash: '0xcarolquote' })
  sql.run(
    'INSERT INTO quote_requests (id, creator, stack, request_json, request_hash, quote_deadline, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'req',
    alice,
    'main',
    '{"title":"Request"}',
    '0xreq',
    5000,
    'hire',
    500,
  )
  for (const [id, worker, amount, hash] of [
    ['q-bob', bob, '9000000', '0xBOBQUOTE'],
    ['q-carol', carol, '7000000', '0xCAROLQUOTE'],
  ] as const)
    sql.run(
      'INSERT INTO quotes (id, request_id, worker, agent_id, token, amount, note, quote_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      'req',
      worker,
      '7',
      alice,
      amount,
      '',
      hash,
      900,
    )
  // Gap 4: the losing bidder sees only its own quote, that it lost, and what won.
  const bobs = await board.listQuotes({ address: bob }, { requestId: 'req' })
  expect(bobs.quotes.map((q) => [q.quoteId, q.won])).toEqual([['q-bob', false]])
  expect(bobs.winning).toMatchObject({ quoteId: 'q-carol', amount: '7', symbol: 'mUSD' })
  const alices = await board.listQuotes({ address: alice }, { requestId: 'req' })
  expect(alices.quotes.map((q) => [q.quoteId, q.won])).toEqual([
    ['q-bob', false],
    ['q-carol', true],
  ])
})

it('pages task_index by cursor and drops the brief in compact mode, keeping the full default', () => {
  const { board } = fixture()
  const full = board.taskIndex({})
  expect(ids(full)).toEqual(['applied', 'picked', 'invited', 'alice-judges', 'alice-own'])
  expect(full[0]).toHaveProperty('brief', 'Listed')
  // Gap 9: an agent scanning for work reads a small compact page, then the next after its last entry.
  const first = board.taskIndex({}, { compact: true, limit: 2 })
  expect(ids(first)).toEqual(['applied', 'picked'])
  expect(first[0]).not.toHaveProperty('brief')
  const last = first.at(-1)!
  const next = board.taskIndex({}, { compact: true, limit: 2, cursor: `${last.createdAt}:${last.taskId}` })
  expect(ids(next)).toEqual(['invited', 'alice-judges'])
  expect(() => board.taskIndex({}, { cursor: 'nope' })).toThrow(/cursor/)
})
