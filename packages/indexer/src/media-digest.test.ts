import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import type { StageMedia } from '../../../infra/stage.ts'
import { localDay, queueMediaDigest } from './media-digest.ts'
import { migrateMedia } from './media-schema.ts'
import { fromNodeSqlite, stmt } from './store.ts'
import { migrateTelegram } from './telegram.ts'

const LINKED = '0x1111111111111111111111111111111111111111'
const UNLINKED = '0x2222222222222222222222222222222222222222'
const media: StageMedia = {
  team: [
    { wallet: LINKED, role: 'operator' },
    { wallet: UNLINKED, role: 'member' },
  ],
  timezone: 'Europe/Ljubljana',
  pullHosts: [],
}
// Friday 23 October 2026, 08:30 in Ljubljana (CEST, UTC+2).
const morning = Date.UTC(2026, 9, 23, 6, 30) / 1000

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

async function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  await migrateTelegram(sql)
  await migrateMedia(sql)
  await sql.batch([
    stmt(
      "INSERT INTO telegram_links (chat_id, chain_id, wallet, username, linked_at) VALUES ('chat-1', 10143, ?, 'kris', 1)",
      LINKED.toLowerCase(),
    ),
  ])
  return sql
}

const post = (id: string, day: string, status: string, time: string | null = null) =>
  stmt(
    "INSERT INTO media_posts (id, channel, account, day, time, text, status, created_by, created_at, updated_at, revision) VALUES (?, 'x', '@sidequest', ?, ?, ?, ?, 'wallet:0x1', 1, 1, 1)",
    id,
    day,
    time,
    `Post ${id}`,
    status,
  )

it('reads the local day and hour across the end of daylight saving', () => {
  expect(localDay(morning, 'Europe/Ljubljana')).toMatchObject({ day: '2026-10-23', hour: 8 })
  // Sunday 25 October: clocks go back at 03:00, so 08:00 local is 07:00 UTC.
  expect(localDay(Date.UTC(2026, 9, 25, 7, 0) / 1000, 'Europe/Ljubljana')).toMatchObject({ day: '2026-10-25', hour: 8 })
  expect(localDay(Date.UTC(2026, 9, 24, 6, 0) / 1000, 'Europe/Ljubljana')).toMatchObject({ day: '2026-10-24', hour: 8 })
  expect(localDay(Date.UTC(2026, 9, 23, 22, 30) / 1000, 'Europe/Ljubljana').day).toBe('2026-10-24')
})

it("queues one digest a day for each linked team wallet, only between 08:00 and 11:00, with today's plan", async () => {
  const sql = await fixture()
  await sql.batch([
    post('p1', '2026-10-23', 'approved', '10:00'),
    post('p2', '2026-10-24', 'draft'),
    post('p3', '2026-10-23', 'posted'),
  ])
  expect(await queueMediaDigest(sql, 'monad-testnet', media, morning - 3600)).toBe(0)
  expect(await queueMediaDigest(sql, 'monad-testnet', media, morning)).toBe(2)
  const [queued] = await sql.all<{ id: string; chat_id: string; text: string }>(
    'SELECT id, chat_id, text FROM telegram_outbox',
  )
  expect(queued?.id).toBe(`media-digest:2026-10-23:${LINKED.toLowerCase()}`)
  expect(queued?.chat_id).toBe('chat-1')
  expect(queued?.text).toContain('To post today (1):')
  expect(queued?.text).toContain('10:00, x @sidequest: Post p1')
  expect(queued?.text).toContain('Waiting for approval: 1 draft.')
  expect(queued?.text).not.toContain('Post p3')
  // The next minute sends nothing new; the unlinked wallet never gets a row.
  await queueMediaDigest(sql, 'monad-testnet', media, morning + 60)
  expect((await sql.all<{ n: number }>('SELECT COUNT(*) n FROM telegram_outbox'))[0]?.n).toBe(1)
  expect(await queueMediaDigest(sql, 'monad-testnet', media, morning + 3 * 3600)).toBe(0)
})

it('names what agents published and approved since yesterday, and stays quiet with nothing to say', async () => {
  const sql = await fixture()
  expect(await queueMediaDigest(sql, 'monad-testnet', media, morning)).toBe(0)
  await sql.batch([
    stmt(
      "INSERT INTO media_log (actor, actor_kind, operator, operation_key, tool, action, target, result_json, at) VALUES ('agent:reel', 'agent', ?, 'k1', 'publish_media', 'asset.publish', 'since-launch-main', '{}', ?)",
      LINKED,
      morning - 3600,
    ),
    stmt(
      "INSERT INTO media_log (actor, actor_kind, operation_key, tool, action, target, result_json, at) VALUES ('wallet:0x1', 'wallet', 'k2', 'publish_media', 'asset.publish', 'by-hand', '{}', ?)",
      morning - 3600,
    ),
  ])
  await queueMediaDigest(sql, 'monad-testnet', media, morning)
  const [queued] = await sql.all<{ text: string }>('SELECT text FROM telegram_outbox')
  expect(queued?.text).toContain('Agents since yesterday:\npublished since-launch-main')
  expect(queued?.text).not.toContain('by-hand')
  expect(queued?.text).toContain('Nothing approved to post today.')
})
