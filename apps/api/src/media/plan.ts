/**
 * The post plan (ADR-0029): a post is planned on a channel and day, moves draft → approved → posted (or skipped), and is
 * recorded by its public URL once it went out. Approving needs every file public; recording never publishes a file.
 */
import { BoardError } from '@sidequest/board'
import { type AsyncSql, type Statement, stmt } from '@sidequest/indexer'
import { actorName, isTeam, type MediaActor, requireRole, roleOf } from './access.ts'
import { levelStatement } from './assets.ts'
import { channelOf, cleanPostUrl } from './channels.ts'
import { checkGroup, commit, stale, type WriteContext } from './commit.ts'
import {
  assetRow,
  effectivePublic,
  groupsById,
  idsOf,
  type PostRow,
  postRow,
  type PostStatus,
  postView,
  publicAssetIds,
  publicPostView,
} from './rows.ts'

export interface PostFilter {
  readonly from?: string
  readonly to?: string
  readonly status?: PostStatus
  readonly campaign?: string
  readonly asset?: string
}

const inFilter = (post: PostRow, filter: PostFilter): boolean =>
  (filter.status === undefined || post.status === filter.status) &&
  (filter.campaign === undefined || post.campaign === filter.campaign) &&
  (filter.from === undefined || (post.day !== null && post.day >= filter.from)) &&
  (filter.to === undefined || (post.day !== null && post.day <= filter.to)) &&
  (filter.asset === undefined || idsOf(post.asset_ids_json).includes(filter.asset))

export async function listPosts(sql: AsyncSql, actor: MediaActor, filter: PostFilter) {
  const team = isTeam(actor)
  const rows = await sql.all<PostRow>(
    "SELECT * FROM media_posts ORDER BY COALESCE(day, ''), COALESCE(time, ''), created_at, id",
  )
  const listed = rows.filter((post) => (team || post.status === 'posted') && inFilter(post, filter)).map(postView)
  const shown = team ? undefined : await publicAssetIds(sql)
  return {
    viewer: { role: roleOf(actor) ?? null },
    posts: shown === undefined ? listed : listed.map((post) => publicPostView(post, shown)),
  }
}

interface PostFields {
  readonly campaign?: string | null
  readonly channel: string
  readonly account?: string | null
  readonly day?: string | null
  readonly time?: string | null
  readonly text: string
  readonly note?: string | null
  readonly assets?: readonly string[]
}

export interface SavePost {
  readonly id: string
  readonly revision?: number
  readonly fields: PostFields
  readonly status?: 'draft' | 'approved' | 'skipped'
  readonly publishAssets?: boolean
}

/**
 * The assets of a post that are not public now, which approving it would put in front of everyone. One on an internal
 * section would stay unserved however it is published, so the approval is refused until it moves.
 */
async function unpublished(sql: AsyncSql, ids: readonly string[]): Promise<string[]> {
  const groups = await groupsById(sql)
  const missing: string[] = []
  for (const id of ids) {
    const asset = await assetRow(sql, id)
    if (asset === undefined || asset.deleted_at !== null) throw new BoardError('invalid', `no media asset "${id}"`)
    const section = asset.section === null ? undefined : groups.get(asset.section)
    if (section?.level === 'internal')
      throw new BoardError(
        'invalid',
        `"${id}" sits on the internal section "${section.id}"; move it to a public one first`,
      )
    if (!effectivePublic(asset, groups)) missing.push(id)
  }
  return missing
}

/** What a post says and shows; a change to it after approval needs approving again. */
const contentOf = (post: {
  readonly channel: string
  readonly account: string | null
  readonly day: string | null
  readonly time: string | null
  readonly text: string
  readonly assets: readonly string[]
}) => JSON.stringify([post.channel, post.account, post.day, post.time, post.text, post.assets])

const savedContent = (row: PostRow) => contentOf({ ...row, assets: idsOf(row.asset_ids_json) })

/** Where a save leaves the post: what it asked for, or back to draft when an approved post's content changed. */
function nextStatus(existing: PostRow | undefined, asked: SavePost['status'], edited: boolean): PostStatus {
  if (asked !== undefined) return asked
  if (existing === undefined) return 'draft'
  return existing.status === 'approved' && edited ? 'draft' : existing.status
}

