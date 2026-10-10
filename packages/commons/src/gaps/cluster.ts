import { NotFound, Conflict } from '../errors.ts'
import type { ReportGapInput } from '../schema/gaps.ts'
import type { SyncSql } from '../sql/sync.ts'

export interface GapRow {
  id: number
  key: string
  gap_type: string
  tool: string | null
  needed: string
  merged_into: number | null
  status: string
  created_at: number
}
function clusterKey(input: typeof ReportGapInput.Type): string {
  const needed = input.what_i_needed.normalize('NFC').trim().toLowerCase().replace(/\s+/gu, ' ').slice(0, 200)
  return `${input.gap_type}|${input.tool ?? ''}|${needed}`
}
export function rootGap(sql: SyncSql, id: number): GapRow {
  let row = sql.all<GapRow>('SELECT * FROM commons_gaps WHERE id=?', id)[0]
  const seen = new Set<number>()
  while (row !== undefined && row.merged_into !== null) {
    if (seen.has(row.id)) throw new Conflict({ message: 'Gap merge cycle' })
    seen.add(row.id)
    row = sql.all<GapRow>('SELECT * FROM commons_gaps WHERE id=?', row.merged_into)[0]
  }
  if (row === undefined) throw new NotFound({ message: 'Gap not found' })
  return row
}
export function resolveCluster(sql: SyncSql, input: typeof ReportGapInput.Type, now: number) {
  const key = clusterKey(input)
  const existing = sql.all<GapRow>('SELECT * FROM commons_gaps WHERE key=?', key)[0]
  if (existing !== undefined) return { origin: existing.id, root: rootGap(sql, existing.id).id, duplicate: true }
  sql.run(
    'INSERT INTO commons_gaps(key,gap_type,tool,needed,created_at) VALUES(?,?,?,?,?)',
    key,
    input.gap_type,
    input.tool ?? null,
    input.what_i_needed,
    now,
  )
  const id = sql.all<{ id: number }>('SELECT id FROM commons_gaps WHERE id=last_insert_rowid()')[0]!.id
  return { origin: id, root: id, duplicate: false }
}
