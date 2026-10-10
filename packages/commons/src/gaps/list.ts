import { Effect } from 'effect'
import { CommonsSql } from '../services.ts'
import type { ListGapsInput } from '../schema/gaps.ts'
import type { Address } from '../schema/ids.ts'
import { enabled, rolesOf } from '../roles/holders.ts'
import { sqlEffect } from '../sql/effects.ts'
import { rootGap, type GapRow } from './cluster.ts'
import { gapOf, reportOf, type ReportRow } from './rows.ts'

export const listGaps = Effect.fnUntraced(function* (caller: Address | undefined, input: typeof ListGapsInput.Type) {
  const config = yield* enabled()
  const sql = yield* CommonsSql
  if (input.gapId !== undefined) {
    const gap = yield* sqlEffect(() => rootGap(sql, input.gapId!))
    const reports = sql.all<ReportRow>('SELECT * FROM commons_gap_reports WHERE gap_id=? ORDER BY id', gap.id)
    const roles = rolesOf(config, caller)
    const reveal = roles.includes('moderator') || roles.includes('maintainer')
    return { gap: gapOf(sql, gap), reports: reports.map((row) => reportOf(row, roles.length > 0, reveal)) }
  }
  const clauses = ['merged_into IS NULL']
  const params: (string | number)[] = []
  if (input.status !== undefined) {
    clauses.push('status=?')
    params.push(input.status)
  }
  if (input.gapType !== undefined) {
    clauses.push('gap_type=?')
    params.push(input.gapType)
  }
  if (input.tool !== undefined) {
    clauses.push('tool=?')
    params.push(input.tool)
  }
  if (input.cursor !== undefined) {
    clauses.push('id>?')
    params.push(Number(input.cursor.slice(2)))
  }
  const limit = input.limit ?? 50
  const rows = sql.all<GapRow>(
    `SELECT * FROM commons_gaps WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ?`,
    ...params,
    limit + 1,
  )
  const page = rows.slice(0, limit)
  return { gaps: page.map((row) => gapOf(sql, row)), cursor: rows.length > limit ? `c:${page.at(-1)!.id}` : null }
})