/** Approval's extra writes: publishing the post's internal files, when the operator asked for it. */
async function approval(
  sql: AsyncSql,
  ctx: WriteContext,
  assets: readonly string[],
  publish: boolean,
): Promise<Statement[]> {
  requireRole(ctx.actor, 'operator')
  const missing = await unpublished(sql, assets)
  if (missing.length > 0 && !publish)
    throw new BoardError(
      'invalid',
      `approving needs every file public; not yet: ${missing.join(', ')} (pass publishAssets to publish them too)`,
    )
  return missing.map((asset) => levelStatement(asset, 'public', actorName(ctx.actor), ctx.now))
}

async function existingPost(sql: AsyncSql, input: SavePost): Promise<PostRow | undefined> {
  if (input.revision === undefined) return undefined
  const existing = await postRow(sql, input.id)
  if (existing === undefined) throw new BoardError('not-found', `no post "${input.id}"`)
  if (existing.status === 'posted') throw new BoardError('conflict', 'this post is out; record_media_post changes it')
  return existing
}

/** A post's fields after a save: each one given replaces it, `null` clears it, an absent one keeps it. */
interface Merged {
  readonly campaign: string | null
  readonly channel: string
  readonly account: string | null
  readonly day: string | null
  readonly time: string | null
  readonly text: string
  readonly note: string | null
}

const kept = <V>(value: V | undefined, current: V): V => (value === undefined ? current : value)

function mergedOf(existing: PostRow | undefined, fields: PostFields): Merged {
  return {
    campaign: kept(fields.campaign, existing?.campaign ?? null),
    channel: fields.channel,
    account: kept(fields.account, existing?.account ?? null),
    day: kept(fields.day, existing?.day ?? null),
    time: kept(fields.time, existing?.time ?? null),
    text: fields.text,
    note: kept(fields.note, existing?.note ?? null),
  }
}

interface Decision {
  readonly status: PostStatus
  readonly approving: boolean
  readonly assets: readonly string[]
  readonly merged: Merged
}

function decide(existing: PostRow | undefined, input: SavePost): Decision {
  const assets = [...new Set(input.fields.assets ?? (existing === undefined ? [] : idsOf(existing.asset_ids_json)))]
  const merged = mergedOf(existing, input.fields)
  const edited = existing !== undefined && contentOf({ ...merged, assets }) !== savedContent(existing)
  const status = nextStatus(existing, input.status, edited)
  return { status, assets, merged, approving: status === 'approved' && (existing?.status !== 'approved' || edited) }
}

/** Who approved and when: this call when it approves, the standing approval when kept, none otherwise. */
function approvalStamp(existing: PostRow | undefined, decision: Decision, ctx: WriteContext) {
  if (decision.approving) return [actorName(ctx.actor), ctx.now] as const
  if (decision.status === 'approved') return [existing?.approved_by ?? null, existing?.approved_at ?? null] as const
  return [null, null] as const
}

function actionOf(existing: PostRow | undefined, decision: Decision): string {
  if (decision.approving) return 'post.approve'
  if (decision.status === 'skipped') return 'post.skip'
  return existing === undefined ? 'post.plan' : 'post.edit'
}

