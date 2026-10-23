/** The library's tools (ADR-0029): reads for everyone, uploads and edits for the team, publishing for operators. */
import { BoardError } from '@sidequest/board'
import { actorName, requireRole } from './access.ts'
import * as Args from './args.ts'
import { pullMedia } from './pull.ts'
import { checksumHex } from './serve.ts'
import * as store from './store.ts'
import { linker, type MediaDeps, type MediaTool, mediaTool, randomId, slugOf, writeContext } from './tool-kit.ts'
import { uploadToken } from './tokens.ts'

type FileInput = (typeof Args.MediaFile)['Type']

const KIND_BY_PREFIX: readonly (readonly [string, store.AssetKind])[] = [
  ['video/', 'video'],
  ['image/', 'image'],
  ['audio/', 'audio'],
  ['text/markdown', 'document'],
  ['text/plain', 'document'],
]
const kindOf = (type: string): store.AssetKind =>
  KIND_BY_PREFIX.find(([prefix]) => type.startsWith(prefix))?.[1] ?? 'file'

/** A file the caller uploaded: it must be in storage, with R2's own sha256 matching its name. */
async function uploaded(deps: MediaDeps, sha256: string) {
  if (deps.bucket === undefined) throw new BoardError('unavailable', 'media storage is not configured here')
  const head = await deps.bucket.head(`files/${sha256}`)
  if (head === null)
    throw new BoardError('invalid', `no uploaded file ${sha256.slice(0, 12)}…; upload it first (prepare_media_upload)`)
  if (checksumHex(head.checksums.sha256) !== sha256)
    throw new BoardError('invalid', 'the stored file does not carry that sha256; upload it again')
  return { sha256, bytes: head.size, type: head.httpMetadata?.contentType ?? 'application/octet-stream' }
}

async function stored(deps: MediaDeps, file: FileInput) {
  if (file.sourceUrl === undefined) {
    if (file.sha256 === undefined)
      throw new BoardError('invalid', 'each file needs a sha256 (after its upload) or a sourceUrl')
    return uploaded(deps, file.sha256)
  }
  if (deps.bucket === undefined) throw new BoardError('unavailable', 'media storage is not configured here')
  return pullMedia(
    { bucket: deps.bucket, hosts: deps.media?.pullHosts ?? [], fetch: deps.fetch },
    file.sourceUrl,
    file.sha256,
  )
}

async function filesOf(deps: MediaDeps, input: readonly FileInput[]): Promise<store.NewFile[]> {
  const files: store.NewFile[] = []
  for (const file of input) {
    const kept = await stored(deps, file)
    files.push({
      name: file.name,
      role: file.role ?? 'extra',
      ...(file.label === undefined ? {} : { label: file.label }),
      bytes: kept.bytes,
      type: file.type ?? kept.type,
      sha256: kept.sha256,
    })
  }
  if (files.filter((file) => file.role === 'main').length !== 1)
    throw new BoardError('invalid', 'exactly one file has role main')
  if (new Set(files.map((file) => file.name)).size !== files.length)
    throw new BoardError('invalid', 'file names must differ')
  return files
}

/** The asset fields of an add or update, without the tool's own keys. */
function fieldsOf(input: Partial<(typeof Args.UpdateMedia)['Type']>): store.AssetFields {
  const { id: _id, revision: _revision, ...fields } = input
  return fields
}

async function prepareUpload(
  deps: MediaDeps,
  actor: Parameters<MediaTool['run']>[1],
  input: (typeof Args.PrepareUpload)['Type'],
) {
  requireRole(actor, 'member')
  const bucket = deps.bucket
  if (bucket === undefined) throw new BoardError('unavailable', 'media storage is not configured here')
  const expires = deps.now() + 3600
  const files = await Promise.all(
    input.files.map(async ({ sha256, bytes, type }) => {
      if ((await bucket.head(`files/${sha256}`)) !== null) return { sha256, stored: true }
      const token = await uploadToken(deps.signingKey, { sha256, bytes, type, actor: actorName(actor), expires })
      return {
        sha256,
        stored: false,
        method: 'PUT',
        url: `${deps.origin}/media/upload/${sha256}?u=${token}`,
        headers: { 'content-type': type },
        expiresAt: expires,
      }
    }),
  )
  return { files }
}

