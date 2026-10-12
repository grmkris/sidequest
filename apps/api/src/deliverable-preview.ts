/**
 * What a delivery looks like, for Explore's rows and receipt card (ADR-0006: the board keeps no copy of the work).
 * `GET /data/deliverables/<taskId>/<deliverableHash>/preview` answers the task's recorded deliverable (descriptor and
 * submission check) and, for a `url` delivery, what the site says about itself: its `deliverable.json` (the crew
 * convention: type, title, summary, media, poster), else its page head (og:image, og:title, <title>, description).
 * Only that metadata leaves here, cached at the edge; a viewer's browser loads any poster from the worker's own host.
 * A hash is read only when the chain recorded it as that task's delivery, so this never fetches an arbitrary URL.
 */
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { type Deliverable, type DeliverableCheck, fetchable, parseDeliverable, readCapped } from '@sidequest/board'

const PREVIEW_TYPES = ['video', 'audio', 'site', 'report', 'dataset', 'image', 'code'] as const
type PreviewType = (typeof PREVIEW_TYPES)[number]

export interface DeliverablePreview {
  /** Where the metadata came from; null when the delivery says nothing about itself (or is not a site). */
  source: 'manifest' | 'page' | null
  type: PreviewType | null
  title: string | null
  summary: string | null
  /** https only, on a public host; resolved against where it was found. */
  poster: string | null
  media: string | null
}

export const NO_PREVIEW: DeliverablePreview = {
  source: null,
  type: null,
  title: null,
  summary: null,
  poster: null,
  media: null,
}

const PATH = /^\/data\/deliverables\/([A-Za-z0-9_-]{1,64})\/(0x[0-9a-fA-F]{64})\/preview$/
const MANIFEST_BYTES = 64 * 1024
const HEAD_BYTES = 256 * 1024
const TIMEOUT_MS = 4000
const MAX_REDIRECTS = 3
/**
 * Seconds a preview is cached: a found one for an hour; a delivery not yet on chain for thirty seconds (the index
 * lags a submission); a site that answered nothing usable for five minutes, so every viewer's polling does not refetch
 * the delivered site itself, yet a preview that appears after the site's own deploy still shows within minutes.
 */
const HIT = 3600
const MISS = 30
const SITE_MISS = 300

export const isPreviewPath = (path: string) => path.startsWith('/data/deliverables/')

export function previewTarget(path: string): { taskId: string; hash: string } | null {
  const [, taskId, hash] = PATH.exec(path) ?? []
  return taskId === undefined || hash === undefined ? null : { taskId, hash: hash.toLowerCase() }
}

const isText = (value: unknown): value is string => typeof value === 'string'
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** One line of text at most `max` characters: control characters and runs of whitespace become single spaces. */
function clean(value: unknown, max: number): string | null {
  if (!isText(value)) return null
  const line = value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (line === '') return null
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** An https URL on a public host, resolved against where it was found; anything else is dropped. */
export function publicUrl(raw: unknown, base: string): string | null {
  if (!isText(raw) || raw.trim() === '') return null
  try {
    const href = new URL(raw.trim(), base).href
    return href.startsWith('https://') && fetchable(href) ? href : null
  } catch {
    return null
  }
}

/** A `deliverable.json`; null when it is not one (an SPA's index.html, a JSON array, an empty object). */
export function parseManifest(text: string, base: string): DeliverablePreview | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  const preview: DeliverablePreview = {
    source: 'manifest',
    type: PREVIEW_TYPES.find((t) => t === raw.type) ?? null,
    title: clean(raw.title, 140),
    summary: clean(raw.summary, 300),
    poster: publicUrl(raw.poster, base),
    media: publicUrl(raw.media, base),
  }
  return preview.type === null && preview.title === null && preview.poster === null ? null : preview
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16))
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10))
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** A tag's attributes, names lower-cased, values decoded; any quoting style and order. */
function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const [, name, double, single, bare] of tag.matchAll(
    /([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
  ))
    if (name !== undefined) out.set(name.toLowerCase(), decodeEntities(double ?? single ?? bare ?? ''))
  return out
}

