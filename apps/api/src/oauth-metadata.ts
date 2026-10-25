import { resourceBoard } from './oauth-validation.ts'

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

/** RFC 9728 and RFC 8414 discovery documents share one canonical issuer. */
export function oauthMetadata(
  method: string,
  path: string,
  origin: string,
  scopes: readonly string[],
): Record<string, unknown> | undefined {
  const protectedResource = requestedResource(path, origin)
  if (protectedResource !== undefined)
    return {
      resource: protectedResource,
      authorization_servers: [origin],
      scopes_supported: scopes,
      bearer_methods_supported: ['header'],
    }
  if (path === '/.well-known/oauth-authorization-server' && method === 'GET')
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: scopes,
    }
  return undefined
}
