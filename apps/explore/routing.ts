/**
 * Which requests the Explore Worker hands to the board API and which are the SPA's. The API serves `/api/<tool>`,
 * `/data/…`, `/offers/…`, agents' `/avatars/…` and `/profiles/…`, `/mcp`, `/health` and the testnet `/x402/demo`, and
 * the API routes under a board's prefix `/b/<slug>`
 * (apps/api/src/worker.ts, BOARD_ROUTE). Every other `/b/<slug>/…` path is a page of the app (main.tsx board routes),
 * so a refresh, a shared link or the widget's "Open in Sidequest" loads the SPA.
 */
const PROXIED = [
  '/api/',
  '/data/',
  '/offers/',
  '/avatars/',
  '/profiles/',
  '/oauth/',
  '/.well-known/',
  '/mcp',
  '/mcp/server-card',
  '/health',
  '/x402/',
  '/aa/rpc',
]
const BOARD_API = /^\/b\/[a-z0-9-]{3,32}(?:\/api\/|\/data\/|\/offers\/|\/mcp(?:\/server-card)?$|\/health$)/

export function isApiPath(pathname: string): boolean {
  return PROXIED.some((p) => pathname === p || (p.endsWith('/') && pathname.startsWith(p))) || BOARD_API.test(pathname)
}

/** A path naming a file (`/icon.png`, `/manifest.webmanifest`); pages never have an extension. */
export function isFilePath(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1)
  return /\.[a-z0-9]+$/i.test(last)
}
