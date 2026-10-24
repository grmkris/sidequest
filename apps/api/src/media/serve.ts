/**
 * `GET|HEAD /media/f/<assetId>/<name>` and `PUT /media/upload/<sha256>` (ADR-0029). Files stream from and to R2 with
 * their length, single ranges, conditional requests and `?dl=1`. A public file is served to anyone; an internal one only
 * with a live share (`?s=`) or a team preview token (`?p=`), and never cached shared. Every reply carries a sandbox CSP,
 * because this origin holds Explore's sign-in session.
 */
import type { AsyncSql } from '@sidequest/indexer'
import { fileForServing } from './library.ts'
import type { FileRow } from './rows.ts'
import { liveShare } from './shares.ts'
import { hex, isShareToken, shareHash, verifyPreview, verifyUpload, type UploadGrant } from './tokens.ts'

/** The R2 calls the media routes make; the Worker's raw `Media` binding satisfies it. */
interface MediaObject {
  readonly key: string
  readonly size: number
  readonly httpEtag: string
  readonly checksums: { readonly sha256?: ArrayBuffer }
  readonly httpMetadata?: { readonly contentType?: string }
}
interface MediaObjectBody extends MediaObject {
  readonly body: ReadableStream
}
type Range = { offset: number; length?: number } | { suffix: number }
export interface MediaBucket {
  head(key: string): Promise<MediaObject | null>
  get(key: string, options?: { range?: Range; onlyIf?: Headers }): Promise<MediaObject | MediaObjectBody | null>
  put(
    key: string,
    value: ReadableStream | Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string }; sha256?: string },
  ): Promise<MediaObject | null>
}

/** The most one file may weigh; the Free zone also caps one request at 100 MB. */
export const MAX_MEDIA_BYTES = 1024 * 1024 * 1024

const MEDIA_FILE_PATH = /^\/media\/f\/([a-z0-9][a-z0-9-]{0,63})\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/
const MEDIA_UPLOAD_PATH = /^\/media\/upload\/([0-9a-f]{64})$/

const BASE_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; font-src 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-site',
}

const plain = (status: number, text: string, extra: Record<string, string> = {}) =>
  new Response(text, {
    status,
    headers: { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra },
  })
const notFound = () => plain(404, 'not found')

export const checksumHex = (buffer: ArrayBuffer | undefined): string | undefined =>
  buffer === undefined ? undefined : hex(buffer)

/** A single `bytes=a-b`, `bytes=a-` or `bytes=-n`; anything else serves the whole file. */
function parseRange(header: string | null): { start: number; end?: number } | { suffix: number } | undefined {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/)
  if (!match || (!match[1] && !match[2])) return undefined
  if (!match[1]) return { suffix: Number(match[2]) }
  // A reversed range is not satisfiable as written; RFC 9110 serves the whole file instead.
  if (match[2] && Number(match[2]) < Number(match[1])) return undefined
  return { start: Number(match[1]), ...(match[2] ? { end: Number(match[2]) } : {}) }
}

export interface ServeDeps {
  readonly sql: AsyncSql
  readonly bucket: MediaBucket | undefined
  readonly signingKey: string
  readonly now: number
}

const privately = (expires: number, now: number) => `private, max-age=${Math.max(0, Math.min(3600, expires - now))}`

/** Who may read this file now, and how long a browser may keep it; undefined when this request may not. */
async function access(deps: ServeDeps, url: URL, assetId: string, found: { file: FileRow; public: boolean }) {
  if (found.public)
    return url.searchParams.get('v') === found.file.sha256.slice(0, 8)
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=0, must-revalidate'
  const share = url.searchParams.get('s') ?? ''
  if (isShareToken(share)) {
    const live = await liveShare(deps.sql, await shareHash(share), deps.now)
    if (live?.assets.includes(assetId) === true) return privately(live.expiresAt, deps.now)
  }
  const preview = url.searchParams.get('p') ?? ''
  if (await verifyPreview(deps.signingKey, assetId, preview, deps.now))
    return privately(Number(preview.split('.')[0]), deps.now)
  return undefined
}

/**
 * Scripts and stylesheets an upload carries: served as plain text and as a download, so this origin's pages, whose CSP
 * trusts `'self'`, can never run or apply one. HTML and SVG stay viewable under the sandbox CSP.
 */
const ACTIVE = /^(text\/(javascript|ecmascript|css)|application\/(javascript|ecmascript|x-javascript))$/

function fileHeaders(file: FileRow, isPublic: boolean, cacheControl: string, download: boolean): Headers {
  const headers = new Headers(BASE_HEADERS)
  const active = ACTIVE.test(file.type)
  headers.set('content-type', active ? 'text/plain; charset=utf-8' : file.type)
  headers.set('cache-control', cacheControl)
  headers.set('accept-ranges', 'bytes')
  if (!isPublic) headers.set('x-robots-tag', 'noindex')
  if (download || active) headers.set('content-disposition', `attachment; filename="${file.name}"`)
  return headers
}

const r2Range = (range: ReturnType<typeof parseRange>): { range?: Range } =>
  range === undefined
    ? {}
    : {
        range:
          'suffix' in range
            ? range
            : { offset: range.start, ...(range.end === undefined ? {} : { length: range.end - range.start + 1 }) },
      }