function postGuard(existing: PostRow | undefined, input: SavePost, decision: Decision, ctx: WriteContext): Statement {
  const { merged } = decision
  const columns = [
    merged.campaign,
    merged.channel,
    merged.account,
    merged.day,
    merged.time,
    merged.text,
    merged.note,
    JSON.stringify(decision.assets),
    decision.status,
    ...approvalStamp(existing, decision, ctx),
  ] as const
  if (existing === undefined)
    return stmt(
      `INSERT INTO media_posts (campaign, channel, account, day, time, text, note, asset_ids_json, status, approved_by,
         approved_at, id, created_by, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ...columns,
      input.id,
      actorName(ctx.actor),
      ctx.now,
      ctx.now,
    )
  return stmt(
    `UPDATE media_posts SET campaign = ?, channel = ?, account = ?, day = ?, time = ?, text = ?, note = ?,
       asset_ids_json = ?, status = ?, approved_by = ?, approved_at = ?, updated_at = ?, revision = revision + 1
     WHERE id = ? AND revision = ? AND status != 'posted'`,
    ...columns,
    ctx.now,
    input.id,
    input.revision ?? 0,
  )
}

/**
 * Plans or edits a post (members), skips it (members), or approves it (operators). Editing what an approved post says
 * or shows returns it to draft, unless an operator approves the edit in the same call.
 */
export async function savePost(sql: AsyncSql, ctx: WriteContext, input: SavePost) {
  requireRole(ctx.actor, 'member')
  await checkGroup(sql, input.fields.campaign, 'campaign')
  const existing = await existingPost(sql, input)
  const decision = decide(existing, input)
  const publish = decision.approving ? await approval(sql, ctx, decision.assets, input.publishAssets === true) : []
  return commit(sql, ctx, {
    action: actionOf(existing, decision),
    target: input.id,
    guard: postGuard(existing, input, decision, ctx),
    writes: publish,
    result: { id: input.id, status: decision.status, revision: (input.revision ?? 0) + 1, published: publish.length },
    refused:
      existing === undefined
        ? new BoardError('conflict', `post "${input.id}" exists; pass its revision`)
        : stale(`post "${input.id}"`),
  })
}

export interface RecordPost {
  readonly id: string
  readonly url: string
  readonly postedAt: number
  readonly planned: boolean
  readonly fields?: Partial<PostFields>
}

function postUrl(raw: string): string {
  let url: string
  try {
    url = cleanPostUrl(raw)
  } catch {
    throw new BoardError('invalid', 'url must be the public link to the post')
  }
  if (!url.startsWith('https://')) throw new BoardError('invalid', 'url must be an https link to the post')
  return url
}

async function recordPlanned(sql: AsyncSql, ctx: WriteContext, input: RecordPost, url: string) {
  const existing = await postRow(sql, input.id)
  if (existing === undefined) throw new BoardError('not-found', `no post "${input.id}"`)
  if (existing.status !== 'approved' && existing.status !== 'posted')
    throw new BoardError('invalid', 'only an approved post is recorded as posted; approve it first')
  // The link is shown on /media: changing the link of a post that is out is an operator's call.
  if (existing.status === 'posted' && existing.url !== url) requireRole(ctx.actor, 'operator')
  return commit(sql, ctx, {
    action: 'post.record',
    target: input.id,
    guard: stmt(
      `UPDATE media_posts SET url = ?, posted_at = ?, recorded_by = ?, status = 'posted', updated_at = ?, revision = revision + 1
       WHERE id = ? AND status IN ('approved', 'posted')`,
      url,
      input.postedAt,
      actorName(ctx.actor),
      ctx.now,
      input.id,
    ),
    writes: [],
    result: { id: input.id, status: 'posted' satisfies PostStatus, url },
    refused: stale(`post "${input.id}"`),
  })
}

async function recordOutside(sql: AsyncSql, ctx: WriteContext, input: RecordPost, url: string) {
  // A post nobody planned or approved puts its link on /media: an operator's call.
  requireRole(ctx.actor, 'operator')
  const assets = [...new Set(input.fields?.assets ?? [])]
  for (const asset of assets) {
    const row = await assetRow(sql, asset)
    if (row === undefined || row.deleted_at !== null) throw new BoardError('invalid', `no media asset "${asset}"`)
  }
  const by = actorName(ctx.actor)
  return commit(sql, ctx, {
    action: 'post.record',
    target: input.id,
    guard: stmt(
      `INSERT INTO media_posts (id, campaign, channel, account, text, note, asset_ids_json, status, url, posted_at,
         recorded_by, created_by, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, ?, ?, 1)`,
      input.id,
      input.fields?.campaign ?? null,
      input.fields?.channel ?? channelOf(url),
      input.fields?.account ?? null,
      input.fields?.text ?? '',
      input.fields?.note ?? null,
      JSON.stringify(assets),
      url,
      input.postedAt,
      by,
      by,
      ctx.now,
      ctx.now,
    ),
    writes: [],
    result: { id: input.id, status: 'posted' satisfies PostStatus, url },
    refused: new BoardError('conflict', `post "${input.id}" exists`),
  })
}

/**
 * Records a post that went out, by its public URL: a planned post once approved (any team member), or one made outside
 * the plan (an operator). One record per cleaned URL.
 */
export async function recordPost(sql: AsyncSql, ctx: WriteContext, input: RecordPost) {
  requireRole(ctx.actor, 'member')
  const url = postUrl(input.url)
  const [taken] = await sql.all<{ id: string }>('SELECT id FROM media_posts WHERE url = ?', url)
  if (taken !== undefined && taken.id !== input.id)
    throw new BoardError('conflict', `that post is already recorded as "${taken.id}"`)
  return input.planned ? recordPlanned(sql, ctx, input, url) : recordOutside(sql, ctx, input, url)
}
