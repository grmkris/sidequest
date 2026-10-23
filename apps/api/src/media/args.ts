/**
 * The media tools' inputs (ADR-0029), parsed at the boundary with Effect Schema; their JSON Schema is what MCP and REST
 * publish. A decode failure names the field and the rule it broke, never the value sent.
 */
import { BoardError } from '@sidequest/board'
import { Schema, SchemaIssue } from 'effect'
import { MEDIA_CHANNELS } from './channels.ts'

const said = <S extends Schema.Top>(schema: S, description: string) => schema.annotate({ description })
const text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
const whole = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))
const optional = <S extends Schema.Top>(schema: S, description: string) => Schema.optionalKey(said(schema, description))
const clearable = <S extends Schema.Top>(schema: S, description: string) =>
  Schema.optionalKey(said(Schema.NullOr(schema), description))

/** An asset or group id: a-z, 0-9 and "-", and none of the words /media uses for its own routes. */
const Slug = Schema.String.check(Schema.isPattern(/^(?!(?:f|s|internal|new|upload)$)[a-z0-9][a-z0-9-]{0,63}$/u))
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
const MediaType = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/u))
const Day = Schema.String.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u))
const Clock = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/u))
const FileName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u))
const Level = Schema.Literals(['internal', 'public'])
const Kind = Schema.Literals(['video', 'image', 'audio', 'document', 'file'])
const Role = Schema.Literals(['main', 'poster', 'captions', 'extra'])
const Status = Schema.Literals(['draft', 'approved', 'posted', 'skipped'])
const Channel = Schema.Literals(MEDIA_CHANNELS)
const Revision = whole(1, Number.MAX_SAFE_INTEGER)
const Ids = (max: number) => Schema.Array(Slug).check(Schema.isMaxLength(max))
const Size = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))

const Caption = Schema.Struct({
  where: said(text(80), 'Where, e.g. "X" or "TikTok · Reels · Shorts".'),
  text: said(text(4000), 'The text to paste.'),
  note: optional(text(500), 'How to post it.'),
})

const AssetProperties = {
  title: optional(text(160), 'What it is.'),
  kind: optional(Kind, 'Default: from the main file.'),
  description: clearable(text(2000), 'One or two sentences.'),
  note: clearable(text(500), 'A caution shown with it, e.g. "illustrative numbers".'),
  section: clearable(Slug, 'The section of /media it sits in (a section id).'),
  campaign: clearable(Slug, 'The campaign it was made for (a campaign id).'),
  batch: clearable(text(64), 'Variants of one deliverable share a batch, e.g. "since-launch/main".'),
  picked: optional(Schema.Boolean, 'The chosen variant of its batch.'),
  position: optional(whole(0, 1_000_000), 'Its order in its section, from 0.'),
  width: clearable(Size, 'Pixels.'),
  height: clearable(Size, 'Pixels.'),
  duration: clearable(Size, 'Seconds.'),
  captions: optional(
    Schema.Array(Caption).check(Schema.isMaxLength(12)),
    'Suggested copy per channel, public with the asset.',
  ),
  source: clearable(Schema.Record(Schema.String, Schema.Unknown), 'Where it came from, e.g. { "mysiRun": "…" }.'),
}

export const MediaFile = Schema.Struct({
  name: said(FileName, 'The file name in its URL, e.g. "launch-40s-vertical.mp4" or "poster.jpg".'),
  role: optional(Role, 'One file is main; default extra.'),
  label: optional(text(80), 'For extras: what it is, e.g. "Source zip".'),
  sha256: optional(Sha256, 'The sha256 of a file uploaded with prepare_media_upload (or of the file at sourceUrl).'),
  sourceUrl: optional(text(2048), 'Instead of an upload: an https URL on an allowed host that serves the file.'),
  type: optional(MediaType, 'Its media type, when storage does not know it.'),
})