/** The page's own description of itself, read from its head only. */
export function parseHead(html: string, base: string): DeliverablePreview {
  const end = html.search(/<\/head\s*>/i)
  const head = end === -1 ? html : html.slice(0, end)
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map(([tag]) => attributes(tag))
  const meta = (...keys: string[]) => {
    for (const key of keys) {
      const hit = metas.find((m) => (m.get('property') ?? m.get('name'))?.toLowerCase() === key)?.get('content')
      if (hit !== undefined && hit.trim() !== '') return hit
    }
    return undefined
  }
  const [, title] = /<title[^>]*>([^<]*)<\/title\s*>/i.exec(head) ?? []
  const preview: DeliverablePreview = {
    source: 'page',
    type: null,
    title: clean(meta('og:title') ?? (title === undefined ? undefined : decodeEntities(title)), 140),
    summary: clean(meta('og:description', 'description'), 300),
    poster: publicUrl(meta('og:image', 'og:image:url', 'twitter:image'), base),
    media: null,
  }
  return preview.title === null && preview.poster === null ? NO_PREVIEW : preview
}

export interface FetchDeps {
  fetch: typeof fetch
  /** Hosts never fetched: this API's own and the public site's, so a delivery cannot point the reader back at us. */
  selfHosts: readonly string[]
}

const reachable = (url: string, deps: FetchDeps) =>
  url.startsWith('https://') && fetchable(url) && !deps.selfHosts.includes(new URL(url).host)

/** A public https body, following at most three redirects by hand so every hop passes the same guard. */
async function fetchPublic(
  deps: FetchDeps,
  url: string,
  accept: string,
  max: number,
  overflow: 'fail' | 'truncate',
): Promise<{ text: string; url: string; html: boolean } | null> {
  let at = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!reachable(at, deps)) return null
    const res = await deps.fetch(at, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept, 'user-agent': 'SidequestPreview/1' },
    })
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location !== null) {
      void res.body?.cancel().catch(() => {})
      at = new URL(location, at).href
      continue
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {})
      return null
    }
    const { bytes } = await readCapped(res, max, overflow)
    if (bytes === null) return null
    return {
      text: new TextDecoder().decode(bytes),
      url: at,
      html: (res.headers.get('content-type') ?? '').includes('html'),
    }
  }
  return null
}

/** What a delivered site says about itself: its manifest at the site root, else its page head. */
export async function readPreview(site: string, deps: FetchDeps): Promise<DeliverablePreview> {
  const manifest = await fetchPublic(
    deps,
    new URL('/deliverable.json', site).href,
    'application/json',
    MANIFEST_BYTES,
    'fail',
  )
  const described = manifest === null ? null : parseManifest(manifest.text, manifest.url)
  if (described !== null) return described
  const page = await fetchPublic(deps, site, 'text/html', HEAD_BYTES, 'truncate')
  return page?.html === true ? parseHead(page.text, page.url) : NO_PREVIEW
}

export interface Handed {
  descriptor: Deliverable
  check: DeliverableCheck | null
}

function checkOf(raw: unknown): DeliverableCheck | null {
  if (!isRecord(raw) || !isText(raw.detail)) return null
  const ok = raw.ok === true || raw.ok === false ? raw.ok : null
  return { ok, detail: raw.detail, checkedAt: Number(raw.checkedAt) || 0 }
}

/** The task's deliverable with this hash, from a `get_task` result; null when the task never recorded it. */
export function handedIn(result: unknown, hash: string): Handed | null {
  const list = isRecord(result) && Array.isArray(result.deliverables) ? result.deliverables : []
  const hit = list.find((d) => isRecord(d) && isText(d.deliverable_hash) && d.deliverable_hash.toLowerCase() === hash)
  if (!isRecord(hit)) return null
  try {
    return { descriptor: parseDeliverable(hit.descriptor), check: checkOf(hit.check) }
  } catch {
    return null
  }
}

export interface PreviewCache {
  match(key: string): Promise<Response | undefined>
  put(key: string, response: Response): Promise<void>
}

