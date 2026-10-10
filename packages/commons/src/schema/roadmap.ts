import { Schema } from 'effect'
import { Address, GapId, Integer, ItemId, Limit, OutputId, Subject, WeiString, text } from './ids.ts'
import { Gap } from './gaps.ts'
import { Hidden, RoleAction, Status } from './roles.ts'

export const RoadmapItem = Schema.Struct({
  id: OutputId,
  title: text(3, 120),
  status: Status,
  proposer: Address,
  supporters: Integer,
  weight: WeiString,
  gapIds: Schema.Array(OutputId),
  mergedInto: Schema.NullOr(OutputId),
  hidden: Schema.NullOr(Hidden),
  threadSubject: Subject,
  createdAt: Integer,
  updatedAt: Integer,
  mine: Schema.optional(Schema.Boolean),
})
export type RoadmapItem = typeof RoadmapItem.Type
export const RoadmapItemDetail = RoadmapItem.mapFields((fields) => ({
  ...fields,
  problem: text(1, 2000),
  proposal: text(1, 4000),
  proposerStake: WeiString,
  proposerBlock: Schema.NullOr(WeiString),
}))
export type RoadmapItemDetail = typeof RoadmapItemDetail.Type
export const ProposeItemInput = Schema.Struct({
  title: text(3, 120),
  problem: text(1, 2000),
  proposal: text(1, 4000),
  gapIds: Schema.optional(Schema.Array(GapId).check(Schema.isMaxLength(10))),
})
export const ProposeItemOutput = Schema.Struct({ item: RoadmapItemDetail, threadSubject: Subject })
export const ListRoadmapInput = Schema.Struct({
  status: Schema.optional(Schema.Union([Status, Schema.Literal('all')])),
  limit: Schema.optional(Limit),
})
export const ListRoadmapOutput = Schema.Struct({
  block: Schema.NullOr(WeiString),
  weightsAvailable: Schema.Boolean,
  items: Schema.Array(RoadmapItem),
  viewer: Schema.NullOr(
    Schema.Struct({
      activeSupports: Integer,
      limit: Schema.Literal(5),
      canPropose: Schema.Boolean,
      canVote: Schema.Boolean,
    }),
  ),
})
export const GetRoadmapItemInput = Schema.Struct({ itemId: ItemId })
export const GetRoadmapItemOutput = Schema.Struct({
  item: RoadmapItemDetail,
  supporters: Schema.Array(Schema.Struct({ address: Address, weight: WeiString })),
  block: Schema.NullOr(WeiString),
  gaps: Schema.Array(Gap),
  log: Schema.Array(RoleAction),
  thread: Schema.Struct({ subject: Subject, count: Integer }),
})
export const SupportItemInput = Schema.Struct({ itemId: ItemId })
export const WithdrawSupportInput = Schema.Struct({ itemId: ItemId })
export const SupportItemOutput = Schema.Struct({
  itemId: OutputId,
  supporting: Schema.Literal(true),
  activeSupports: Integer,
  limit: Schema.Literal(5),
})
export const WithdrawSupportOutput = Schema.Struct({
  itemId: OutputId,
  supporting: Schema.Literal(false),
  activeSupports: Integer,
})
export const SetItemStatusOutput = Schema.Struct({ item: RoadmapItemDetail, logSeq: OutputId })
export const LinkGapsInput = Schema.Struct({
  itemId: ItemId,
  gapIds: Schema.Array(GapId).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
  reason: text(3, 500),
})
export const LinkGapsOutput = Schema.Struct({ item: RoadmapItemDetail, linked: Integer, logSeq: OutputId })
export const MergeItemsOutput = Schema.Struct({ item: RoadmapItemDetail, movedSupports: Integer, logSeq: OutputId })
