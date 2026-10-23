/**
 * Writing media assets (ADR-0029): members add internal assets and new versions and change what is internal;
 * operators publish, unpublish, delete, and change what is public.
 */
import { BoardError } from '@sidequest/board'
import { type AsyncSql, stmt } from '@sidequest/indexer'
import { actorName, requireRole } from './access.ts'
import { checkGroup, commit, stale, type WriteContext } from './commit.ts'
import { type AssetKind, type AssetRow, assetRow, type Caption, type FileRole, type MediaLevel } from './rows.ts'

export interface NewFile {
  readonly name: string
  readonly role: FileRole
  readonly label?: string
  readonly bytes: number
  readonly type: string
  readonly sha256: string
}

export interface AssetFields {
  readonly title?: string
  readonly kind?: AssetKind
  readonly description?: string | null
  readonly note?: string | null
  readonly section?: string | null
  readonly campaign?: string | null
  readonly batch?: string | null
  readonly picked?: boolean
  readonly position?: number
  readonly width?: number | null
  readonly height?: number | null
  readonly duration?: number | null
  readonly captions?: readonly Caption[]
  readonly source?: { readonly [key: string]: unknown } | null
}

type Columns = Pick<
  AssetRow,
  | 'kind'
  | 'title'
  | 'description'
  | 'note'
  | 'section'
  | 'campaign'
  | 'batch'
  | 'picked'
  | 'position'
  | 'width'
  | 'height'
  | 'duration'
  | 'captions_json'
  | 'source_json'
>

const keep = <V>(value: V | undefined, current: V): V => (value === undefined ? current : value)
const sourceJson = (source: AssetFields['source']) =>
  source === undefined || source === null ? null : JSON.stringify(source)

/** The columns after a change: each field given replaces its column, `null` clears it, an absent one keeps it. */
function columns(row: AssetRow, fields: AssetFields): Columns {
  return {
    kind: keep(fields.kind, row.kind),
    title: keep(fields.title, row.title),
    description: keep(fields.description, row.description),
    note: keep(fields.note, row.note),
    section: keep(fields.section, row.section),
    campaign: keep(fields.campaign, row.campaign),
    batch: keep(fields.batch, row.batch),
    picked: fields.picked === undefined ? row.picked : Number(fields.picked),
    position: keep(fields.position, row.position),
    width: keep(fields.width, row.width),
    height: keep(fields.height, row.height),
    duration: keep(fields.duration, row.duration),
    captions_json: fields.captions === undefined ? row.captions_json : JSON.stringify(fields.captions),
    source_json: fields.source === undefined ? row.source_json : sourceJson(fields.source),
  }
}

