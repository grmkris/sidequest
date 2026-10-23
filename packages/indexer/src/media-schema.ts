/**
 * Sidequest's media library (ADR-0029): groups (sections of the public kit and campaigns), assets at two levels, their
 * content-addressed files, the post plan, shares for people outside the team, and one log that is both the idempotency
 * journal and the audit trail. The API writes these tables; the indexer reads them for the morning digest, so the
 * schema lives here. `scripts/db-generate.mjs` copies every statement below into `apps/api/migrations/0002_media.sql`.
 */
import { type AsyncSql, stmt } from './store.ts'

export const MEDIA_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS media_groups (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, note TEXT, level TEXT NOT NULL,
    position INTEGER NOT NULL, featured INTEGER NOT NULL DEFAULT 0, brief_asset TEXT, starts_on TEXT, ends_on TEXT,
    status TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    revision INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS media_assets (
    id TEXT PRIMARY KEY, level TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, description TEXT, note TEXT,
    section TEXT, campaign TEXT, batch TEXT, picked INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
    width INTEGER, height INTEGER, duration REAL, captions_json TEXT NOT NULL DEFAULT '[]', source_json TEXT,
    created_by TEXT NOT NULL, created_at INTEGER NOT NULL, published_by TEXT, published_at INTEGER,
    updated_at INTEGER NOT NULL, revision INTEGER NOT NULL, deleted_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS media_assets_section ON media_assets (section, position)`,
  `CREATE INDEX IF NOT EXISTS media_assets_campaign ON media_assets (campaign, batch)`,
  `CREATE TABLE IF NOT EXISTS media_files (
    asset_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, label TEXT, key TEXT NOT NULL,
    bytes INTEGER NOT NULL, type TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY (asset_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS media_posts (
    id TEXT PRIMARY KEY, campaign TEXT, channel TEXT NOT NULL, account TEXT, day TEXT, time TEXT, text TEXT NOT NULL,
    note TEXT, asset_ids_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL, approved_by TEXT, approved_at INTEGER, url TEXT UNIQUE, posted_at INTEGER,
    recorded_by TEXT, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS media_posts_day ON media_posts (day, status)`,
  `CREATE TABLE IF NOT EXISTS media_shares (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, label TEXT, asset_ids_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL, revoked_at INTEGER, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS media_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, actor_kind TEXT NOT NULL, operator TEXT,
    operation_key TEXT, tool TEXT NOT NULL, action TEXT NOT NULL, target TEXT, result_json TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS media_log_key ON media_log (actor, operation_key) WHERE operation_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS media_log_at ON media_log (at)`,
] as const

/** Creates the media tables once per isolate's first use; every statement is idempotent. */
export async function migrateMedia(sql: AsyncSql): Promise<void> {
  await sql.batch(MEDIA_SCHEMA.map((query) => stmt(query)))
}
