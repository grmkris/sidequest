import { nowSeconds } from '../time.ts'
import { Effect, Schema } from 'effect'
import { CommonsSql, FeedSink } from '../services.ts'
import {
  HideContentOutput,
  UnhideContentOutput,
  type ContentActionInput,
  type SetItemStatusInput,
} from '../schema/roles.ts'
import { requireRole } from './holders.ts'
import { writeRoleLog } from './log.ts'
import { sqlEffect } from '../sql/effects.ts'
import { Conflict, NotFound } from '../errors.ts'
import { activeSupports, itemOf, requireItem } from '../roadmap/common.ts'
import { hiddenEvent, statusEvents } from '../feed.ts'
import type { SyncSql } from '../sql/sync.ts'
import { reportersOf } from './gap-actions.ts'

const targets = {
  message: { table: 'commons_messages', id: 'seq', author: 'author' },
  item: { table: 'commons_items', id: 'id', author: 'proposer' },
  gap_report: { table: 'commons_gap_reports', id: 'id', author: 'reporter' },
}
function contentTarget(sql: SyncSql, input: typeof ContentActionInput.Type) {
  const target = targets[input.kind]
  const row = sql.all<{ address: string; subject?: string; gap_id?: number }>(
    `SELECT ${target.author} address${input.kind === 'message' ? ',subject' : ''}${input.kind === 'gap_report' ? ',gap_id' : ''} FROM ${target.table} WHERE ${target.id}=?`,
    input.id,
  )[0]
  if (row === undefined) throw new NotFound({ message: 'Content not found' })
  return { ...target, row }
}
export const hideContent = Effect.fnUntraced(function* (
  caller: string | undefined,
  input: typeof ContentActionInput.Type,
) {
  const actor = yield* requireRole(caller)
  const now = yield* nowSeconds
  const sql = yield* CommonsSql
  const result = yield* sqlEffect(() =>
    sql.transaction((tx) => {
      const target = contentTarget(tx, input)
      const logSeq = writeRoleLog(tx, {
        actor: actor.address,
        role: actor.role,
        action: 'hide',
        kind: input.kind,
        id: input.id,
        detail: {},
        reason: input.reason,
        now,
      })
      tx.run(
        `UPDATE ${target.table} SET hidden_at=?,hidden_by=?,hidden_role=?,hidden_reason=?,hidden_log_seq=? WHERE ${target.id}=?`,
        now,
        actor.address,
        actor.role,
        input.reason,
        logSeq,
        input.id,
      )
      const response = Schema.decodeUnknownSync(HideContentOutput)({
        kind: input.kind,
        id: input.id,
        hidden: { role: actor.role, reason: input.reason, at: now, logSeq },
        logSeq,
      })
      const event = hiddenEvent({
        id: input.id,
        kind: input.kind,
        logSeq,
        address: target.row.address,
        now,
        ...(target.row.subject === undefined ? {} : { subject: target.row.subject }),
        ...(target.row.gap_id === undefined ? {} : { gapId: target.row.gap_id }),
      })
      return { response, event }
    }),
  )
  yield* (yield* FeedSink).write([result.event])
  return result.response
})
export const unhideContent = Effect.fnUntraced(function* (
  caller: string | undefined,
  input: typeof ContentActionInput.Type,
) {
  const actor = yield* requireRole(caller)
  const now = yield* nowSeconds
  const sql = yield* CommonsSql
  return yield* sqlEffect(() =>
    sql.transaction((tx) => {
      const target = contentTarget(tx, input)
      const logSeq = writeRoleLog(tx, {
        actor: actor.address,
        role: actor.role,
        action: 'unhide',
        kind: input.kind,
        id: input.id,
        detail: {},
        reason: input.reason,
        now,
      })
      tx.run(
        `UPDATE ${target.table} SET hidden_at=NULL,hidden_by=NULL,hidden_role=NULL,hidden_reason=NULL,hidden_log_seq=NULL WHERE ${target.id}=?`,
        input.id,
      )
      return UnhideContentOutput.make({ kind: input.kind, id: input.id, hidden: null, logSeq })
    }),
  )
})
export const setItemStatus = Effect.fnUntraced(function* (
  caller: string | undefined,
  input: typeof SetItemStatusInput.Type,
) {
  const actor = yield* requireRole(caller, true)
  const now = yield* nowSeconds
  const sql = yield* CommonsSql
  const result = yield* sqlEffect(() =>
    sql.transaction((tx) => {
      const previous = requireItem(tx, input.itemId)
      const opening =
        previous.merged_into === null &&
        !['open', 'planned', 'building'].includes(previous.status) &&
        ['open', 'planned', 'building'].includes(input.status)
      if (opening) {
        const voters = tx.all<{ voter: string }>(
          'SELECT voter FROM commons_supports WHERE item_id=? AND withdrawn_at IS NULL',
          input.itemId,
        )
        if (voters.some((row) => activeSupports(tx, row.voter) >= 5))
          throw new Conflict({ message: 'Reopening would exceed an existing voter support cap' })
      }
      const logSeq = writeRoleLog(tx, {
        actor: actor.address,
        role: actor.role,
        action: 'set_status',
        kind: 'item',
        id: previous.id,
        detail: { from: previous.status, status: input.status },
        reason: input.reason,
        now,
      })
      tx.run('UPDATE commons_items SET status=?,updated_at=? WHERE id=?', input.status, now, input.itemId)
      const supporters = tx
        .all<{ voter: string }>(
          'SELECT voter FROM commons_supports WHERE item_id=? AND withdrawn_at IS NULL ORDER BY created_at,voter LIMIT 100',
          input.itemId,
        )
        .map((r) => r.voter)
      const gapIds = tx
        .all<{ gap_id: number }>('SELECT gap_id FROM commons_item_gaps WHERE item_id=?', input.itemId)
        .map((r) => r.gap_id)
      const reporters = reportersOf(tx, gapIds)
      return { item: itemOf(tx, requireItem(tx, input.itemId)), logSeq, supporters, reporters }
    }),
  )
  yield* (yield* FeedSink).write(
    statusEvents({
      itemId: input.itemId,
      logSeq: result.logSeq,
      proposer: result.item.proposer,
      supporters: result.supporters,
      reporters: result.reporters,
      now,
    }),
  )
  return { item: result.item, logSeq: result.logSeq }
})
