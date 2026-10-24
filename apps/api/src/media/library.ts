/**
 * Reading the media library by level (ADR-0029), and its groups: sections of the public kit (an operator's) and
 * campaigns, always internal (any team member's).
 */
import { BoardError } from '@sidequest/board'
import { type AsyncSql, stmt } from '@sidequest/indexer'
import { actorName, isTeam, type MediaActor, requireRole, roleOf } from './access.ts'
import { commit, stale, type WriteContext } from './commit.ts'
import {
  type AssetKind,
  type AssetRow,
  assetRow,
  assetView,
  effectivePublic,
  type FileLink,
  type FileRow,
  filesOf,
  type GroupKind,
  type GroupRow,
  groupsById,
  groupView,
  type MediaLevel,
  type PostRow,
  postView,
  publicAssetIds,
  publicAssetView,
  publicPostView,
} from './rows.ts'

export interface MediaFilter {
  readonly level?: MediaLevel
  readonly section?: string
  readonly campaign?: string
  readonly batch?: string
  readonly kind?: AssetKind
  readonly query?: string
}

const matches = (asset: AssetRow, filter: MediaFilter): boolean => {
  const needle = filter.query?.toLowerCase()
  const fields: readonly (readonly [string | undefined, string | null])[] = [
    [filter.level, asset.level],
    [filter.section, asset.section],
    [filter.campaign, asset.campaign],
    [filter.batch, asset.batch],
    [filter.kind, asset.kind],
  ]
  return (
    fields.every(([wanted, value]) => wanted === undefined || wanted === value) &&
    (needle === undefined || `${asset.id} ${asset.title} ${asset.description ?? ''}`.toLowerCase().includes(needle))
  )
}

export async function listMedia(sql: AsyncSql, actor: MediaActor, filter: MediaFilter, link: FileLink) {
  const team = isTeam(actor)
  const groups = await groupsById(sql)
  const assets = (
    await sql.all<AssetRow>(
      'SELECT * FROM media_assets WHERE deleted_at IS NULL ORDER BY position, created_at DESC, id',
    )
  ).filter((asset) => (team || effectivePublic(asset, groups)) && matches(asset, filter))
  const files = await filesOf(
    sql,
    assets.map((asset) => asset.id),
  )
  return {
    viewer: { role: roleOf(actor) ?? null },
    groups: [...groups.values()]
      .filter((group) => team || (group.kind === 'section' && group.level === 'public'))
      .map(groupView),
    assets: (
      await Promise.all(
        assets.map((asset) => assetView(asset, files.get(asset.id) ?? [], effectivePublic(asset, groups), link)),
      )
    ).map((view) => (team ? view : publicAssetView(view))),
  }
}

export async function getMedia(sql: AsyncSql, actor: MediaActor, id: string, link: FileLink) {
  const team = isTeam(actor)
  const groups = await groupsById(sql)
  const asset = await assetRow(sql, id)
  const isPublic = asset !== undefined && effectivePublic(asset, groups)
  if (asset === undefined || asset.deleted_at !== null || (!isPublic && !team))
    throw new BoardError('not-found', `no media asset "${id}"`)
  const posts = await sql.all<PostRow>(
    "SELECT p.* FROM media_posts p, json_each(p.asset_ids_json) j WHERE j.value = ? ORDER BY COALESCE(p.day, ''), p.created_at",
    id,
  )
  const section = asset.section === null ? undefined : groups.get(asset.section)
  const view = await assetView(asset, (await filesOf(sql, [id])).get(id) ?? [], isPublic, link)
  const shown = team ? undefined : await publicAssetIds(sql)
  return {
    viewer: { role: roleOf(actor) ?? null },
    asset: shown === undefined ? view : publicAssetView(view),
    ...(section === undefined || (!team && section.level !== 'public') ? {} : { section: groupView(section) }),
    posts:
      shown === undefined
        ? posts.map(postView)
        : posts.filter((post) => post.status === 'posted').map((post) => publicPostView(postView(post), shown)),
  }
}