export interface PreviewDeps extends FetchDeps {
  /** Whether the chain recorded `hash` as this board's task's delivery (a D1 read, before any board call). */
  submitted(taskId: string, hash: string): Promise<boolean>
  /** The board's `get_task`. */
  task(taskId: string): Promise<{ ok: boolean; code?: string; result?: unknown }>
  cache: PreviewCache | undefined
}

interface Reply {
  status: number
  body: unknown
  /** Seconds to cache; null for an answer that must not be kept (the board was unavailable). */
  seconds: number | null
}

const UNAVAILABLE: Reply = {
  status: 503,
  body: { ok: false, code: 'unavailable', message: 'the index or the board is unavailable' },
  seconds: null,
}

const NOT_FOUND: Reply = {
  status: 404,
  body: { ok: false, code: 'not-found', message: 'no such delivery on this board' },
  seconds: MISS,
}

async function build(target: { taskId: string; hash: string }, deps: PreviewDeps): Promise<Reply> {
  if (!(await deps.submitted(target.taskId, target.hash))) return NOT_FOUND
  const task = await deps.task(target.taskId)
  if (!task.ok) return task.code === 'not-found' ? NOT_FOUND : UNAVAILABLE
  const deliverable = handedIn(task.result, target.hash)
  if (deliverable === null) return NOT_FOUND
  const site = deliverable.descriptor.kind === 'url' ? deliverable.descriptor.url : null
  const preview = site === null ? NO_PREVIEW : await readPreview(site, deps).catch(() => NO_PREVIEW)
  return {
    status: 200,
    body: { ok: true, deliverable, preview },
    seconds: site !== null && preview.source === null ? SITE_MISS : HIT,
  }
}

function respond(status: number, body: string, headers: Record<string, string>) {
  return HttpServerResponse.text(body, {
    status,
    contentType: 'application/json; charset=utf-8',
    headers: { 'x-content-type-options': 'nosniff', ...headers },
  })
}

/** The stored copy's own lifetime, in seconds, kept beside its `cache-control`. */
const MAX_AGE = 'x-sidequest-max-age'

/**
 * The lifetime a cached answer is served with: its own, as the route set it. Cloudflare rewrites the stored copy's
 * `cache-control` to the zone's browser TTL (four hours), so the route keeps its own number beside it; a copy stored
 * before it did gets the route's shorter lifetime.
 */
function hitCacheControl(hit: Response): string {
  const seconds = Number(hit.headers.get(MAX_AGE))
  return `public, max-age=${Number.isInteger(seconds) && seconds > 0 ? seconds : MISS}`
}

/**
 * The route. `key` names the cache entry (the request's absolute URL); the stored copy carries no CORS header, which
 * is added per response.
 */
export async function previewRoute(
  req: { taskId: string; hash: string; key: string; cors: Record<string, string> },
  deps: PreviewDeps,
): Promise<HttpServerResponse.HttpServerResponse> {
  const hit = await deps.cache?.match(req.key).catch(() => undefined)
  if (hit !== undefined)
    return respond(hit.status, await hit.text(), {
      ...req.cors,
      'cache-control': hitCacheControl(hit),
      'x-sidequest-preview': 'hit',
    })
  // An index not built yet (no `jobs` table) or a failed board call is unavailable, never cached.
  const reply = await build(req, deps).catch(() => UNAVAILABLE)
  const body = JSON.stringify(reply.body)
  const cacheControl = reply.seconds === null ? 'no-store' : `public, max-age=${reply.seconds}`
  if (reply.seconds !== null)
    await deps.cache
      ?.put(
        req.key,
        new Response(body, {
          status: reply.status,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': cacheControl,
            [MAX_AGE]: String(reply.seconds),
          },
        }),
      )
      .catch(() => {})
  return respond(reply.status, body, { ...req.cors, 'cache-control': cacheControl, 'x-sidequest-preview': 'miss' })
}

/** The edge cache where the runtime has one (workerd's `caches.default`); undefined elsewhere, as in unit tests. */
export function edgeCache(): PreviewCache | undefined {
  // SAFETY: workerd defines the Cache API global (`caches.default`: match(key), put(key, response)); node does not.
  return (globalThis as { caches?: { default?: PreviewCache } }).caches?.default
}
