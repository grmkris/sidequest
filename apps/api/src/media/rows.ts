/** The media library's D1 rows (ADR-0029), how they read back, and what each level of viewer is shown of them. */
import { Schema } from 'effect'
import type { AsyncSql } from '@sidequest/indexer'

export const RESERVED_IDS: ReadonlySet<string> = new Set(['f', 's', 'internal', 'new', 'upload'])
export const SHA256 = /^[0-9a-f]{64}$/

export type MediaLevel = 'internal' | 'public'
export type AssetKind = 'video' | 'image' | 'audio' | 'document' | 'file'
export type FileRole = 'main' | 'poster' | 'captions' | 'extra'
export type PostStatus = 'draft' | 'approved' | 'posted' | 'skipped'
export type GroupKind = 'section' | 'campaign'

export const Caption = Schema.Struct({
  where: Schema.String,
  text: Schema.String,
  note: Schema.optionalKey(Schema.String),
})
export type Caption = typeof Caption.Type

export interface GroupRow {
  id: string
  kind: GroupKind
  title: string
  note: string | null
  level: MediaLevel
  position: number
  featured: number
  brief_asset: string | null
  starts_on: string | null
  ends_on: string | null
  status: string | null
  revision: number
}

export interface AssetRow {
  id: string
  level: MediaLevel
  kind: AssetKind
  title: string
  description: string | null
  note: string | null
  section: string | null
  campaign: string | null
  batch: string | null
  picked: number
  position: number
  width: number | null
  height: number | null
  duration: number | null
  captions_json: string
  source_json: string | null
  created_by: string
  created_at: number
  published_by: string | null
  published_at: number | null
  updated_at: number
  revision: number
  deleted_at: number | null
}

export interface FileRow {
  asset_id: string
  name: string
  role: FileRole
  label: string | null
  key: string
  bytes: number
  type: string
  sha256: string
}

export interface PostRow {
  id: string
  campaign: string | null
  channel: string
  account: string | null
  day: string | null
  time: string | null
  text: string
  note: string | null
  asset_ids_json: string
  status: PostStatus
  created_by: string
  created_at: number
  approved_by: string | null
  approved_at: number | null
  url: string | null
  posted_at: number | null
  recorded_by: string | null
  revision: number
}

export interface ShareRow {
  id: string
  token_hash: string
  label: string | null
  asset_ids_json: string
  expires_at: number
  revoked_at: number | null
  created_by: string
  created_at: number
}

const Ids = Schema.fromJsonString(Schema.Array(Schema.String))
const Captions = Schema.fromJsonString(Schema.Array(Caption))
const Source = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
export const idsOf = (json: string): readonly string[] => Schema.decodeUnknownSync(Ids)(json)
const captionsOf = (json: string): readonly Caption[] => Schema.decodeUnknownSync(Captions)(json)
const sourceOf = (json: string) => Schema.decodeUnknownSync(Source)(json)

/** How a file is reached by this viewer: a public `?v=` URL, a preview or share URL, or none. */
export type FileLink = (asset: { id: string; public: boolean }, file: FileRow) => Promise<string | null>

export const optional = <K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } =>
  // SAFETY: the object has exactly the key K, holding a V, or no key at all.
  (value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: V }

export async function groupsById(sql: AsyncSql): Promise<Map<string, GroupRow>> {
  const rows = await sql.all<GroupRow>('SELECT * FROM media_groups ORDER BY position, title')
  return new Map(rows.map((row) => [row.id, row]))
}

/** Public now: published, not deleted, and not on an internal section's shelf. */
export const effectivePublic = (asset: AssetRow, groups: Map<string, GroupRow>): boolean =>
  asset.deleted_at === null &&
  asset.level === 'public' &&
  (asset.section === null || groups.get(asset.section)?.level === 'public')

export async function assetRow(sql: AsyncSql, id: string): Promise<AssetRow | undefined> {
  return (await sql.all<AssetRow>('SELECT * FROM media_assets WHERE id = ?', id))[0]
}

export async function postRow(sql: AsyncSql, id: string): Promise<PostRow | undefined> {
  return (await sql.all<PostRow>('SELECT * FROM media_posts WHERE id = ?', id))[0]
}

const ROLE_ORDER: Readonly<Record<FileRole, number>> = { main: 0, poster: 1, captions: 2, extra: 3 }

export async function filesOf(sql: AsyncSql, assetIds: readonly string[]): Promise<Map<string, FileRow[]>> {
  const byAsset = new Map<string, FileRow[]>()
  if (assetIds.length === 0) return byAsset
  const wanted = new Set(assetIds)
  for (const file of await sql.all<FileRow>('SELECT * FROM media_files ORDER BY asset_id, name')) {
    if (wanted.has(file.asset_id)) byAsset.set(file.asset_id, [...(byAsset.get(file.asset_id) ?? []), file])
  }
  for (const files of byAsset.values())
    files.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name))
  return byAsset
}

export function groupView(row: GroupRow) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    ...optional('note', row.note),
    level: row.level,
    position: row.position,
    featured: row.featured === 1,
    ...optional('briefAsset', row.brief_asset),
    ...optional('startsOn', row.starts_on),
    ...optional('endsOn', row.ends_on),
    ...optional('status', row.status),
    revision: row.revision,
  }
}

async function fileViews(asset: AssetRow, files: readonly FileRow[], isPublic: boolean, link: FileLink) {
  const target = { id: asset.id, public: isPublic }
  return Promise.all(
    files.map(async (file) => ({
      name: file.name,
      role: file.role,
      ...optional('label', file.label),
      bytes: file.bytes,
      type: file.type,
      sha256: file.sha256,
      url: await link(target, file),
    })),
  )
}

export async function assetView(asset: AssetRow, files: readonly FileRow[], isPublic: boolean, link: FileLink) {
  return {
    id: asset.id,
    level: asset.level,
    public: isPublic,
    kind: asset.kind,
    title: asset.title,
    ...optional('description', asset.description),
    ...optional('note', asset.note),
    ...optional('section', asset.section),
    ...optional('campaign', asset.campaign),
    ...optional('batch', asset.batch),
    picked: asset.picked === 1,
    position: asset.position,
    ...optional('width', asset.width),
    ...optional('height', asset.height),
    ...optional('duration', asset.duration),
    captions: captionsOf(asset.captions_json),
    ...(asset.source_json === null ? {} : { source: sourceOf(asset.source_json) }),
    createdBy: asset.created_by,
    createdAt: asset.created_at,
    ...optional('publishedAt', asset.published_at),
    revision: asset.revision,
    files: await fileViews(asset, files, isPublic, link),
  }
}

export function postView(row: PostRow) {
  return {
    id: row.id,
    ...optional('campaign', row.campaign),
    channel: row.channel,
    ...optional('account', row.account),
    ...optional('day', row.day),
    ...optional('time', row.time),
    text: row.text,
    ...optional('note', row.note),
    assets: idsOf(row.asset_ids_json),
    status: row.status,
    createdBy: row.created_by,
    ...optional('approvedBy', row.approved_by),
    ...optional('approvedAt', row.approved_at),
    ...optional('url', row.url),
    ...optional('postedAt', row.posted_at),
    ...optional('recordedBy', row.recorded_by),
    revision: row.revision,
  }
}
