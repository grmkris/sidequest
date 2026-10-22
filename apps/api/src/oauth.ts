import { AgentStore, agentRoles, migrateAgentSchema, type AgentRole, type Sql } from '@sidequest/board'
import type { Statement } from '@sidequest/indexer'
import {
  MAINTAIN_SCOPE,
  parseScopes as parseAgentScopes,
  pkceChallenge,
  randomToken,
  resourceBoard,
  tokenHash,
  validRedirect,
  OAUTH_SCOPES as AGENT_SCOPES,
} from './oauth-validation.ts'

import { Schema } from 'effect'
import type { OAuthGrant as AgentOAuthGrant } from '@sidequest/indexer/oauth-types'
import { bindWaitingSetupConnections, consentScopes, resolveSetupOAuth, setupOAuthRoute } from './oauth-setup.ts'
export type OAuthGrant = AgentOAuthGrant & {
  readonly setup?: boolean
  readonly setupFamilyId?: string
  /** The agent's roles (ADR-0021): a connection does what its scope and these both allow. */
  readonly roles?: readonly AgentRole[]
  /** This connection holds a 2026 listen stream, so its tools/list can be exact. */
  readonly listening?: boolean
}
export const OAUTH_SCOPES = [...AGENT_SCOPES, 'sidequest:setup'] as const

function parseScopes(value: string): string[] | undefined {
  const roles = value
    .split(' ')
    .filter((scope) => scope !== 'sidequest:setup')
    .join(' ')
  const parsed = roles.trim() === '' ? [] : parseAgentScopes(roles)
  if (parsed === undefined) return undefined
  if (value.split(' ').includes('sidequest:setup')) parsed.push('sidequest:setup')
  return parsed.length === 0 ? undefined : parsed
}

export interface OAuthReply {
  readonly status: number
  readonly body?: unknown
  readonly headers?: Record<string, string>
  readonly redirect?: string
}

function write(sql: Sql, statements: readonly Statement[]): void {
  if (sql.atomic === undefined) throw new Error('OAuth requires atomic storage')
  sql.atomic(() => {
    for (const statement of statements) sql.run(statement.query, ...statement.params)
  })
}

const noStore = { 'cache-control': 'no-store' }
const failure = (error: string, description: string, status = 400): OAuthReply => ({
  status,
  body: { error, error_description: description },
  headers: noStore,
})
const good = (body: unknown, status = 200): OAuthReply => ({ status, body, headers: noStore })

function redirect(location: string): OAuthReply {
  return { status: 302, redirect: location, headers: noStore }
}

function consentId(): string {
  return `oauth_${randomToken().slice(0, 40)}`
}

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

export async function resolveOAuth(
  sql: Sql,
  token: string | undefined,
  resource: string,
  now: number,
): Promise<OAuthGrant | undefined> {
  if (token === undefined || token === '') return undefined
  const hash = await tokenHash(token)
  const setup = resolveSetupOAuth(sql, hash, resource, now)
  if (setup !== undefined) return setup
  const row = sql.all<{
    operator: string
    state: string
    address: string
    registry_agent_id: string | null
    chain_id: number
    permissions_json: string
    scopes_json: string
    resource: string
    client_id: string
    agent_id: string
    grant_id: string
  }>(
    "SELECT a.operator,a.state,a.address,a.agent_id registry_agent_id,a.chain_id,a.permissions_json,f.scopes_json,f.resource,f.client_id,f.agent_id,f.id grant_id FROM agent_oauth_tokens t JOIN agent_oauth_families f ON f.id=t.family_id JOIN agents a ON a.id=f.agent_id WHERE t.hash=? AND t.kind='access' AND t.expires_at>? AND f.revoked_at IS NULL",
    hash,
    now,
  )[0]
  if (row === undefined || row.resource !== resource || row.state !== 'active') return undefined
  return {
    owner: row.operator,
    scopes: JSON.parse(row.scopes_json) as string[],
    agentIds: [row.agent_id],
    resource: row.resource,
    clientId: row.client_id,
    address: row.address,
    registryAgentId: row.registry_agent_id,
    chainId: row.chain_id,
    grantId: row.grant_id,
    roles: agentRoles(row),
  }
}

