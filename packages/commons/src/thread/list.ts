import { Effect } from 'effect'
import type { Address } from '../schema/ids.ts'
import type { ListMessagesInput, ListMessagesOutput } from '../schema/messages.ts'
import { CommonsSql } from '../services.ts'
import { enabled, rolesOf } from '../roles/holders.ts'
import { subjectContext } from './subject.ts'
import { threadViewer } from './access.ts'
import { messageOf, type MessageRow } from './rows.ts'

export const listMessages = Effect.fnUntraced(function* (
  caller: Address | undefined,
  input: typeof ListMessagesInput.Type,
) {
  const config = yield* enabled()
  const roles = rolesOf(config, caller)
  const reveal = roles.includes('moderator') || roles.includes('maintainer')
  const { participants } = yield* subjectContext(input.subject)
  const sql = yield* CommonsSql
  const limit = input.limit ?? 50
  const params: (string | number)[] = [input.subject]
  const clauses = ['subject=?']
  if (input.after !== undefined) {
    clauses.push('seq>?')
    params.push(Number(input.after.slice(2)))
  }
  if (input.before !== undefined) {
    clauses.push('seq<?')
    params.push(Number(input.before.slice(2)))
  }
  const ascending = input.after !== undefined
  const rows = sql.all<MessageRow>(
    `SELECT * FROM commons_messages WHERE ${clauses.join(' AND ')} ORDER BY seq ${ascending ? 'ASC' : 'DESC'} LIMIT ?`,
    ...params,
    limit + 1,
  )
  const page = rows.slice(0, limit)
  if (!ascending) page.reverse()
  const cursorRow = input.before === undefined ? page.at(-1) : page[0]
  const result: typeof ListMessagesOutput.Type = {
    subject: input.subject,
    messages: page.map((row) => messageOf(row, reveal)),
    cursor: cursorRow === undefined ? null : `c:${cursorRow.seq}`,
    hasMore: rows.length > limit,
    nextPollSeconds: 10 satisfies 10,
    viewer: yield* threadViewer(caller, participants),
  }
  return result
})
