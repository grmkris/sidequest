import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { fromNodeSqlite, migrate, stmt } from './store.ts'
import { feedFromDeadlines, readInbox } from './feed.ts'
import { eventPage } from './mcp-events.ts'

const creator = '0x1111111111111111111111111111111111111111'
const worker = '0x2222222222222222222222222222222222222222'
const now = 2_000_000
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
async function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  await migrate(sql)
  const job = (id: string, status: string, deadline = now - 1, settlement = 'None') =>
    sql.batch([
      stmt(
        `INSERT INTO jobs (chain_id, job_id, creator, worker, status, delivery_deadline, dispute_window, settlement_outcome, updated_block)
     VALUES (10143, ?, ?, ?, ?, ?, 3600, ?, 1)`,
        id,
        creator,
        worker,
        status,
        deadline,
        settlement,
      ),
    ])
  const inbox = (address = creator) => readInbox(sql, { network: 'monad-testnet', address, now, scope: 'own' })
  return { sql, job, inbox }
}

it('writes overdue rows once across retries, skips future deadlines, completed jobs and settled jobs', async () => {
  const f = await fixture()
  await f.job('1', 'active')
  await f.job('2', 'active', now + 1)
  await f.job('3', 'completed')
  await f.job('4', 'active', now - 1, 'Paid')
  await f.job('5', 'active', now)
  await f.job('6', 'activated')
  await feedFromDeadlines(f.sql, 'monad-testnet', now)
  await feedFromDeadlines(f.sql, 'monad-testnet', now)
  expect((await f.inbox()).events.map((event) => event.id)).toEqual([
    'deadline:10143:1:delivery',
    'deadline:10143:6:delivery',
  ])
  expect((await f.inbox(worker)).events).toEqual([])
  const jobs = await eventPage(f.sql, 'monad-testnet', creator, { name: 'sidequest.jobs' }, now)
  expect(jobs.events.map((event) => event.data.title)).toEqual(['Delivery overdue', 'Delivery overdue'])
})

it('uses the rejection block time and frozen dispute window, notifying both parties once with settlement hints', async () => {
  const f = await fixture()
  await f.sql.batch([
    stmt('CREATE TABLE board_offers (terms_hash TEXT, board_id TEXT, task_id TEXT)'),
    stmt("INSERT INTO board_offers VALUES ('hash', 'b1', 't1')"),
  ])
  for (const [id, status] of [
    ['1', 'rejected-pending'],
    ['2', 'rejected-pending'],
    ['3', 'disputed'],
    ['4', 'rejected-pending'],
    ['5', 'rejected-pending'],
  ] as const) {
    await f.job(id, status)
    await f.sql.batch([stmt('INSERT INTO events VALUES (10143, ?, 10, 0, ?, ?, ?, ?)', id, 'tx', id, 'Rejected', '{}')])
  }
  await f.sql.batch([
    stmt('INSERT INTO block_times VALUES (10143, 10, ?)', now - 3601),
    stmt("UPDATE jobs SET manifest_hash='hash' WHERE job_id='1'"),
    stmt("UPDATE jobs SET dispute_window=3601 WHERE job_id='2'"),
    stmt("UPDATE jobs SET settlement_outcome='Refunded' WHERE job_id='4'"),
    stmt("UPDATE events SET block=11 WHERE job_id='5'"),
  ])
  await feedFromDeadlines(f.sql, 'monad-testnet', now)
  await feedFromDeadlines(f.sql, 'monad-testnet', now)
  for (const address of [creator, worker]) {
    const events = (await f.inbox(address)).events
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'job.settleable',
      jobId: '1',
      occurredAt: now - 1,
      next: { tool: 'settlement_actions', args: { taskId: 't1' } },
    })
  }
})

it('ignores an absent directory table and null expiry; expiring ads notify their wallet once across audiences and retries', async () => {
  const f = await fixture()
  await feedFromDeadlines(f.sql, 'monad-testnet', now)
  await f.sql.batch([
    stmt('CREATE TABLE directory_agents (chain_id INTEGER, agent_id TEXT, enrolled INTEGER, json TEXT)'),
  ])
  const agent = {
    wallet: worker,
    ads: [
      { adHash: 'soon', expiresAt: now + 4 * 3600 },
      { adHash: 'durable', expiresAt: null },
      { adHash: 'later', expiresAt: now + 4 * 3600 + 1 },
      { adHash: 'expired', expiresAt: now },
      { adHash: 'string', expiresAt: String(now + 1) },
    ],
  }
  for (const chainId of [10143, 10143, 143])
    await f.sql.batch([stmt('INSERT INTO directory_agents VALUES (?, ?, 1, ?)', chainId, '7', JSON.stringify(agent))])
  await feedFromDeadlines(f.sql, 'monad-testnet', now)
  await feedFromDeadlines(f.sql, 'monad-testnet', now)
  expect((await f.inbox()).events).toEqual([])
  expect((await f.inbox(worker)).events).toEqual([
    expect.objectContaining({
      id: 'listing:10143:7:soon:expiring',
      kind: 'listing.expiring',
      next: { tool: 'advertise_service', args: {} },
    }),
  ])
})
