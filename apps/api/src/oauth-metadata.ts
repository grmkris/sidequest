/** Shared authorization/protected-resource metadata, including default-off workload grant advertisement. */
import type { OAuthReply } from './oauth.ts'
import { resourceBoard } from './oauth-validation.ts'
import { JWT_BEARER_GRANT, WORKLOAD_EXTENSION } from './workload-policies.ts'

function requestedResource(path: string, origin: string): string | undefined {
  const suffix =
    path === '/.well-known/oauth-protected-resource'
      ? '/mcp'
      : path.startsWith('/.well-known/oauth-protected-resource/')
        ? path.slice('/.well-known/oauth-protected-resource'.length)
        : undefined
  return suffix === undefined
    ? undefined
    : resourceBoard(`${origin}${suffix}`, origin) === undefined
      ? undefined
      : `${origin}${suffix}`
}

const good = (body: unknown): OAuthReply => ({ status: 200, body, headers: { 'cache-control': 'no-store' } })

export function oauthMetadata(
  path: string,
  method: string,
  origin: string,
  scopes: readonly string[],
  workloadEnabled: boolean,
): OAuthReply | undefined {
  const protectedResource = requestedResource(path, origin)
  if (protectedResource !== undefined)
    return good({
      resource: protectedResource,
      authorization_servers: [origin],
      scopes_supported: scopes,
      bearer_methods_supported: ['header'],
    })
  if (path === '/.well-known/oauth-authorization-server' && method === 'GET')
    return good({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token', ...(workloadEnabled ? [JWT_BEARER_GRANT] : [])],
      ...(workloadEnabled ? { extensions: { [WORKLOAD_EXTENSION]: {} } } : {}),
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: scopes,
    })
  return undefined
}
