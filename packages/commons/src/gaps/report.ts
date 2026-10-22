import { nowSeconds } from '../time.ts'
import { Effect } from 'effect'
import { FeedSink, CommonsSql } from '../services.ts'
import type { ReportGapInput } from '../schema/gaps.ts'
import type { Address } from '../schema/ids.ts'
import { takeRate } from '../rate.ts'
import { authenticated, enabled } from '../roles/holders.ts'
import { sqlEffect } from '../sql/effects.ts'
import { resolveCluster } from './cluster.ts'
import { roleHolderEvents } from '../feed.ts'

export const reportGap = Effect.fnUntraced(function* (caller: Address | undefined, input: typeof ReportGapInput.Type) {
  const config = yield* enabled()
  const address = yield* authenticated(caller)
  const now = yield* nowSeconds
  const sql = yield* CommonsSql
  const result = yield* sqlEffect(() =>
    sql.transaction((tx) => {
      takeRate(tx, 'report_gap', address, now)
      const cluster = resolveCluster(tx, input, now)
      tx.run(
        `INSERT INTO commons_gap_reports(gap_id,origin_gap_id,reporter,what_i_needed,what_i_tried,suggestion,user_goal,created_at)
      VALUES(?,?,?,?,?,?,?,?)`,
        cluster.root,
        cluster.origin,
        address,
        input.what_i_needed,
        input.what_i_tried,
        input.suggestion ?? null,
        input.user_goal ?? null,
        now,
      )
      const id = tx.all<{ id: number }>('SELECT id FROM commons_gap_reports WHERE id=last_insert_rowid()')[0]!.id
      const counts = tx.all<{ reports: number; reporters: number }>(
        'SELECT count(*) reports,count(DISTINCT reporter) reporters FROM commons_gap_reports WHERE gap_id=?',
        cluster.root,
      )[0]!
      return {
        reportId: id,
        gapId: cluster.root,
        reports: counts.reports,
        reporters: counts.reporters,
        duplicate: cluster.duplicate,
      }
    }),
  )
  yield* (yield* FeedSink).write(
    roleHolderEvents({ kind: 'gap.reported', prefix: `commons:r${result.reportId}`, id: result.gapId, now }, config),
  )
  return result
})
