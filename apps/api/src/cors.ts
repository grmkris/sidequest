/**
 * Cross-origin access for tenant boards (ADR-0008): a page at one of a board's allowed origins may call
 * `/b/<slug>/api/*`, `/b/<slug>/mcp` and `/data/*` from the browser. Explore proxies same-origin and needs none of
 * this; a disallowed origin gets no allow-origin header and the browser refuses the reply.
 */
const CORS_HEADERS = 'authorization, content-type, mcp-session-id, x-privy-token'
const CORS_METHODS = 'GET, POST, OPTIONS'

/** The headers to add to a reply for a request from `origin`, when the board allows it; empty otherwise. */
export function corsHeaders(origin: string | undefined, allowed: boolean): Record<string, string> {
  if (origin === undefined || !allowed) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': CORS_HEADERS,
    'access-control-allow-methods': CORS_METHODS,
    // A browser client reads the step-up challenge (ADR-0021) from WWW-Authenticate.
    'access-control-expose-headers': 'mcp-session-id, www-authenticate',
    'access-control-max-age': '600',
    vary: 'origin',
  }
}
