/** Public OAuth endpoints use explicit client credentials, never ambient website credentials. */
export function publicOAuthCors(path: string): Record<string, string> | undefined {
  if (!path.startsWith('/.well-known/oauth-') && !['/oauth/register', '/oauth/token', '/oauth/revoke'].includes(path))
    return undefined
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
  }
}