export async function oauthRoute(input: {
  readonly sql: Sql
  readonly method: string
  readonly path: string
  readonly query: URLSearchParams
  readonly body: Record<string, unknown>
  readonly origin: string
  readonly siteOrigin: string
  readonly owner?: string
  readonly now: number
  readonly revokeSubscriptions?: (principal: string, grantId: string, now: number) => Promise<void>
}): Promise<OAuthReply | undefined> {
  const { sql, method, path, query, body, origin, siteOrigin, owner, now } = input
  migrateAgentSchema(sql)
  const setupReply = await setupOAuthRoute(input)
  if (setupReply !== undefined) return setupReply
  const terminateFamily = async (familyId: string) => {
    const agent = sql.all<{ address: string }>(
      'SELECT a.address FROM agents a JOIN agent_oauth_families f ON f.agent_id = a.id WHERE f.id = ?',
      familyId,
    )[0]
    if (agent !== undefined) await input.revokeSubscriptions?.(agent.address, familyId, now)
  }
  const protectedResource = requestedResource(path, origin)
  if (protectedResource !== undefined)
    return good({
      resource: protectedResource,
      authorization_servers: [origin],
      scopes_supported: OAUTH_SCOPES,
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
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: OAUTH_SCOPES,
    })
  if (path === '/oauth/register' && method === 'POST') {
    const redirectUris = body.redirect_uris
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length < 1 ||
      redirectUris.length > 8 ||
      !redirectUris.every(validRedirect)
    )
      return failure('invalid_client_metadata', 'Provide exact HTTPS or loopback redirect URIs')
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none')
      return failure('invalid_client_metadata', 'Only public PKCE clients are supported')
    const id = `hl_${randomToken().slice(0, 32)}`
    const name = typeof body.client_name === 'string' ? body.client_name.slice(0, 120) : 'Coding agent'
    write(sql, [
      {
        query: 'INSERT INTO agent_oauth_clients (id,name,redirect_uris_json,created_at) VALUES (?,?,?,?)',
        params: [id, name, JSON.stringify(redirectUris), now],
      },
    ])
    return good(
      {
        client_id: id,
        client_id_issued_at: now,
        client_name: name,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      201,
    )
  }
  if (path === '/oauth/authorize' && method === 'GET') {
    const clientId = query.get('client_id') ?? ''
    const redirectUri = query.get('redirect_uri') ?? ''
    const client = sql.all<{ redirect_uris_json: string }>(
      'SELECT redirect_uris_json FROM agent_oauth_clients WHERE id=?',
      clientId,
    )[0]
    if (client === undefined || !(JSON.parse(client.redirect_uris_json) as string[]).includes(redirectUri))
      return failure('invalid_request', 'Unknown client or redirect URI')
    const scopes = parseScopes(query.get('scope') ?? OAUTH_SCOPES.join(' '))
    const challenge = query.get('code_challenge') ?? ''
    const resource = query.get('resource')
    if (
      query.get('response_type') !== 'code' ||
      query.get('code_challenge_method') !== 'S256' ||
      !/^[-_A-Za-z0-9]{43}$/.test(challenge) ||
      scopes === undefined ||
      resourceBoard(resource, origin) === undefined
    )
      return failure(
        'invalid_request',
        'Require authorization code, PKCE S256, supported scope and explicit MCP resource',
      )
    // The same sign-in link opened twice (a client opens it and the user clicks it too) is one consent, not two.
    const pending = sql.all<{ id: string }>(
      "SELECT id FROM agent_oauth_requests WHERE client_id=? AND redirect_uri=? AND code_challenge=? AND state=? AND resource=? AND scopes_json=? AND status='pending' AND expires_at>?",
      clientId,
      redirectUri,
      challenge,
      query.get('state') ?? '',
      resource,
      JSON.stringify(scopes),
      now,
    )[0]
    if (pending !== undefined) return redirect(`${siteOrigin}/connect?oauth_request=${encodeURIComponent(pending.id)}`)
    const requestId = consentId()
    write(sql, [
      {
        query:
          "INSERT INTO agent_oauth_requests (id,client_id,redirect_uri,code_challenge,state,board_id,scopes_json,resource,status,expires_at) VALUES (?,?,?,?,?,?,?,? ,'pending',?)",
        params: [
          requestId,
          clientId,
          redirectUri,
          challenge,
          query.get('state') ?? '',
          resourceBoard(resource, origin)!,
          JSON.stringify(scopes),
          resource,
          now + 600,
        ],
      },
    ])
    return redirect(`${siteOrigin}/connect?oauth_request=${encodeURIComponent(requestId)}`)
  }
  const consent = /^\/oauth\/requests\/(oauth_[0-9a-f]+)(\/approve)?$/.exec(path)
  if (consent !== null) {
    if (owner === undefined) return failure('unauthorized', 'Sign in through the website', 401)
    const request = sql.all<{
      id: string
      client_id: string
      client_name: string
      redirect_uri: string
      code_challenge: string
      state: string | null
      board_id: string
      scopes_json: string
      resource: string
      expires_at: number
    }>(
      "SELECT r.id,r.client_id,c.name client_name,r.redirect_uri,r.code_challenge,r.state,r.board_id,r.scopes_json,r.resource,r.expires_at FROM agent_oauth_requests r JOIN agent_oauth_clients c ON c.id=r.client_id WHERE r.id=? AND r.status='pending' AND r.expires_at>? ",
      consent[1]!,
      now,
    )[0]
    if (request === undefined) return failure('invalid_request', 'This consent request expired or was already used')
    const agents = sql
      .all<{ id: string; operator: string; state: string; agent_id: string | null; permissions_json: string }>(
        'SELECT id,operator,state,agent_id,permissions_json FROM agents WHERE operator=? ORDER BY created_at',
        owner.toLowerCase(),
      )
      .map(({ permissions_json, ...agent }) => ({ ...agent, roles: agentRoles({ permissions_json }) }))
    if (method === 'GET' && consent[2] === undefined)
      return good({
        ok: true,
        result: {
          request: {
            id: request.id,
            clientId: request.client_id,
            clientName: request.client_name,
            redirectUri: request.redirect_uri,
            scopes: JSON.parse(request.scopes_json),
            resource: request.resource,
            expiresAt: request.expires_at,
          },
          agents,
          // Any client may connect before an agent exists; the operator decides at consent, not the client.
          setup: { available: true, scope: 'sidequest:setup' },
        },
      })
    if (method !== 'POST' || consent[2] === undefined)
      return failure('invalid_request', 'Use the consent approval endpoint')
    const selected = body.agentIds
    const selectedAgentId = Array.isArray(selected) && typeof selected[0] === 'string' ? selected[0] : undefined
    const approve = body.decision !== 'reject'
    if (
      approve &&
      (!Array.isArray(selected) ||
        selected.length !== 1 ||
        typeof selected[0] !== 'string' ||
        !agents.some((agent) => agent.id === selectedAgentId && agent.state === 'active'))
    )
      return failure('invalid_request', 'Select one active agent owned by this operator')
    // The connection holds what its client asked for; the agent's own roles decide within that (ADR-0021).
    const selectedScopes = consentScopes(
      Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(request.scopes_json)),
      approve ? body.maintain : undefined,
    )
    if (selectedScopes === undefined)
      return failure('invalid_request', `Tick ${MAINTAIN_SCOPE} (true or false) only for a client that asked for it`)
    const code = randomToken()
    const codeHash = await tokenHash(code)
    let consumed = false
    sql.atomic!(() => {
      const changed = sql.all<{ id: string }>(
        "UPDATE agent_oauth_requests SET status=? WHERE id=? AND status='pending' AND expires_at>? RETURNING id",
        approve ? 'approved' : 'rejected',
        request.id,
        now,
      )
      consumed = changed[0] !== undefined
      if (consumed && approve) {
        sql.run(
          'UPDATE agent_oauth_requests SET scopes_json=? WHERE id=?',
          JSON.stringify([...new Set(selectedScopes)]),
          request.id,
        )
        sql.run(
          'INSERT INTO agent_oauth_codes (hash,request_id,agent_id,expires_at) VALUES (?,?,?,?)',
          codeHash,
          request.id,
          selectedAgentId!,
          now + 120,
        )
        // A client that reconnected for this agent, or an app still holding its setup token, becomes it too.
        bindWaitingSetupConnections(sql, {
          operator: owner,
          boardId: request.board_id,
          resource: request.resource,
          agentId: selectedAgentId!,
          now,
        })
      }
    })
    if (!consumed) return failure('invalid_request', 'Consent already used')
    const target = new URL(request.redirect_uri)
    if (request.state !== null) target.searchParams.set('state', request.state)
    target.searchParams.set('iss', origin)
    if (!approve) target.searchParams.set('error', 'access_denied')
    else {
      target.searchParams.set('code', code)
    }
    return good({ ok: true, result: { redirectUrl: target.href } })
  }
  if (path === '/oauth/token' && method === 'POST') {
    const clientId = typeof body.client_id === 'string' ? body.client_id : ''
    const resource = typeof body.resource === 'string' ? body.resource : ''
    const boardId = resourceBoard(resource, origin)
    if (clientId === '' || boardId === undefined) return failure('invalid_request', 'Require client_id and resource')
    const access = randomToken()
    const refresh = randomToken()
    const accessHash = await tokenHash(access)
    const refreshHash = await tokenHash(refresh)
    let familyId: string
    let agentId: string
    let scopes: string[]
    let consumeHash: string
    let codeRequest: string | undefined
    if (body.grant_type === 'authorization_code') {
      const verifier = typeof body.code_verifier === 'string' ? body.code_verifier : ''
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return failure('invalid_grant', 'Invalid PKCE verifier')
      consumeHash = await tokenHash(typeof body.code === 'string' ? body.code : '')
      const row = sql.all<{
        request_id: string
        agent_id: string
        client_id: string
        redirect_uri: string
        code_challenge: string
        scopes_json: string
        resource: string
      }>(
        `SELECT c.request_id,c.agent_id,r.client_id,r.redirect_uri,r.code_challenge,r.scopes_json,r.resource
        FROM agent_oauth_codes c JOIN agent_oauth_requests r ON r.id=c.request_id
        WHERE c.hash=? AND c.consumed_at IS NULL AND c.expires_at>? AND r.status='approved'`,
        consumeHash,
        now,
      )[0]
      if (
        row === undefined ||
        row.client_id !== clientId ||
        row.resource !== resource ||
        row.redirect_uri !== body.redirect_uri ||
        row.code_challenge !== (await pkceChallenge(verifier))
      )
        return failure('invalid_grant', 'Code, resource, redirect or verifier does not match')
      familyId = consentId()
      agentId = row.agent_id
      scopes = JSON.parse(row.scopes_json) as string[]
      codeRequest = row.request_id
    } else if (body.grant_type === 'refresh_token') {
      consumeHash = await tokenHash(typeof body.refresh_token === 'string' ? body.refresh_token : '')
      const row = sql.all<{
        family_id: string
        client_id: string
        agent_id: string
        scopes_json: string
        resource: string
      }>(
        `SELECT f.id family_id,f.client_id,f.agent_id,f.scopes_json,f.resource
        FROM agent_oauth_tokens t JOIN agent_oauth_families f ON f.id=t.family_id
        WHERE t.hash=? AND t.kind='refresh' AND t.expires_at>? AND f.revoked_at IS NULL`,
        consumeHash,
        now,
      )[0]
      if (row === undefined || row.client_id !== clientId || row.resource !== resource)
        return failure('invalid_grant', 'Refresh token expired, revoked or bound to another resource')
      familyId = row.family_id
      agentId = row.agent_id
      scopes = JSON.parse(row.scopes_json) as string[]
    } else return failure('unsupported_grant_type', 'Supported grants: authorization_code and refresh_token')
    const issued = sql.atomic!(() => {
      if (new AgentStore(sql, () => now).get(agentId).state !== 'active') return false
      if (codeRequest !== undefined) {
        const used = sql.all<{ hash: string }>(
          'UPDATE agent_oauth_codes SET consumed_at=? WHERE hash=? AND consumed_at IS NULL AND expires_at>? RETURNING hash',
          now,
          consumeHash,
          now,
        )
        if (used[0] === undefined) return false
        sql.run(
          'INSERT INTO agent_oauth_families (id,client_id,agent_id,board_id,scopes_json,resource,created_at) VALUES (?,?,?,?,?,?,?)',
          familyId,
          clientId,
          agentId,
          boardId,
          JSON.stringify(scopes),
          resource,
          now,
        )
      } else {
        const token = sql.all<{ consumed_at: number | null }>(
          `SELECT consumed_at FROM agent_oauth_tokens WHERE hash=? AND family_id=? AND kind='refresh' AND expires_at>?`,
          consumeHash,
          familyId,
          now,
        )[0]
        const family = sql.all<{ revoked_at: number | null }>(
          'SELECT revoked_at FROM agent_oauth_families WHERE id=?',
          familyId,
        )[0]
        if (token === undefined || family === undefined || family.revoked_at !== null) return false
        if (token.consumed_at !== null) {
          sql.run('UPDATE agent_oauth_families SET revoked_at=? WHERE id=?', now, familyId)
          return false
        }
        sql.run('UPDATE agent_oauth_tokens SET consumed_at=? WHERE hash=?', now, consumeHash)
      }
      sql.run(
        "INSERT INTO agent_oauth_tokens (hash,family_id,kind,expires_at) VALUES (?,?,'access',?)",
        accessHash,
        familyId,
        now + 3600,
      )
      sql.run(
        "INSERT INTO agent_oauth_tokens (hash,family_id,kind,expires_at) VALUES (?,?,'refresh',?)",
        refreshHash,
        familyId,
        now + 30 * 86400,
      )
      return true
    })
    if (!issued) {
      if (sql.all('SELECT id FROM agent_oauth_families WHERE id=? AND revoked_at IS NOT NULL', familyId).length > 0)
        await terminateFamily(familyId)
      return failure('invalid_grant', 'Code already used, refresh replayed, or agent access stopped')
    }
    return good({
      access_token: access,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refresh,
      scope: scopes.join(' '),
      agent_id: agentId,
    })
  }
  if (path === '/oauth/revoke' && method === 'POST') {
    if (typeof body.token === 'string') {
      const hash = await tokenHash(body.token),
        clientId = String(body.client_id ?? '')
      const families = sql.all<{ id: string }>(
        'SELECT f.id FROM agent_oauth_families f JOIN agent_oauth_tokens t ON t.family_id=f.id WHERE t.hash=? AND f.client_id=?',
        hash,
        clientId,
      )
      write(sql, [
        {
          query:
            'UPDATE agent_oauth_families SET revoked_at=? WHERE id IN (SELECT family_id FROM agent_oauth_tokens WHERE hash=?) AND client_id=?',
          params: [now, hash, clientId],
        },
      ])
      for (const family of families) await terminateFamily(family.id)
    }
    return good({})
  }
  return undefined
}
