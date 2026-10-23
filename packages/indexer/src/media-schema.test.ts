import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { MEDIA_SCHEMA, migrateMedia } from './media-schema.ts'
import { fromNodeSqlite, stmt } from './store.ts'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

const logRow = (actor: string, key: string | null) =>
  stmt(
    "INSERT INTO media_log (actor, actor_kind, operation_key, tool, action, result_json, at) VALUES (?, 'wallet', ?, 'update_media', 'asset.update', '{}', 1)",
    actor,
    key,
  )

const planRow = (id: string, url: string | null) =>
  stmt(
    "INSERT INTO media_posts (id, channel, text, status, url, created_by, created_at, updated_at, revision) VALUES (?, 'x', 't', 'draft', ?, 'wallet:0xa', 1, 1, 1)",
    id,
    url,
  )

function database() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  return fromNodeSqlite(db)
}

it('creates the media tables, and running it again changes nothing', async () => {
  const sql = database()
  await migrateMedia(sql)
  await migrateMedia(sql)
  const tables = await sql.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'media_%' ORDER BY name",
  )
  expect(tables.map((t) => t.name)).toEqual([
    'media_assets',
    'media_files',
    'media_groups',
    'media_log',
    'media_posts',
    'media_shares',
  ])
})

it('keeps one log row per actor and operation key, and any number without a key', async () => {
  const sql = database()
  await migrateMedia(sql)
  await sql.batch([
    logRow('wallet:0xa', 'k1'),
    logRow('wallet:0xb', 'k1'),
    logRow('wallet:0xa', null),
    logRow('wallet:0xa', null),
  ])
  await expect(sql.batch([logRow('wallet:0xa', 'k1')])).rejects.toThrow()
  expect((await sql.all<{ n: number }>('SELECT COUNT(*) n FROM media_log'))[0]?.n).toBe(4)
})

it('lets many unposted plans share a missing URL but never two posts one URL', async () => {
  const sql = database()
  await migrateMedia(sql)
  await sql.batch([planRow('p1', null), planRow('p2', null), planRow('p3', 'https://x.com/sidequest/status/1')])
  await expect(sql.batch([planRow('p4', 'https://x.com/sidequest/status/1')])).rejects.toThrow()
})

it('is the migration the release applies, statement for statement', () => {
  const migration = readFileSync(new URL('../../../apps/api/migrations/0002_media.sql', import.meta.url), 'utf8')
  const statements = migration
    .split(';\n')
    .map((s) => s.trim())
    .filter(Boolean)
  expect(statements.map((s) => s.replace(/\s+/g, ' '))).toEqual(MEDIA_SCHEMA.map((s) => s.replace(/\s+/g, ' ')))
})