/** The body, a range of it, 304/412 for a failed precondition, or 416 for a range past its end. */
async function body(bucket: MediaBucket, key: string, request: Request, headers: Headers): Promise<Response> {
  const range = parseRange(request.headers.get('range'))
  let object: MediaObject | MediaObjectBody | null
  try {
    object = await bucket.get(key, { ...r2Range(range), onlyIf: request.headers })
  } catch {
    // R2 refuses a range it cannot satisfy; any other failure is storage, not the request.
    if (range === undefined) return plain(503, 'storage unavailable; try again')
    const head = await bucket.head(key)
    return head === null ? notFound() : plain(416, 'range not satisfiable', { 'content-range': `bytes */${head.size}` })
  }
  if (object === null) return notFound()
  headers.set('etag', object.httpEtag)
  if (!('body' in object)) {
    const notModified = request.headers.has('if-none-match') || request.headers.has('if-modified-since')
    return new Response(null, { status: notModified ? 304 : 412, headers })
  }
  if (range === undefined) {
    headers.set('content-length', String(object.size))
    return new Response(object.body, { status: 200, headers })
  }
  const start = 'suffix' in range ? Math.max(0, object.size - range.suffix) : range.start
  const end = 'suffix' in range || range.end === undefined ? object.size - 1 : Math.min(range.end, object.size - 1)
  headers.set('content-range', `bytes ${start}-${end}/${object.size}`)
  headers.set('content-length', String(end - start + 1))
  return new Response(object.body, { status: 206, headers })
}

export async function serveMediaFile(deps: ServeDeps, request: Request, url: URL): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return plain(405, 'method not allowed', { allow: 'GET, HEAD' })
  const match = MEDIA_FILE_PATH.exec(url.pathname)
  const assetId = match?.[1]
  const name = match?.[2]
  if (assetId === undefined || name === undefined || deps.bucket === undefined) return notFound()
  const found = await fileForServing(deps.sql, assetId, name)
  // Internal, unknown and deleted files answer alike, so a guess learns nothing.
  const cacheControl = found === undefined ? undefined : await access(deps, url, assetId, found)
  if (found === undefined || cacheControl === undefined) return notFound()
  const headers = fileHeaders(found.file, found.public, cacheControl, url.searchParams.get('dl') === '1')
  if (request.method !== 'HEAD') return body(deps.bucket, found.file.key, request, headers)
  const head = await deps.bucket.head(found.file.key)
  if (head === null) return notFound()
  headers.set('etag', head.httpEtag)
  headers.set('content-length', String(head.size))
  return new Response(null, { status: 200, headers })
}

const json = (status: number, reply: object) =>
  new Response(JSON.stringify(reply), {
    status,
    headers: { ...BASE_HEADERS, 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
const refuse = (status: number, code: string, message: string) => json(status, { ok: false, code, message })

/** The grant an upload request holds, or the reply refusing it. */
async function uploadGrant(deps: ServeDeps, request: Request, url: URL): Promise<UploadGrant | Response> {
  const sha256 = MEDIA_UPLOAD_PATH.exec(url.pathname)?.[1]
  if (request.method !== 'PUT') return refuse(405, 'invalid', 'upload with PUT')
  if (sha256 === undefined || deps.bucket === undefined) return refuse(404, 'not-found', 'no such upload')
  const grant = await verifyUpload(deps.signingKey, url.searchParams.get('u') ?? '', sha256, deps.now)
  if (grant === undefined)
    return refuse(403, 'forbidden', 'this upload link is not valid; call prepare_media_upload again')
  if (Number(request.headers.get('content-length') ?? Number.NaN) !== grant.bytes)
    return refuse(400, 'invalid', `send exactly ${grant.bytes} bytes with a Content-Length`)
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
  if (type !== grant.type) return refuse(400, 'invalid', `send Content-Type: ${grant.type}`)
  return grant
}

/**
 * Streams one file into R2 under `files/<sha256>`, for the holder of an upload token naming that file. R2 checks the
 * sha256 as it stores the body, so a wrong body is refused and nothing is kept.
 */
export async function receiveMediaUpload(deps: ServeDeps, request: Request, url: URL): Promise<Response> {
  const grant = await uploadGrant(deps, request, url)
  if (grant instanceof Response) return grant
  const bucket = deps.bucket!
  const key = `files/${grant.sha256}`
  const existing = await bucket.head(key)
  if (existing !== null) {
    await request.body?.cancel()
    return json(200, { ok: true, result: { sha256: grant.sha256, bytes: existing.size, stored: 'already' } })
  }
  if (request.body === null) return refuse(400, 'invalid', 'the body is empty')
  try {
    await bucket.put(key, request.body, { sha256: grant.sha256, httpMetadata: { contentType: grant.type } })
  } catch {
    return refuse(400, 'invalid', 'the body does not match its sha256; nothing was stored')
  }
  const stored = await bucket.head(key)
  if (stored === null || stored.size !== grant.bytes || checksumHex(stored.checksums.sha256) !== grant.sha256)
    return refuse(502, 'unavailable', 'storage did not confirm the file; upload it again')
  return json(201, { ok: true, result: { sha256: grant.sha256, bytes: stored.size, stored: 'now' } })
}