export const libraryTools: Record<string, MediaTool> = {
  list_media: mediaTool(
    "Sidequest's media library: sections and assets (videos, images, briefs) with file URLs. Anyone sees public media; the media team also sees internal assets, campaigns and variants. Filter by level, section, campaign, batch, kind or text.",
    Args.ListMedia,
    (deps, actor, input) => store.listMedia(deps.sql, actor, input, linker(deps, actor)),
  ),
  get_media: mediaTool(
    'One media asset: its files with URLs, its section and the posts that used it.',
    Args.GetMedia,
    (deps, actor, input) => store.getMedia(deps.sql, actor, input.id, linker(deps, actor)),
  ),
  prepare_media_upload: mediaTool(
    'The media team: upload links for files to add. For each file give its sha256, size and media type; a file already stored needs no upload. PUT each file to its url with that Content-Type within an hour (curl -T file -H "content-type: …" url), at most 100 MB a file; bigger renders go through add_media with a sourceUrl. Then call add_media with the same sha256.',
    Args.PrepareUpload,
    prepareUpload,
  ),
  add_media: mediaTool(
    'The media team: add an internal asset (or, with its revision, a new version of one) from uploaded files or sourceUrls. New assets are internal; an operator publishes them. One file is main; posters, captions and extras sit beside it.',
    Args.AddMedia,
    async (deps, actor, input, args) => {
      requireRole(actor, 'member')
      const ctx = writeContext(deps, actor, 'add_media', args)
      const files = await filesOf(deps, input.files)
      const main = files.find((file) => file.role === 'main')!
      const fields = fieldsOf(input)
      const title = input.title ?? (input.revision === undefined ? main.name : undefined)
      const id = input.id ?? `${slugOf(title ?? '') || 'media'}-${randomId('').slice(0, 4)}`
      const created =
        input.revision === undefined
          ? { ...(title === undefined ? {} : { title }), kind: input.kind ?? kindOf(main.type) }
          : {}
      return store.addAsset(deps.sql, ctx, {
        id,
        ...(input.revision === undefined ? {} : { revision: input.revision }),
        fields: { ...fields, ...created },
        files,
      })
    },
  ),
  update_media: mediaTool(
    "The media team: change an asset's title, description, note, section, campaign, batch, pick, order, size or captions. Pass the revision you read. A public asset changes only by an operator.",
    Args.UpdateMedia,
    (deps, actor, input, args) =>
      store.updateAsset(deps.sql, writeContext(deps, actor, 'update_media', args), {
        id: input.id,
        revision: input.revision,
        fields: fieldsOf(input),
      }),
  ),
  publish_media: mediaTool(
    'A media operator: make an asset public (on /media and readable by anyone) or internal again. What goes public is a claim Sidequest makes: lead with the work, never invent numbers, keep "illustrative" notes. Unpublished files stop being served at once.',
    Args.PublishMedia,
    (deps, actor, input, args) =>
      store.setAssetLevel(deps.sql, writeContext(deps, actor, 'publish_media', args), {
        id: input.id,
        level: input.public ? 'public' : 'internal',
        ...(input.revision === undefined ? {} : { revision: input.revision }),
      }),
  ),
  delete_media: mediaTool(
    'A media operator: remove an asset from the library; its files stop being served.',
    Args.GetMedia,
    (deps, actor, input, args) =>
      store.deleteAsset(deps.sql, writeContext(deps, actor, 'delete_media', args), { id: input.id }),
  ),
  save_media_group: mediaTool(
    'Add or change a section (what /media shows, in order: an operator) or a campaign (one story across channels, with its brief, window and status: any team member). Pass the revision to change one.',
    Args.SaveGroup,
    (deps, actor, input, args) => {
      const { id, revision, ...fields } = input
      const slug = id ?? slugOf(fields.title)
      if (slug === '' || store.RESERVED_IDS.has(slug)) throw new BoardError('invalid', 'give the group an id')
      return store.saveGroup(deps.sql, writeContext(deps, actor, 'save_media_group', args), {
        id: slug,
        ...(revision === undefined ? {} : { revision }),
        fields,
      })
    },
  ),
}
