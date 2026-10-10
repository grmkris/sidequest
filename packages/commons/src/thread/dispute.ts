import { Effect, Schema } from 'effect'
import { Subject } from '../schema/ids.ts'
import { CommonsSql } from '../services.ts'
import { enabled } from '../roles/holders.ts'
import { messageOf, type MessageRow } from './rows.ts'

/** Host appends this context after computing bundleHash: it never participates in the frozen hash. */
export const getDisputeThread = Effect.fnUntraced(function* (boardId: string, taskId: string) {
  yield* enabled()
  const sql = yield* CommonsSql
  const subject = Schema.decodeUnknownSync(Subject)(`job:${boardId}:${taskId}`)
  const rows = sql
    .all<MessageRow>('SELECT * FROM commons_messages WHERE subject=? ORDER BY seq DESC LIMIT 100', subject)
    .toReversed()
  return rows.map((row) => messageOf(row))
})
