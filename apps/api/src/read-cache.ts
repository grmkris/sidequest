/** Explicit HTTP policy for public discovery. This does not add a Workers Cache API layer. */
import * as Effect from 'effect/Effect'
import * as Cookies from 'effect/http/Cookies'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'

interface CacheRequest {
  method: string
  url: string
  headers: Readonly<Record<string, string | undefined>>
}

const PUBLIC_TTL: Readonly<Record<string, number>> = {
  '/data/boards': 60,
  '/data/stats': 30,
  '/data/jobs': 10,
  '/data/agents': 30,
  '/data/profiles': 60,
  '/data/services': 30,
  '/data/directory': 30,
  '/data/activity': 15,
}

const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'mcp-session-id', 'x-privy-token']

/** Credentials, cookies, errors, private routes and live economic snapshots always bypass shared caching. */
export function responseCacheControl(request: CacheRequest, response: HttpServerResponse.HttpServerResponse): string {
  if (request.method !== 'GET' && request.method !== 'HEAD') return 'no-store'
  if (CREDENTIAL_HEADERS.some((name) => request.headers[name] !== undefined)) return 'no-store'
  if (response.headers['set-cookie'] !== undefined || !Cookies.isEmpty(response.cookies)) return 'no-store'
  if (response.status !== 200 && response.status !== 304) return 'no-store'
  const url = new URL(request.url)
  const path = url.pathname.replace(/^\/b\/[a-z0-9-]{3,32}(?=\/)/, '')
  // Wallet-filtered discovery stays uncached even though the chain facts are public.
  if (url.searchParams.has('wallet')) return 'no-store'
  const seconds = PUBLIC_TTL[path]
  if (seconds !== undefined && response.status === 200)
    return `public, max-age=${seconds}, s-maxage=${seconds}, stale-while-revalidate=${seconds}`
  // Preserve established immutable asset/offer and verified preview policies.
  if (
    /^\/(?:avatars|offers|profiles)\//.test(path) ||
    path.startsWith('/data/deliverables/') ||
    path === '/mcp/server-card' ||
    path.startsWith('/.well-known/')
  )
    return response.headers['cache-control'] ?? 'no-store'
  return 'no-store'
}

export const withReadCachePolicy = <E, R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const response = yield* effect
    const vary = new Set(
      (response.headers.vary ?? '')
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean),
    )
    for (const header of ['origin', ...CREDENTIAL_HEADERS]) vary.add(header)
    return response.pipe(
      HttpServerResponse.setHeader(
        'cache-control',
        responseCacheControl({ method: request.method, url: request.originalUrl, headers: request.headers }, response),
      ),
      HttpServerResponse.setHeader('vary', vary.has('*') ? '*' : [...vary].join(', ')),
    )
  })
