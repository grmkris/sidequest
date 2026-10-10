import { Match } from 'effect'
import type { Address } from './schema/ids.ts'
import type { Message } from './schema/messages.ts'
import type { FeedEvent, ParticipantsSnapshot } from './services.ts'
import { parseSubject } from './thread/subject.ts'

interface Recipient {
  readonly kind: string
  readonly role: string
}
export function postEvents(
  message: Message,
  people: ParticipantsSnapshot | null,
  moderators: readonly Address[],
  parentAuthor: Address | null,
): FeedEvent[] {
  const subject = parseSubject(message.subject)
  const recipients = new Map<Address, Recipient>()
  if (people !== null) {
    for (const [address, role] of [
      [people.creator, 'creator'],
      [people.approver, 'approver'],
      [people.worker, 'worker'],
    ]) {
      if (address !== null && address !== undefined && !recipients.has(address))
        recipients.set(address, { kind: 'message.posted', role: role! })
    }
  }
  for (const mention of message.mentions)
    if (mention.address !== null) recipients.set(mention.address, { kind: 'message.mention', role: 'mentioned' })
  if (parentAuthor !== null) recipients.set(parentAuthor, { kind: 'message.reply', role: 'author' })
  recipients.delete(message.author)
  const base = {
    boardId: subject.boardId,
    taskId: subject.taskId,
    jobId: people?.jobId ?? null,
    summary: `New message in ${subject.kind} thread.`,
    next: { tool: 'list_messages', args: { subject: message.subject } },
    occurredAt: message.createdAt,
  }
  return [
    ...[...new Set(moderators)].map((address) => ({
      ...base,
      id: `commons:m${message.id}:mod:${address}`,
      address,
      kind: 'message.posted',
      role: 'moderator',
    })),
    ...[...recipients].map(([address, recipient]) => ({
      ...base,
      id: `commons:m${message.id}:${address}`,
      address,
      ...recipient,
    })),
  ]
}

interface ModeratorEvent {
  readonly kind: 'gap.reported' | 'roadmap.proposed'
  readonly prefix: string
  readonly id: number
  readonly now: number
}
export function moderatorEvents(event: ModeratorEvent, moderators: readonly Address[]): FeedEvent[] {
  const gap = event.kind === 'gap.reported'
  const next = gap
    ? { tool: 'list_gaps', args: { gapId: String(event.id) } }
    : { tool: 'get_roadmap_item', args: { itemId: String(event.id) } }
  return [...new Set(moderators.map((a) => a.toLowerCase()))].map((address) => ({
    id: `${event.prefix}:${address}`,
    address,
    kind: event.kind,
    role: 'moderator',
    summary: gap ? 'A Commons gap was reported.' : 'A roadmap item was proposed.',
    next,
    occurredAt: event.now,
  }))
}
/**
 * A status change reaches the proposer, the supporters and the reporters of gaps linked to the item, once each,
 * labelled by their closest tie (proposer before supporter before reporter).
 */
export function statusEvents(input: {
  readonly itemId: number
  readonly logSeq: number
  readonly proposer: Address
  readonly supporters: readonly Address[]
  readonly reporters?: readonly Address[]
  readonly now: number
}): FeedEvent[] {
  const roles = new Map<string, string>()
  for (const address of (input.reporters ?? []).slice(0, 100)) roles.set(address.toLowerCase(), 'reporter')
  for (const address of input.supporters.slice(0, 100)) roles.set(address.toLowerCase(), 'supporter')
  roles.set(input.proposer.toLowerCase(), 'proposer')
  return [...roles].map(([address, role]) => ({
    id: `commons:i${input.itemId}:s${input.logSeq}:${address}`,
    address,
    kind: 'roadmap.status',
    role,
    summary: 'Roadmap item status changed.',
    next: { tool: 'get_roadmap_item', args: { itemId: String(input.itemId) } },
    occurredAt: input.now,
  }))
}
/** A gap's resolution reaches everyone who reported it, without their text. */
export function gapStatusEvents(input: {
  readonly gapId: number
  readonly logSeq: number
  readonly reporters: readonly Address[]
  readonly now: number
}): FeedEvent[] {
  return [...new Set(input.reporters.slice(0, 100).map((a) => a.toLowerCase()))].map((address) => ({
    id: `commons:g${input.gapId}:s${input.logSeq}:${address}`,
    address,
    kind: 'gap.status',
    role: 'reporter',
    summary: 'A gap you reported changed status.',
    next: { tool: 'list_gaps', args: { gapId: String(input.gapId) } },
    occurredAt: input.now,
  }))
}
export function hiddenEvent(input: {
  readonly id: number
  readonly kind: 'message' | 'item' | 'gap_report'
  readonly logSeq: number
  readonly address: Address
  readonly subject?: string
  readonly gapId?: number
  readonly now: number
}): FeedEvent {
  const next: NonNullable<FeedEvent['next']> = Match.value(input.kind).pipe(
    Match.when('message', () => ({ tool: 'list_messages', args: { subject: input.subject! } })),
    Match.when('item', () => ({ tool: 'get_roadmap_item', args: { itemId: String(input.id) } })),
    Match.when('gap_report', () => ({ tool: 'list_gaps', args: { gapId: String(input.gapId) } })),
    Match.exhaustive,
  )
  return {
    id: `commons:h${input.logSeq}`,
    address: input.address,
    kind: 'message.hidden',
    role: 'author',
    summary: 'Commons content was hidden.',
    next,
    occurredAt: input.now,
  }
}
