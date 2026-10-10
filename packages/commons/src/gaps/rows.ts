import { Schema } from 'effect'
import { Gap, GapReport } from '../schema/gaps.ts'
import type { SyncSql } from '../sql/sync.ts'
import { hiddenOf, type HiddenRow } from '../thread/rows.ts'
import type { GapRow } from './cluster.ts'

export interface ReportRow extends HiddenRow {
  id: number
  gap_id: number
  origin_gap_id: number
  reporter: string
  what_i_needed: string
  what_i_tried: string
  suggestion: string | null
  user_goal: string | null
  created_at: number
}
export function gapOf(sql: SyncSql, gap: GapRow): Gap {
  const counts = sql.all<{ reports: number; reporters: number; first_at: number | null; last_at: number | null }>(
    'SELECT count(*) reports,count(DISTINCT reporter) reporters,min(created_at) first_at,max(created_at) last_at FROM commons_gap_reports WHERE gap_id=?',
    gap.id,
  )[0]!
  const example =
    sql.all<{ what_i_tried: string }>(
      'SELECT what_i_tried FROM commons_gap_reports WHERE gap_id=? AND hidden_at IS NULL ORDER BY id LIMIT 1',
      gap.id,
    )[0]?.what_i_tried ?? null
  const visible = sql.all<{ what_i_needed: string }>(
    'SELECT what_i_needed FROM commons_gap_reports WHERE gap_id=? AND hidden_at IS NULL ORDER BY id LIMIT 1',
    gap.id,
  )[0]
  return Schema.decodeUnknownSync(Gap)({
    id: gap.id,
    gapType: gap.gap_type,
    tool: gap.tool,
    needed: visible?.what_i_needed ?? '',
    example,
    reports: counts.reports,
    reporters: counts.reporters,
    firstAt: counts.first_at ?? gap.created_at,
    lastAt: counts.last_at ?? gap.created_at,
    itemIds: sql
      .all<{ item_id: number }>('SELECT item_id FROM commons_item_gaps WHERE gap_id=? ORDER BY item_id', gap.id)
      .map((r) => r.item_id),
    status: gap.status,
  })
}
/**
 * A report as the viewer may read it. Role holders also see the private user goal; a moderator or maintainer
 * (`reveal`) also reads hidden text, so a hide can be reviewed. Everyone else sees a hidden report's text as null.
 */
export function reportOf(row: ReportRow, roleHolder: boolean, reveal = false): GapReport {
  const visible = row.hidden_at === null || reveal
  return {
    id: row.id,
    gapId: row.gap_id,
    originGapId: row.origin_gap_id,
    reporter: row.reporter,
    whatINeeded: visible ? row.what_i_needed : null,
    whatITried: visible ? row.what_i_tried : null,
    suggestion: visible ? row.suggestion : null,
    ...(roleHolder ? { userGoal: visible ? row.user_goal : null } : {}),
    hidden: hiddenOf(row),
    createdAt: row.created_at,
  }
}
