import { Schema, SchemaGetter } from 'effect'
import { PresentationInput, PresentationOutput } from './presentation.ts'
import { Address, Cursor, Integer, ItemId, Limit, MessageCursor, OutputId, Subject, WeiString, text } from './ids.ts'
import { Hidden, Role } from './roles.ts'

/**
 * Line breaks survive (CRLF and CR become LF, at most one blank line in a row, none at the ends): Explore shows bodies
 * with their breaks. Every other control and format character is removed.
 */
export const normalizeBody = (s: string) =>
  s
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .replace(/(?!\n)[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/^\n+|\n+$/gu, '')
export const Body = Schema.String.pipe(
  Schema.decodeTo(text(1, 2000), {
    decode: SchemaGetter.transform(normalizeBody),
    encode: SchemaGetter.transform((s) => s),
  }),
)
export const Badge = Schema.Struct({
  kind: Schema.Literals([
    'owner',
    'approver',
    'worker',
    'bidder',
    'backer',
    'staker',
    'arbiter',
    'moderator',
    'maintainer',
  ]),
  of: Schema.optional(Address),
  amount: Schema.optional(WeiString),
})
export type Badge = typeof Badge.Type
export const Mention = Schema.Struct({ token: Schema.String, address: Schema.NullOr(Address) })
export const Message = Schema.Struct({
  id: OutputId,
  subject: Subject,
  author: Address,
  badges: Schema.Array(Badge),
  body: Schema.NullOr(text(1, 2000)),
  /** Validated sidecar document; hidden posts expose neither body nor presentation. */
  presentation: Schema.optional(Schema.NullOr(PresentationOutput)),
  replyTo: Schema.NullOr(OutputId),
  mentions: Schema.Array(Mention),
  hidden: Schema.NullOr(Hidden),
  createdAt: Integer,
})
export type Message = typeof Message.Type
export const Viewer = Schema.Struct({
  address: Address,
  roles: Schema.Array(Role),
  canPost: Schema.Boolean,
  needs: Schema.NullOr(Schema.Literals(['sign-in', 'stake'])),
  minimum: WeiString,
  stake: Schema.NullOr(WeiString),
  backing: Schema.NullOr(WeiString),
})
export type Viewer = typeof Viewer.Type
export const ListMessagesInput = Schema.Struct({
  subject: Subject,
  after: Schema.optional(MessageCursor),
  before: Schema.optional(MessageCursor),
  limit: Schema.optional(Limit),
})
export const ListMessagesOutput = Schema.Struct({
  subject: Subject,
  messages: Schema.Array(Message),
  cursor: Schema.NullOr(Cursor),
  hasMore: Schema.Boolean,
  nextPollSeconds: Schema.Literal(10),
  viewer: Schema.NullOr(Viewer),
})
export const PostMessageInput = Schema.Struct({
  subject: Subject,
  body: Body,
  replyTo: Schema.optional(ItemId),
  /** A canonical presentation or `{protocol:'openui',version:1,source}` authoring input. */
  presentation: Schema.optional(PresentationInput),
})
export const PostMessageOutput = Schema.Struct({ message: Message, notified: Integer })
