import { Schema } from 'effect'
import { Address, Cursor, GapId, Integer, Limit, OutputId, ToolName, text } from './ids.ts'
import { Hidden } from './roles.ts'

export const GapType = Schema.Literals([
  'missing_tool',
  'missing_parameter',
  'incomplete_results',
  'wrong_format',
  'error',
  'unclear_docs',
])
export type GapType = typeof GapType.Type
/** A cluster's resolution, set by a Maintainer: fixed when a change shipped, wontfix with its reason. */
export const GapStatus = Schema.Literals(['open', 'fixed', 'wontfix'])
export type GapStatus = typeof GapStatus.Type
export const ReportGapInput = Schema.Struct({
  gap_type: GapType,
  tool: Schema.optional(ToolName),
  what_i_needed: text(1, 1000),
  what_i_tried: text(1, 1000),
  suggestion: Schema.optional(text(0, 1000)),
  user_goal: Schema.optional(text(0, 1000)),
})
export const ReportGapOutput = Schema.Struct({
  reportId: OutputId,
  gapId: OutputId,
  reports: Integer,
  reporters: Integer,
  duplicate: Schema.Boolean,
})
export const Gap = Schema.Struct({
  id: OutputId,
  gapType: GapType,
  tool: Schema.NullOr(ToolName),
  needed: Schema.String,
  example: Schema.NullOr(Schema.String),
  reports: Integer,
  reporters: Integer,
  firstAt: Integer,
  lastAt: Integer,
  itemIds: Schema.Array(OutputId),
  status: GapStatus,
})
export type Gap = typeof Gap.Type
export const GapReport = Schema.Struct({
  id: OutputId,
  gapId: OutputId,
  originGapId: OutputId,
  reporter: Address,
  whatINeeded: Schema.NullOr(Schema.String),
  whatITried: Schema.NullOr(Schema.String),
  suggestion: Schema.NullOr(Schema.String),
  userGoal: Schema.optional(Schema.NullOr(Schema.String)),
  hidden: Schema.NullOr(Hidden),
  createdAt: Integer,
})
export type GapReport = typeof GapReport.Type
export const ListGapsInput = Schema.Struct({
  status: Schema.optional(GapStatus),
  gapType: Schema.optional(GapType),
  tool: Schema.optional(ToolName),
  gapId: Schema.optional(GapId),
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(Limit),
})
export const ListGapsOutput = Schema.Union([
  Schema.Struct({ gaps: Schema.Array(Gap), cursor: Schema.NullOr(Cursor) }),
  Schema.Struct({ gap: Gap, reports: Schema.Array(GapReport) }),
])
export const MergeGapsOutput = Schema.Struct({ gap: Gap, movedReports: Integer, logSeq: OutputId })
export const SetGapStatusInput = Schema.Struct({ gapId: GapId, status: GapStatus, reason: text(3, 500) })
export const SetGapStatusOutput = Schema.Struct({ gap: Gap, logSeq: OutputId })
