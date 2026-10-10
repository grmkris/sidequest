import { Effect } from 'effect'
import { nowSeconds } from '../time.ts'
import { CommonsSql, FeedSink } from '../services.ts'
import type { SetGapStatusInput } from '../schema/gaps.ts'
import type { LinkGapsInput } from '../schema/roadmap.ts'
import { requireRole } from './holders.ts'
import { writeRoleLog } from './log.ts'
import { sqlEffect } from '../sql/effects.ts'
import { Conflict } from '../errors.ts'
import { rootGap } from '../gaps/cluster.ts'
import { gapOf } from '../gaps/rows.ts'
import { itemOf, requireItem } from '../roadmap/common.ts'
import { gapStatusEvents } from '../feed.ts'
import type { SyncSql } from '../sql/sync.ts'

/** Everyone who reported into these gap clusters, once each, oldest report first. */
export function reportersOf(sql: SyncSql, gapIds: readonly number[]): string[] {
  if (gapIds.length === 0) return []
  return sql
    .all<{ reporter: string }>(
      `SELECT reporter FROM commons_gap_reports WHERE gap_id IN (${gapIds.map(() => '?').join(',')})
      GROUP BY lower(reporter) ORDER BY min(id) LIMIT 100`,
      ...gapIds,
    )
    .map((row) => row.reporter)
}

/** Maintainer: tie gap clusters to the roadmap item that addresses them, so its status reaches their reporters. */
export const linkGaps = Effect.fnUntraced(function* (caller: string | undefined, input: typeof LinkGapsInput.Type) {
  const actor = yield* requireRole(caller, true)
  const now = yield* nowSeconds
  const sql = yield* CommonsSql
  return yield* sqlEffect(() =>
    sql.transaction((tx) => {
      const item = requireItem(tx, input.itemId)
      if (item.merged_into !== null) throw new Conflict({ message: 'Link gaps to the item it was merged into' })
      const gapIds = [...new Set(input.gapIds.map((id) => rootGap(tx, id).id))]
      let linked = 0
      for (const gapId of gapIds) {
        tx.run('INSERT OR IGNORE INTO commons_item_gaps(item_id,gap_id) VALUES(?,?)', item.id, gapId)
        linked += tx.all<{ count: number }>('SELECT changes() count')[0]!.count
      }
      const logSeq = writeRoleLog(tx, {
        actor: actor.address,
        role: actor.role,
        action: 'link_gaps',
        kind: 'item',
        id: item.id,
        detail: { gapIds: gapIds.join(',') },
        reason: input.reason,
        now,
      })
      return { item: itemOf(tx, requireItem(tx, item.id)), linked, logSeq }
    }),
  )
})

/** Maintainer: mark a gap cluster fixed, won't fix, or open again; every reporter hears of it. */
export const setGapStatus = Effect.fnUntraced(function* (
  caller: string | undefined,
  input: typeof SetGapStatusInput.Type,
) {
  const actor = yield* requireRole(caller, true)
  const now = yield* nowSeconds
  const sql = yield* CommonsSql
  const result = yield* sqlEffect(() =>
    sql.transaction((tx) => {
      const gap = rootGap(tx, input.gapId)
      const logSeq = writeRoleLog(tx, {
        actor: actor.address,
        role: actor.role,
        action: 'set_gap_status',
        kind: 'gap',
        id: gap.id,
        detail: { from: gap.status, status: input.status },
        reason: input.reason,
        now,
      })
      tx.run('UPDATE commons_gaps SET status=?,status_at=? WHERE id=?', input.status, now, gap.id)
      return { gap: gapOf(tx, rootGap(tx, gap.id)), logSeq, reporters: reportersOf(tx, [gap.id]) }
    }),
  )
  if (result.gap.status !== 'open')
    yield* (yield* FeedSink).write(
      gapStatusEvents({ gapId: result.gap.id, logSeq: result.logSeq, reporters: result.reporters, now }),
    )
  return { gap: result.gap, logSeq: result.logSeq }
})