const updateStatement = (id: string, revision: number, c: Columns, now: number) =>
  stmt(
    `UPDATE media_assets SET kind = ?, title = ?, description = ?, note = ?, section = ?, campaign = ?, batch = ?,
       picked = ?, position = ?, width = ?, height = ?, duration = ?, captions_json = ?, source_json = ?,
       updated_at = ?, revision = revision + 1
     WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
    c.kind,
    c.title,
    c.description,
    c.note,
    c.section,
    c.campaign,
    c.batch,
    c.picked,
    c.position,
    c.width,
    c.height,
    c.duration,
    c.captions_json,
    c.source_json,
    now,
    id,
    revision,
  )

const fileStatements = (assetId: string, files: readonly NewFile[]) =>
  files.map((file) =>
    stmt(
      'INSERT INTO media_files (asset_id, name, role, label, key, bytes, type, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      assetId,
      file.name,
      file.role,
      file.label ?? null,
      `files/${file.sha256}`,
      file.bytes,
      file.type,
      file.sha256,
    ),
  )

const insertStatement = (
  id: string,
  fields: AssetFields & { title: string; kind: AssetKind },
  by: string,
  now: number,
) =>
  stmt(
    `INSERT INTO media_assets (id, level, kind, title, description, note, section, campaign, batch, picked, position,
       width, height, duration, captions_json, source_json, created_by, created_at, updated_at, revision)
     VALUES (?, 'internal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    id,
    fields.kind,
    fields.title,
    fields.description ?? null,
    fields.note ?? null,
    fields.section ?? null,
    fields.campaign ?? null,
    fields.batch ?? null,
    Number(fields.picked === true),
    fields.position ?? 0,
    fields.width ?? null,
    fields.height ?? null,
    fields.duration ?? null,
    JSON.stringify(fields.captions ?? []),
    sourceJson(fields.source),
    by,
    now,
    now,
  )

async function liveAsset(sql: AsyncSql, id: string): Promise<AssetRow> {
  const row = await assetRow(sql, id)
  if (row === undefined || row.deleted_at !== null) throw new BoardError('not-found', `no media asset "${id}"`)
  return row
}

export interface AddAsset {
  readonly id: string
  readonly revision?: number
  readonly fields: AssetFields
  readonly files: readonly NewFile[]
}

/** A new internal asset, or a new version of one (`revision` names the version replaced; its files go). */
export async function addAsset(sql: AsyncSql, ctx: WriteContext, input: AddAsset) {
  requireRole(ctx.actor, 'member')
  const { id, fields, files } = input
  await checkGroup(sql, fields.section, 'section')
  await checkGroup(sql, fields.campaign, 'campaign')
  const exists = new BoardError('conflict', `media asset "${id}" exists; pass its revision to replace it`)
  if (input.revision === undefined) {
    const { title, kind } = fields
    if (title === undefined || kind === undefined) throw new BoardError('invalid', 'a new asset needs a title')
    if ((await assetRow(sql, id)) !== undefined) throw exists
    return commit(sql, ctx, {
      action: 'asset.add',
      target: id,
      guard: insertStatement(id, { ...fields, title, kind }, actorName(ctx.actor), ctx.now),
      writes: fileStatements(id, files),
      result: { id, revision: 1, level: 'internal' satisfies MediaLevel },
      refused: exists,
    })
  }
  const existing = await liveAsset(sql, id)
  // Replacing what everyone sees is publishing new content: an operator's call.
  if (existing.level === 'public') requireRole(ctx.actor, 'operator')
  return commit(sql, ctx, {
    action: 'asset.replace',
    target: id,
    guard: updateStatement(id, input.revision, columns(existing, fields), ctx.now),
    writes: [stmt('DELETE FROM media_files WHERE asset_id = ?', id), ...fileStatements(id, files)],
    result: { id, revision: input.revision + 1, level: existing.level },
    refused: stale(`media asset "${id}"`),
  })
}

/** Changes an asset's description, shelf, campaign, batch, pick, position or captions; public ones need an operator. */
export async function updateAsset(
  sql: AsyncSql,
  ctx: WriteContext,
  input: { readonly id: string; readonly revision: number; readonly fields: AssetFields },
) {
  requireRole(ctx.actor, 'member')
  const existing = await liveAsset(sql, input.id)
  if (existing.level === 'public') requireRole(ctx.actor, 'operator')
  await checkGroup(sql, input.fields.section, 'section')
  await checkGroup(sql, input.fields.campaign, 'campaign')
  return commit(sql, ctx, {
    action: 'asset.update',
    target: input.id,
    guard: updateStatement(input.id, input.revision, columns(existing, input.fields), ctx.now),
    writes: [],
    result: { id: input.id, revision: input.revision + 1 },
    refused: stale(`media asset "${input.id}"`),
  })
}

/** The statement that sets an asset's level; approving a post with `publishAssets` uses it too. */
export const levelStatement = (id: string, level: MediaLevel, by: string, now: number, revision?: number) =>
  stmt(
    `UPDATE media_assets SET level = ?, published_by = ?, published_at = ?, updated_at = ?, revision = revision + 1
     WHERE id = ? AND deleted_at IS NULL${revision === undefined ? '' : ' AND revision = ?'}`,
    level,
    level === 'public' ? by : null,
    level === 'public' ? now : null,
    now,
    id,
    ...(revision === undefined ? [] : [revision]),
  )

/** Publishes or unpublishes an asset: an operator's call. Unpublished files answer 404 on the next request. */
export async function setAssetLevel(
  sql: AsyncSql,
  ctx: WriteContext,
  input: { readonly id: string; readonly level: MediaLevel; readonly revision?: number },
) {
  requireRole(ctx.actor, 'operator')
  const existing = await liveAsset(sql, input.id)
  return commit(sql, ctx, {
    action: input.level === 'public' ? 'asset.publish' : 'asset.unpublish',
    target: input.id,
    guard: levelStatement(input.id, input.level, actorName(ctx.actor), ctx.now, input.revision),
    writes: [],
    result: { id: input.id, level: input.level, revision: (input.revision ?? existing.revision) + 1 },
    refused: stale(`media asset "${input.id}"`),
  })
}

/** Removes an asset from the library (its rows stay, its files stop being served): an operator's call. */
export async function deleteAsset(sql: AsyncSql, ctx: WriteContext, input: { readonly id: string }) {
  requireRole(ctx.actor, 'operator')
  return commit(sql, ctx, {
    action: 'asset.delete',
    target: input.id,
    guard: stmt(
      "UPDATE media_assets SET deleted_at = ?, level = 'internal', updated_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL",
      ctx.now,
      ctx.now,
      input.id,
    ),
    writes: [],
    result: { id: input.id, deleted: true },
    refused: new BoardError('not-found', `no media asset "${input.id}"`),
  })
}
