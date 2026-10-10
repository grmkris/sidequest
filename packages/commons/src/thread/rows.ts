import { Schema } from 'effect'
import { Badge, Mention, type Message } from '../schema/messages.ts'
import { Hidden } from '../schema/roles.ts'

export interface HiddenRow {
  hidden_at: number | null
  hidden_role: string | null
  hidden_reason: string | null
  hidden_log_seq: number | null
}
export interface MessageRow extends HiddenRow {
  seq: number
  subject: string
  author: string
  badges_json: string
  body: string
  reply_to: number | null
  mentions_json: string
  created_at: number
}
export function hiddenOf(row: HiddenRow) {
  return row.hidden_at === null
    ? null
    : Schema.decodeUnknownSync(Hidden)({
        role: row.hidden_role,
        reason: row.hidden_reason,
        at: row.hidden_at,
        logSeq: row.hidden_log_seq,
      })
}
/** A message as read; `reveal` (a moderator or maintainer reviewing a hide) keeps a hidden body readable. */
export function messageOf(row: MessageRow, reveal = false): Message {
  return {
    id: row.seq,
    subject: row.subject,
    author: row.author,
    badges: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Badge)))(row.badges_json),
    body: row.hidden_at === null || reveal ? row.body : null,
    replyTo: row.reply_to,
    mentions: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Mention)))(row.mentions_json),
    hidden: hiddenOf(row),
    createdAt: row.created_at,
  }
}
