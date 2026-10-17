import { Conflict, NotFound, Unavailable } from '../errors.ts'
import { snapshotBadges } from '../badges.ts'
import { takeRate } from '../rate.ts'
import type { Address } from '../schema/ids.ts'
import type { Mention, PostMessageInput } from '../schema/messages.ts'
import type { Role } from '../schema/roles.ts'
import type { ParticipantsSnapshot, StakePosition } from '../services.ts'
import type { SyncSql } from '../sql/sync.ts'
import { messageOf, type MessageRow } from './rows.ts'
import { parseSubject } from './subject.ts'
import type { Presentation } from '@sidequest/sdk/commons-ui'

interface ReplyRow {
  subject: string
  author: Address
  reply_to: number | null
  hidden_at: number | null
}
interface InsertPost {
  readonly address: Address
  readonly input: typeof PostMessageInput.Type
  readonly mentions: readonly (typeof Mention.Type)[]
  readonly people: ParticipantsSnapshot | null
  readonly roles: readonly Role[]
  readonly stake: StakePosition | null
  readonly now: number
  readonly presentation: Presentation | null
}
function replyTarget(sql: SyncSql, subject: string, id: number | undefined) {
  if (id === undefined) return { replyTo: null, parentAuthor: null }
  const row = sql.all<ReplyRow>('SELECT subject,author,reply_to,hidden_at FROM commons_messages WHERE seq=?', id)[0]
  if (row === undefined) throw new NotFound({ message: 'Reply target not found' })
  if (row.subject !== subject || row.hidden_at !== null) throw new Conflict({ message: 'Reply target is unavailable' })
  const root =
    row.reply_to === null
      ? null
      : sql.all<ReplyRow>('SELECT subject,author,reply_to,hidden_at FROM commons_messages WHERE seq=?', row.reply_to)[0]
  if (row.reply_to !== null && (root === undefined || root === null || root.hidden_at !== null))
    throw new Conflict({ message: 'Reply root is hidden' })
  return { replyTo: row.reply_to ?? id, parentAuthor: row.author }
}
export function insertPost(sql: SyncSql, post: InsertPost) {
  const { input, address, now } = post
  const target = replyTarget(sql, input.subject, input.replyTo)
  takeRate(sql, 'post', address, now)
  const parsed = parseSubject(input.subject)
  const badges = snapshotBadges(address, post.people, post.roles, post.stake)
  sql.run(
    `INSERT INTO commons_messages(subject,subject_kind,board_id,task_id,item_id,author,badges_json,body,presentation_json,reply_to,mentions_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    input.subject,
    parsed.kind,
    parsed.boardId,
    parsed.taskId,
    parsed.itemId,
    address,
    JSON.stringify(badges),
    input.body,
    post.presentation === null ? null : JSON.stringify(post.presentation),
    target.replyTo,
    JSON.stringify(post.mentions),
    now,
  )
  const row = sql.all<MessageRow>('SELECT * FROM commons_messages WHERE seq=last_insert_rowid()')[0]
  if (row === undefined) throw new Unavailable({ message: 'Message insert was not readable' })
  return { message: messageOf(row), parentAuthor: target.parentAuthor }
}
