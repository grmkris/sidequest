/** OAuth 2.1 public clients: exact redirect/resource binding and PKCE S256 only. */
/**
 * The Commons role tools (ADR-0028). A plain scope, not an agent role: only the operator grants it, at consent, and the
 * Commons role holder list still decides every call.
 */
export const MAINTAIN_SCOPE = 'sidequest:maintain'
/**
 * The media team's tools (ADR-0029). The same kind of grant: only the operator ticks it, at consent, and the stage's
 * media team decides every call by the operator's role.
 */
export const MEDIA_SCOPE = 'sidequest:media'
export const OAUTH_SCOPES = ['sidequest:read', 'sidequest:hire', 'sidequest:work', MAINTAIN_SCOPE, MEDIA_SCOPE] as const

export function parseScopes(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined
  const scopes = [...new Set(value.split(' ').filter(Boolean))]
  return scopes.length > 0 && scopes.every((scope) => OAUTH_SCOPES.includes(scope as (typeof OAUTH_SCOPES)[number]))
    ? scopes
    : undefined
}

export function validRedirect(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const url = new URL(value)
    return (
      url.username === '' &&
      url.password === '' &&
      url.hash === '' &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
  } catch {
    return false
  }
}

export function resourceBoard(value: unknown, origin: string): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (url.origin !== origin || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '')
      return undefined
    if (url.pathname === '/mcp') return 'public'
    return /^\/b\/([a-z0-9-]{3,32})\/mcp$/.exec(url.pathname)?.[1]
  } catch {
    return undefined
  }
}

export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function tokenHash(token: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}
