import { Schema } from 'effect'
import { RoleAction } from '../schema/roles.ts'
import type { SyncSql } from '../sql/sync.ts'

interface LogRow {
  seq: number
  actor: string
  role: string
  action: string
  target_kind: string
  target_id: number
  detail_json: string
  reason: string
  created_at: number
}
function roleActionOf(row: LogRow & { subject?: string | null }): RoleAction {
  return Schema.decodeUnknownSync(RoleAction)({
    seq: row.seq,
    actor: row.actor,
    role: row.role,
    action: row.action,
    targetKind: row.target_kind,
    targetId: row.target_id,
    ...(row.subject === undefined || row.subject === null ? {} : { subject: row.subject }),
    detail: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
      row.detail_json,
    ),
    reason: row.reason,
    createdAt: row.created_at,
  })
}
export interface LogWrite {
  readonly actor: string
  readonly role: string
  readonly action: string
  readonly kind: string
  readonly id: number
  readonly detail: Readonly<Record<string, string | number>>
  readonly reason: string
  readonly now: number
}
export function writeRoleLog(sql: SyncSql, input: LogWrite): number {
  sql.run(
    `INSERT INTO commons_role_log(actor,role,action,target_kind,target_id,detail_json,reason,created_at)
    VALUES(?,?,?,?,?,?,?,?)`,
    input.actor,
    input.role,
    input.action,
    input.kind,
    input.id,
    JSON.stringify(input.detail),
    input.reason,
    input.now,
  )
  return sql.all<{ seq: number }>('SELECT seq FROM commons_role_log WHERE seq=last_insert_rowid()')[0]!.seq
}
export function itemLog(sql: SyncSql, id: number): RoleAction[] {
  return sql
    .all<LogRow>("SELECT * FROM commons_role_log WHERE target_kind='item' AND target_id=? ORDER BY seq", id)
    .map(roleActionOf)
}
// A message target carries its thread's subject, read now, so a reviewer can open what an action names.
const LOG_SELECT = `SELECT l.*, m.subject FROM commons_role_log l
  LEFT JOIN commons_messages m ON l.target_kind='message' AND m.seq=l.target_id`
export function logPage(sql: SyncSql, cursor: string | undefined, limit: number) {
  const rows =
    cursor === undefined
      ? sql.all<LogRow & { subject: string | null }>(`${LOG_SELECT} ORDER BY l.seq LIMIT ?`, limit + 1)
      : sql.all<LogRow & { subject: string | null }>(
          `${LOG_SELECT} WHERE l.seq>? ORDER BY l.seq LIMIT ?`,
          Number(cursor.slice(2)),
          limit + 1,
        )
  return { log: rows.slice(0, limit).map(roleActionOf), hasMore: rows.length > limit }
}