/** The file a request names, and whether it is public now; deleted assets and unknown files are absent alike. */
export async function fileForServing(sql: AsyncSql, assetId: string, name: string) {
  const asset = await assetRow(sql, assetId)
  if (asset === undefined || asset.deleted_at !== null) return undefined
  const [file] = await sql.all<FileRow>('SELECT * FROM media_files WHERE asset_id = ? AND name = ?', assetId, name)
  if (file === undefined) return undefined
  return { file, public: effectivePublic(asset, await groupsById(sql)) }
}

/** The assets a share names that still exist, shown through the share's links. */
export async function sharedAssets(sql: AsyncSql, assetIds: readonly string[], link: FileLink) {
  const groups = await groupsById(sql)
  const rows: AssetRow[] = []
  for (const id of assetIds) {
    const row = await assetRow(sql, id)
    if (row !== undefined && row.deleted_at === null) rows.push(row)
  }
  const files = await filesOf(
    sql,
    rows.map((row) => row.id),
  )
  // Shares reach people outside the team: they see the assets as the public does.
  const views = await Promise.all(
    rows.map((row) => assetView(row, files.get(row.id) ?? [], effectivePublic(row, groups), link)),
  )
  return views.map(publicAssetView)
}

export interface GroupFields {
  readonly kind: GroupKind
  readonly title: string
  readonly note?: string | null
  readonly level?: MediaLevel
  readonly position?: number
  readonly featured?: boolean
  readonly briefAsset?: string | null
  readonly startsOn?: string | null
  readonly endsOn?: string | null
  readonly status?: string | null
}

const pick = <V>(value: V | undefined, current: V): V => (value === undefined ? current : value)

/** The group's columns after a change, in the order both statements bind them. */
const groupColumns = (fields: GroupFields, existing: GroupRow | undefined) =>
  [
    fields.title,
    pick(fields.note, existing?.note ?? null),
    pick(fields.level, existing?.level ?? 'internal'),
    pick(fields.position, existing?.position ?? 0),
    fields.featured === undefined ? (existing?.featured ?? 0) : Number(fields.featured),
    pick(fields.briefAsset, existing?.brief_asset ?? null),
    pick(fields.startsOn, existing?.starts_on ?? null),
    pick(fields.endsOn, existing?.ends_on ?? null),
    pick(fields.status, existing?.status ?? null),
  ] as const

/** Sections (what /media shows, in order) are an operator's; campaigns, always internal, any team member's. */
export async function saveGroup(
  sql: AsyncSql,
  ctx: WriteContext,
  input: { readonly id: string; readonly revision?: number; readonly fields: GroupFields },
) {
  const { id, fields } = input
  requireRole(ctx.actor, fields.kind === 'section' ? 'operator' : 'member')
  if (fields.kind === 'campaign' && fields.level === 'public')
    throw new BoardError('invalid', 'campaigns are internal plans; publish their assets instead')
  const [existing] = await sql.all<GroupRow>('SELECT * FROM media_groups WHERE id = ?', id)
  if (existing !== undefined && existing.kind !== fields.kind)
    throw new BoardError('invalid', `"${id}" is a ${existing.kind}, not a ${fields.kind}`)
  const values = groupColumns(fields, existing)
  const exists = new BoardError('conflict', `"${id}" exists; pass its revision to change it`)
  if (input.revision === undefined) {
    if (existing !== undefined) throw exists
    return commit(sql, ctx, {
      action: `${fields.kind}.add`,
      target: id,
      guard: stmt(
        `INSERT INTO media_groups (id, kind, title, note, level, position, featured, brief_asset, starts_on, ends_on, status,
           created_by, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        id,
        fields.kind,
        ...values,
        actorName(ctx.actor),
        ctx.now,
        ctx.now,
      ),
      writes: [],
      result: { id, kind: fields.kind, revision: 1 },
      refused: exists,
    })
  }
  return commit(sql, ctx, {
    action: `${fields.kind}.update`,
    target: id,
    guard: stmt(
      `UPDATE media_groups SET title = ?, note = ?, level = ?, position = ?, featured = ?, brief_asset = ?, starts_on = ?,
         ends_on = ?, status = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND revision = ?`,
      ...values,
      ctx.now,
      id,
      input.revision,
    ),
    writes: [],
    result: { id, kind: fields.kind, revision: input.revision + 1 },
    refused: stale(`"${id}"`),
  })
}
