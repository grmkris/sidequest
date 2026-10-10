/**
 * The Explore Worker: static assets for the SPA, and the board API proxied same-origin through the `API` service
 * binding (no CORS, no API URL baked into the build).
 *
 * Pages carry the security headers Privy asks for before production: a Content Security Policy built from Privy's
 * recommended policy (its iframe, WalletConnect, Cloudflare Turnstile) plus the Monad RPCs the app reads from, and no
 * framing (`frame-ancestors 'none'`, `X-Frame-Options: DENY`). The drop-in widget (`/embed/<board>`, ADR-0008) is the
 * one page meant to be framed: only by the board's own `allowedOrigins`, read from its public `get_board`.
 */
import { isApiPath, isFilePath } from './routing.ts'
import { renderStartGuide, startGuideType } from './start-guide.ts'
import { docsRoute, serveDocs } from './docs-handler.ts'

interface Env {
  readonly API: { fetch(request: Request): Promise<Response> }
  readonly ASSETS: { fetch(request: Request): Promise<Response> }
}

const PRIVY_FRAMES = ['https://auth.privy.io', 'https://verify.walletconnect.com', 'https://verify.walletconnect.org']
const CSP_BASE = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  // Any https image: a delivery's poster or image file loads from the worker's own host (ADR-0006: the board keeps no
  // copy). Images only; frames and scripts stay locked to the hosts below.
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  `child-src ${PRIVY_FRAMES.join(' ')}`,
  `frame-src ${PRIVY_FRAMES.join(' ')} https://challenges.cloudflare.com`,
  [
    "connect-src 'self'",
    // A delivered 3D model is fetched from its own host when a card turns it, and glTF textures decode through blob:
    // URLs (Kris, 10 Oct). The hosts below predate this and stay listed so it can be reverted on its own.
    'https:',
    'blob:',
    'https://auth.privy.io',
    'wss://relay.walletconnect.com',
    'wss://relay.walletconnect.org',
    'wss://www.walletlink.org',
    'https://*.rpc.privy.systems',
    'https://explorer-api.walletconnect.com',
    // viem's default transports for Monad testnet and mainnet (wallet.ts, Privy.tsx)
    'https://testnet-rpc.monad.xyz',
    'https://rpc.monad.xyz',
    'https://rpc1.monad.xyz',
  ].join(' '),
  "worker-src 'self'",
  "manifest-src 'self'",
].join('; ')

const COMMON: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000',
}

/** Who may frame a board's widget: the board's allowed origins, cached a minute per isolate. */
const embedders = new Map<string, { at: number; origins: string[] }>()
async function frameAncestors(env: Env, request: Request, board: string): Promise<string[]> {
  const hit = embedders.get(board)
  if (hit !== undefined && Date.now() - hit.at < 60_000) return hit.origins
  let origins: string[] = []
  try {
    const url = new URL(`/b/${encodeURIComponent(board)}/api/get_board`, request.url)
    const res = await env.API.fetch(
      new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    )
    const body = (await res.json()) as { ok?: boolean; result?: { board?: { allowedOrigins?: unknown } } }
    const listed = body.result?.board?.allowedOrigins
    // origin expressions only (https://host[:port], http://localhost:*); anything else is dropped, not trusted
    if (Array.isArray(listed))
      origins = listed.filter(
        (o): o is string => typeof o === 'string' && /^https?:\/\/[a-z0-9.-]+(:(\d+|\*))?$/i.test(o),
      )
  } catch {
    origins = []
  }
  embedders.set(board, { at: Date.now(), origins })
  return origins
}

async function withHeaders(response: Response, env: Env, request: Request, pathname: string): Promise<Response> {
  const res = new Response(response.body, response)
  for (const [k, v] of Object.entries(COMMON)) res.headers.set(k, v)
  const embed = /^\/embed\/([^/]+)/.exec(pathname)
  if (embed?.[1] !== undefined) {
    const ancestors = ["'self'", ...(await frameAncestors(env, request, decodeURIComponent(embed[1])))]
    res.headers.set('Content-Security-Policy', `${CSP_BASE}; frame-ancestors ${ancestors.join(' ')}`)
  } else {
    res.headers.set('Content-Security-Policy', `${CSP_BASE}; frame-ancestors 'none'`)
    res.headers.set('X-Frame-Options', 'DENY')
  }
  return res
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (isApiPath(pathname)) return env.API.fetch(request)
    const docs = docsRoute(pathname)
    if (docs !== undefined) return serveDocs(request, env, docs)
    const asset = await env.ASSETS.fetch(request)
    // The SPA fallback answers any unknown path with index.html; a missing file must be a 404, or iOS takes the page
    // for an icon or a manifest.
    if (
      isFilePath(pathname) &&
      !pathname.endsWith('.html') &&
      asset.headers.get('content-type')?.startsWith('text/html')
    ) {
      return withHeaders(
        new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } }),
        env,
        request,
        pathname,
      )
    }
    let res = await withHeaders(asset, env, request, pathname)
    const guideType = startGuideType(pathname)
    if (guideType !== undefined && res.ok) {
      const source = renderStartGuide(await res.text(), new URL(request.url).origin)
      const headers = new Headers(res.headers)
      headers.set('Content-Type', guideType)
      // The served body includes this request's origin, so upstream byte metadata no longer applies.
      headers.delete('Content-Length')
      headers.delete('ETag')
      res = new Response(request.method === 'HEAD' ? null : source, { status: res.status, headers })
    }
    if (/^\/skills\/[a-z]+(?:-[a-z]+)*\/SKILL\.md$/.test(pathname) && res.ok) {
      const raw = renderStartGuide(await res.text(), new URL(request.url).origin)
      const headers = new Headers(res.headers)
      headers.delete('Content-Length')
      headers.delete('ETag')
      res = new Response(request.method === 'HEAD' ? null : raw, { status: res.status, headers })
    }
    if (pathname.endsWith('.webmanifest')) res.headers.set('Content-Type', 'application/manifest+json')
    // The agent skills (/skills/<role>/SKILL.md): readable in a browser and by `curl`, in UTF-8.
    if (pathname.endsWith('.md')) res.headers.set('Content-Type', 'text/markdown; charset=utf-8')
    return res
  },
}
