import { Schema } from 'effect'

const Id = Schema.Int.check(Schema.isGreaterThan(0))
const Kind = Schema.Literals(['message', 'item', 'gap_report'])
const Hidden = Schema.NullOr(Schema.Struct({ at: Schema.Number }))
const MessagePage = Schema.Struct({
  subject: Schema.optionalKey(Schema.String),
  messages: Schema.Array(
    Schema.Struct({
      id: Id,
      body: Schema.NullOr(Schema.String),
      hidden: Hidden,
      badges: Schema.optionalKey(Schema.Array(Schema.Struct({ kind: Schema.String }))),
    }),
  ),
})
const ItemReply = Schema.Struct({
  item: Schema.Struct({
    id: Id,
    title: Schema.String,
    problem: Schema.String,
    proposal: Schema.String,
    hidden: Hidden,
  }),
})
const GapReply = Schema.Struct({
  reports: Schema.Array(
    Schema.Struct({
      id: Id,
      hidden: Schema.Union([Schema.Boolean, Hidden]),
      whatINeeded: Schema.optionalKey(Schema.String),
      whatITried: Schema.optionalKey(Schema.String),
      what_i_needed: Schema.optionalKey(Schema.String),
      what_i_tried: Schema.optionalKey(Schema.String),
      suggestion: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
})

export const ModerationTarget = Schema.Struct({ kind: Kind, id: Id })
export type ModerationTarget = typeof ModerationTarget.Type

/** Feed ids are deterministic metadata; never take a hide target from model output. */
export function eventTarget(id: string, kind: string): ModerationTarget {
  const match = /^commons:([mir])(\d+):/u.exec(id)
  const expected = expectedPrefix(kind)
  if (match === null || match[1] !== expected) throw new Error('invalid Commons event id')
  return Schema.decodeUnknownSync(ModerationTarget)({
    kind: targetKind(expected),
    id: Number(match[2]),
  })
}

function expectedPrefix(kind: string): 'm' | 'i' | 'r' {
  switch (kind) {
    case 'message.posted':
      return 'm'
    case 'roadmap.proposed':
      return 'i'
    case 'gap.reported':
      return 'r'
    default:
      throw new Error('unsupported Commons event kind')
  }
}

function targetKind(prefix: 'm' | 'i' | 'r'): 'message' | 'item' | 'gap_report' {
  switch (prefix) {
    case 'm':
      return 'message'
    case 'i':
      return 'item'
    case 'r':
      return 'gap_report'
  }
}

/** Read only the event's own text, excluding surrounding posts, role reasons and private user goals. */
export function targetText(target: ModerationTarget, reply: unknown): string | null {
  if (target.kind === 'message') return messageText(target.id, reply)
  if (target.kind === 'item') return itemText(target.id, reply)
  return gapText(target.id, reply)
}

/** Where a subject is, in words: the model judges a request from a job's owner to its worker as ordinary work. */
export const placeOf = (subject: string | undefined) =>
  subject === 'lobby'
    ? 'the lobby'
    : subject?.startsWith('job:') === true
      ? "a job's thread"
      : subject?.startsWith('roadmap:') === true
        ? "a roadmap item's thread"
        : 'a thread'

function messageText(id: number, reply: unknown): string | null {
  const page = Schema.decodeUnknownSync(MessagePage)(reply)
  const message = page.messages.find((entry) => entry.id === id)
  if (message === undefined) throw new Error('message absent from returned page')
  if (message.hidden !== null || message.body === null) return null
  const author = [...new Set((message.badges ?? []).map((badge) => badge.kind))]
  return JSON.stringify({ where: placeOf(page.subject), author, text: message.body })
}

function itemText(id: number, reply: unknown): string | null {
  const { item } = Schema.decodeUnknownSync(ItemReply)(reply)
  if (item.id !== id) throw new Error('roadmap item id mismatch')
  return item.hidden === null
    ? JSON.stringify({ title: item.title, problem: item.problem, proposal: item.proposal })
    : null
}

function gapText(id: number, reply: unknown): string | null {
  const report = Schema.decodeUnknownSync(GapReply)(reply).reports.find((entry) => entry.id === id)
  if (report === undefined) throw new Error('gap report absent from returned page')
  if (report.hidden !== null && report.hidden !== false) return null
  const needed = report.whatINeeded ?? report.what_i_needed
  const tried = report.whatITried ?? report.what_i_tried
  if (needed === undefined || tried === undefined) throw new Error('gap report fields missing')
  return JSON.stringify({ needed, tried, suggestion: report.suggestion ?? null })
}