export const ListMedia = Schema.Struct({
  level: optional(Level, 'Only this level.'),
  section: optional(Slug, 'A section id.'),
  campaign: optional(Slug, 'A campaign id.'),
  batch: optional(text(64), 'A batch.'),
  kind: optional(Kind, 'Only this kind.'),
  query: optional(text(100), 'Words in the id, title or description.'),
})
export const GetMedia = Schema.Struct({ id: said(Slug, 'The media asset id.') })
export const ListPosts = Schema.Struct({
  from: optional(Day, 'From this day, YYYY-MM-DD.'),
  to: optional(Day, 'To this day, YYYY-MM-DD.'),
  status: optional(Status, 'Only posts in this state.'),
  campaign: optional(Slug, 'A campaign id.'),
  asset: optional(Slug, 'Posts using this asset.'),
})
export const Nothing = Schema.Struct({})
export const GetShare = Schema.Struct({ token: said(Sha256, 'The token from the share link.') })
export const PrepareUpload = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      sha256: said(Sha256, 'Hex sha256 of the file.'),
      bytes: said(whole(1, 100_000_000), 'Its size; at most 100 MB through an upload.'),
      type: said(MediaType, 'Its media type.'),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
})
export const AddMedia = Schema.Struct({
  id: optional(Slug, 'Its id; default: from the title.'),
  revision: optional(Revision, 'To replace an existing asset: the revision you read.'),
  files: Schema.Array(MediaFile).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  ...AssetProperties,
})
export const UpdateMedia = Schema.Struct({
  id: said(Slug, 'The media asset id.'),
  revision: said(Revision, 'The revision you read.'),
  ...AssetProperties,
})
export const PublishMedia = Schema.Struct({
  id: said(Slug, 'The media asset id.'),
  public: said(Schema.Boolean, 'true publishes it, false makes it internal again.'),
  revision: optional(Revision, 'The revision you read (optional).'),
})
export const SaveGroup = Schema.Struct({
  id: optional(Slug, 'Its id; default: from the title.'),
  revision: optional(Revision, 'To change it: the revision you read.'),
  kind: said(Schema.Literals(['section', 'campaign']), 'A section of /media, or a campaign.'),
  title: said(text(120), 'Its title.'),
  note: clearable(text(500), 'Shown under its heading: what these are for, anything to check.'),
  level: optional(Level, 'Sections only: public shows it on /media.'),
  position: optional(whole(0, 1_000_000), 'Its order, from 0.'),
  featured: optional(Schema.Boolean, 'Sections: the featured row.'),
  briefAsset: clearable(Slug, "Campaigns: the brief's document asset."),
  startsOn: clearable(Day, 'Campaigns: first day, YYYY-MM-DD.'),
  endsOn: clearable(Day, 'Campaigns: last day, YYYY-MM-DD.'),
  status: clearable(text(40), 'Campaigns: e.g. planning, live, done.'),
})
export const SavePost = Schema.Struct({
  id: optional(text(40), "The post's id, to change it."),
  revision: optional(Revision, 'To change it: the revision you read.'),
  campaign: clearable(Slug, 'Its campaign id.'),
  channel: said(Channel, 'Where it goes.'),
  account: clearable(text(80), 'The posting account, e.g. "@sidequest.exchange".'),
  day: clearable(Day, 'The planned day, YYYY-MM-DD.'),
  time: clearable(Clock, "The planned time, HH:MM in the team's zone."),
  text: said(text(10_000), 'The post text.'),
  note: clearable(text(500), 'How to post it, e.g. which file to attach first.'),
  assets: optional(Ids(10), 'The media asset ids it posts.'),
  status: optional(Schema.Literals(['draft', 'approved', 'skipped']), 'Approving is a media operator’s.'),
  publishAssets: optional(Schema.Boolean, 'When approving: publish its internal files too.'),
})
export const RecordPost = Schema.Struct({
  id: optional(text(40), 'The planned post it was.'),
  url: said(text(2048), 'The public link to the post.'),
  postedAt: optional(whole(1_600_000_000, 4_102_444_800), 'When it went out, Unix seconds (default: now).'),
  channel: optional(Channel, 'Default: from the URL.'),
  account: optional(text(80), 'The posting account.'),
  text: optional(text(10_000), 'What it said.'),
  campaign: optional(Slug, 'Its campaign id.'),
  assets: optional(Ids(10), 'The media asset ids it used.'),
})
export const ShareMedia = Schema.Struct({
  assets: optional(Ids(50), 'The asset ids to share.'),
  campaign: optional(Slug, "Share all of this campaign's assets."),
  label: optional(text(120), 'Who or what it is for, e.g. "since-launch film".'),
  days: optional(whole(1, 90), 'Days until it expires; default 30.'),
})
export const RevokeShare = Schema.Struct({ id: said(text(40), 'The share id (from list_media_shares).') })

const OperationKey = Schema.Struct({ operationKey: Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,128}$/u)) })

const formatter = SchemaIssue.makeFormatterDefault()

/** The arguments as the tool's typed input, or an `invalid` refusal that names the field. */
export function parse<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  args: Record<string, unknown>,
): S['Type'] {
  try {
    return Schema.decodeUnknownSync(schema)(args, { reportInput: false })
  } catch (error) {
    if (Schema.isSchemaError(error))
      throw new BoardError('invalid', `Invalid media input: ${formatter(error.issue).slice(0, 500)}`)
    throw error
  }
}

/** The stable key every media write carries. */
export const operationKeyOf = (args: Record<string, unknown>): string => {
  try {
    return Schema.decodeUnknownSync(OperationKey)(args).operationKey
  } catch {
    throw new BoardError('invalid', 'Every write requires a stable operationKey; retry with the same key')
  }
}

/** The JSON Schema MCP and REST publish for a tool's input. */
export function jsonSchemaOf(schema: Schema.Top): {
  type: 'object'
  properties: Record<string, unknown>
  required?: readonly string[]
} {
  const document = Schema.toJsonSchemaDocument(schema).schema
  const properties = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(document.properties ?? {})
  const required = Schema.decodeUnknownSync(Schema.Array(Schema.String))(document.required ?? [])
  return { type: 'object', properties, ...(required.length === 0 ? {} : { required }) }
}
