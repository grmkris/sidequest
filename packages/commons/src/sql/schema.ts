import type { Address } from '../schema/ids.ts'
import type { SyncSql } from './sync.ts'

const hiddenColumns = `hidden_at INTEGER, hidden_by TEXT, hidden_role TEXT, hidden_reason TEXT, hidden_log_seq INTEGER`
export const COMMONS_DDL = [
  `CREATE TABLE IF NOT EXISTS commons_messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, subject_kind TEXT NOT NULL,
    board_id TEXT, task_id TEXT, item_id INTEGER, author TEXT NOT NULL, badges_json TEXT NOT NULL,
    body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000), reply_to INTEGER, mentions_json TEXT NOT NULL,
    ${hiddenColumns}, created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS commons_messages_subject ON commons_messages(subject, seq)`,
  `CREATE INDEX IF NOT EXISTS commons_messages_reply ON commons_messages(reply_to)`,
  `CREATE INDEX IF NOT EXISTS commons_messages_author ON commons_messages(author, created_at)`,
  `CREATE TABLE IF NOT EXISTS commons_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, problem TEXT NOT NULL, proposal TEXT NOT NULL,
    proposer TEXT NOT NULL, proposer_stake TEXT NOT NULL, proposer_block TEXT, status TEXT NOT NULL,
    merged_into INTEGER, ${hiddenColumns}, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS commons_item_gaps (item_id INTEGER NOT NULL, gap_id INTEGER NOT NULL, PRIMARY KEY(item_id, gap_id))`,
  `CREATE TABLE IF NOT EXISTS commons_supports (
    item_id INTEGER NOT NULL, voter TEXT NOT NULL, created_at INTEGER NOT NULL, withdrawn_at INTEGER,
    PRIMARY KEY(item_id, voter)
  )`,
  `CREATE INDEX IF NOT EXISTS commons_supports_voter ON commons_supports(voter, item_id) WHERE withdrawn_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS commons_supports_item ON commons_supports(item_id, voter) WHERE withdrawn_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS commons_gaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, gap_type TEXT NOT NULL,
    tool TEXT, needed TEXT NOT NULL, merged_into INTEGER, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS commons_gap_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, gap_id INTEGER NOT NULL, origin_gap_id INTEGER NOT NULL,
    reporter TEXT NOT NULL, what_i_needed TEXT NOT NULL, what_i_tried TEXT NOT NULL, suggestion TEXT, user_goal TEXT,
    ${hiddenColumns}, created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS commons_reports_gap ON commons_gap_reports(gap_id, id)`,
  `CREATE TABLE IF NOT EXISTS commons_role_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL,
    target_kind TEXT NOT NULL, target_id INTEGER NOT NULL, detail_json TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS commons_stake_cache (
    address TEXT PRIMARY KEY, stake TEXT NOT NULL, stake_block TEXT NOT NULL, backing_total TEXT NOT NULL,
    backs_json TEXT NOT NULL, backing_block TEXT NOT NULL, read_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS commons_rate (key TEXT PRIMARY KEY, used INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
]

/** Columns added after the first deploy, each added once when missing (SQLite has no ADD COLUMN IF NOT EXISTS). */
const ADDED_COLUMNS: readonly (readonly [table: string, column: string, type: string])[] = [
  ['commons_gaps', 'status', "TEXT NOT NULL DEFAULT 'open'"],
  ['commons_gaps', 'status_at', 'INTEGER'],
]

/** Idempotent, additive runtime DDL. The host supplies the configured Maintainer and Clock time. */
export function migrate(sql: SyncSql, maintainer: Address, now = 0): void {
  for (const ddl of COMMONS_DDL) sql.run(ddl)
  for (const [table, column, type] of ADDED_COLUMNS)
    if (!sql.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).some((c) => c.name === column))
      sql.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  sql.run(
    `INSERT OR IGNORE INTO commons_items
    (id,title,problem,proposal,proposer,proposer_stake,proposer_block,status,created_at,updated_at)
    VALUES (1,?,?,?,?,?,'0','open',?,?)`,
    'Roles voted in by stakers',
    'Ecosystem roles currently come from stage configuration.',
    'Let active stakers elect ecosystem role holders through a future governance proposal.',
    maintainer.toLowerCase(),
    '0',
    now,
    now,
  )
  // The first dev deploy seeded item 1 with milliseconds; public timestamps are Unix seconds.
  sql.run(
    'UPDATE commons_items SET created_at = created_at / 1000, updated_at = updated_at / 1000 WHERE id = 1 AND created_at > 100000000000',
  )
}
