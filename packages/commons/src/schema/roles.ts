import { Schema } from 'effect'
import { Address, Cursor, Integer, ItemId, Limit, OutputId, text } from './ids.ts'

export const Role = Schema.Literals(['moderator', 'maintainer', 'arbiter'])
export type Role = typeof Role.Type
export const ContentKind = Schema.Literals(['message', 'item', 'gap_report'])
export const Status = Schema.Literals(['open', 'planned', 'building', 'shipped', 'declined'])
export type Status = typeof Status.Type
export const Hidden = Schema.Struct({
  role: Schema.Literals(['moderator', 'maintainer']),
  reason: text(3, 500),
  at: Integer,
  logSeq: OutputId,
})
export type Hidden = typeof Hidden.Type
export const RoleAction = Schema.Struct({
  seq: OutputId,
  actor: Address,
  role: Role,
  action: Schema.Literals(['hide', 'unhide', 'set_status', 'merge_items', 'merge_gaps', 'link_gaps', 'set_gap_status']),
  targetKind: Schema.Literals(['message', 'item', 'gap_report', 'gap']),
  targetId: OutputId,
  /** A message target's thread, so a reviewer can open the content an action names. */
  subject: Schema.optional(Schema.String),
  detail: Schema.Record(Schema.String, Schema.Unknown),
  reason: text(3, 500),
  createdAt: Integer,
})
export type RoleAction = typeof RoleAction.Type
export const ContentActionInput = Schema.Struct({ kind: ContentKind, id: ItemId, reason: text(3, 500) })
export const HideContentInput = Schema.Struct(ContentActionInput.fields)
export const UnhideContentInput = Schema.Struct(ContentActionInput.fields)
export const HideContentOutput = Schema.Struct({ kind: ContentKind, id: OutputId, hidden: Hidden, logSeq: OutputId })
export const UnhideContentOutput = Schema.Struct({
  kind: ContentKind,
  id: OutputId,
  hidden: Schema.Null,
  logSeq: OutputId,
})
export const SetItemStatusInput = Schema.Struct({ itemId: ItemId, status: Status, reason: text(3, 500) })
export const MergeItemsInput = Schema.Struct({ sourceId: ItemId, targetId: ItemId, reason: text(3, 500) })
export const MergeGapsInput = Schema.Struct({ sourceGapId: ItemId, targetGapId: ItemId, reason: text(3, 500) })
export const ListRolesInput = Schema.Struct({ cursor: Schema.optional(Cursor), limit: Schema.optional(Limit) })
export const ListRolesOutput = Schema.Struct({
  enabled: Schema.Boolean,
  roles: Schema.Array(Schema.Struct({ role: Role, holders: Schema.Array(Address), source: Schema.String })),
  log: Schema.Array(RoleAction),
  cursor: Schema.NullOr(Cursor),
  hasMore: Schema.Boolean,
  viewer: Schema.NullOr(Schema.Struct({ address: Address, roles: Schema.Array(Role) })),
})
