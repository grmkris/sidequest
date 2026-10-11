/** Setup families have no agent until their operator approves or connects one; every waiting family then becomes it. */
import { AgentStore, agentRoles, type Sql } from '@sidequest/board'
import { Schema } from 'effect'
import type { OAuthGrant, OAuthReply, oauthRoute } from './oauth.ts'
import {
  OAUTH_SCOPES as AGENT_SCOPES,
  pkceChallenge,
  randomToken,
  resourceBoard,
  tokenHash,
} from './oauth-validation.ts'

const headers = { 'cache-control': 'no-store' }
const failure = (description: string): OAuthReply => ({
  status: 400,
  body: { error: 'invalid_grant', error_description: description },
  headers,
})
const good = (body: object): OAuthReply => ({ status: 200, body, headers })
const scopes = (json: string) => Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(json))
const text = (value: unknown) => (Schema.is(Schema.String)(value) ? value : '')
type Input = Parameters<typeof oauthRoute>[0]

interface SetupFamily {
  id: string
  client_id: string
  operator: string
  board_id: string
  resource: string
  agent_id: string | null
  scopes_json: string
  requested_scopes_json: string
  revoked_at: number | null
}

export function resolveSetupOAuth(sql: Sql, hash: string, resource: string, now: number): OAuthGrant | undefined {
  const family = sql.all<SetupFamily>(
    `SELECT f.* FROM agent_oauth_setup_families f JOIN agent_oauth_setup_tokens t ON t.family_id=f.id
     WHERE t.hash=? AND t.kind='access' AND t.expires_at>? AND f.revoked_at IS NULL`,
    hash,
    now,
  )[0]
  if (family === undefined || family.resource !== resource) return undefined
  if (family.agent_id === null)
    return {
      setup: true,
      owner: family.operator,
      address: family.operator,
      agentIds: [],
      chainId: 0,
      registryAgentId: null,
      resource,
      clientId: family.client_id,
      scopes: ['sidequest:setup'],
      grantId: family.id,
      setupFamilyId: family.id,
      roles: [],
    }
  const agent = new AgentStore(sql, () => now).get(family.agent_id)
  if (agent.state !== 'active' || agent.address === null || agent.operator.toLowerCase() !== family.operator)
    return undefined
  return {
    owner: agent.operator,
    address: agent.address,
    agentIds: [agent.id],
    chainId: agent.chain_id,
    registryAgentId: agent.agent_id,
    resource,
    clientId: family.client_id,
    scopes: scopes(family.scopes_json),
    grantId: family.id,
    setupFamilyId: family.id,
    roles: agentRoles(agent),
  }
}

/**
 * A coding agent may reconnect, or run in an app that still holds an older token, while its operator approves the agent
 * it proposed. So every live, agentless setup connection of the operator on this board and resource becomes the agent
 * the operator approves or connects next, each with the scope its own client asked for. A connection that proposed a
 * different agent waits for that one instead.
 */
export function bindWaitingSetupConnections(
  sql: Sql,
  input: { operator: string; boardId: string; resource: string; agentId: string; now: number },
): Array<{ familyId: string; resource: string; scopes: string[] }> {
  const waiting = sql.all<{ id: string; requested_scopes_json: string }>(
    `SELECT f.id,f.requested_scopes_json FROM agent_oauth_setup_families f
     WHERE f.operator=? AND f.board_id=? AND f.resource=? AND f.agent_id IS NULL AND f.revoked_at IS NULL
     AND EXISTS (SELECT 1 FROM agent_oauth_setup_tokens t WHERE t.family_id=f.id AND t.expires_at>?
       AND (t.kind='access' OR (t.kind='refresh' AND t.consumed_at IS NULL)))
     AND NOT EXISTS (SELECT 1 FROM agent_setup_connections c WHERE c.family_id=f.id AND c.agent_key<>?)`,
    input.operator.toLowerCase(),
    input.boardId,
    input.resource,
    input.now,
    input.agentId,
  )
  return waiting.map((family) => {
    const granted = boundScopes(scopes(family.requested_scopes_json))
    sql.run(
      'UPDATE agent_oauth_setup_families SET agent_id=?,scopes_json=? WHERE id=? AND agent_id IS NULL',
      input.agentId,
      JSON.stringify(granted),
      family.id,
    )
    return { familyId: family.id, resource: input.resource, scopes: granted }
  })
}

/**
 * What a connection holds once it acts as an agent: read, plus whichever of work and hire its client asked for. The
 * client's request is only an upper bound; the agent's roles decide within it (ADR-0021).
 */
export function boundScopes(requested: readonly string[]): string[] {
  const roles = ['sidequest:hire', 'sidequest:work'].filter((scope) => requested.includes(scope))
  return ['sidequest:read', ...roles].toSorted()
}

export async function setupOAuthRoute(input: Input): Promise<OAuthReply | undefined> {
  if (input.method !== 'POST') return undefined
  if (input.path === '/oauth/revoke') {
    await revoke(input)
    return undefined // The agent-family revocation still runs too.
  }
  if (input.path === '/oauth/token') return token(input)
  const match = /^\/oauth\/requests\/(oauth_[0-9a-f]+)\/approve$/.exec(input.path)
  if (match === null || input.body.setup !== true || input.body.decision === 'reject') return undefined
  return approve(input, match[1]!)
}

async function approve(input: Input, requestId: string): Promise<OAuthReply> {
  const { sql, owner, body, now, origin } = input
  if (owner === undefined)
    return { status: 401, body: { error: 'unauthorized', error_description: 'Sign in through the website' }, headers }
  const request = sql.all<{ scopes_json: string; redirect_uri: string; state: string | null }>(
    "SELECT scopes_json,redirect_uri,state FROM agent_oauth_requests WHERE id=? AND status='pending' AND expires_at>?",
    requestId,
    now,
  )[0]
  if (request === undefined) return failure('Consent expired or already used')
  // Any client may connect for setup. Its requested roles are kept only to pre-tick the approval page; the operator
  // chooses the roles there, so a role choice sent with this consent is ignored.
  const requested = scopes(request.scopes_json)
  if (
    body.agentIds !== undefined &&
    (!Schema.is(Schema.Array(Schema.String))(body.agentIds) || body.agentIds.length !== 0)
  )
    return failure('Setup consent cannot select an agent')
  if (
    body.scopes !== undefined &&
    (!Schema.is(Schema.Array(Schema.String))(body.scopes) ||
      !body.scopes.every((scope) => scope === 'sidequest:setup' || AGENT_SCOPES.some((known) => known === scope)))
  )
    return failure('Unknown scope in the setup consent')
  const selected = ['sidequest:setup', ...requested]
  const code = randomToken()
  const hash = await tokenHash(code)
  const approved = sql.atomic!(() => {
    const changed = sql.all<{ id: string }>(
      "UPDATE agent_oauth_requests SET status='approved' WHERE id=? AND status='pending' AND expires_at>? RETURNING id",
      requestId,
      now,
    )[0]
    if (changed === undefined) return false
    sql.run(
      'INSERT INTO agent_oauth_setup_codes (hash,request_id,operator,requested_scopes_json,expires_at) VALUES (?,?,?,?,?)',
      hash,
      requestId,
      owner.toLowerCase(),
      JSON.stringify([...new Set(selected)]),
      now + 120,
    )
    return true
  })
  if (!approved) return failure('Consent already used')
  const target = new URL(request.redirect_uri)
  if (request.state !== null) target.searchParams.set('state', request.state)
  target.searchParams.set('iss', origin)
  target.searchParams.set('code', code)
  return good({ ok: true, result: { redirectUrl: target.href } })
}

interface SetupCode {
  hash: string
  request_id: string
  operator: string
  requested_scopes_json: string
  expires_at: number
  consumed_at: number | null
  client_id: string
  redirect_uri: string
  code_challenge: string
  resource: string
  board_id: string
}

async function token(input: Input): Promise<OAuthReply | undefined> {
  const { sql, body, now, origin } = input
  if (body.grant_type === 'authorization_code') {
    const hash = await tokenHash(text(body.code))
    const code = sql.all<SetupCode>(
      `SELECT c.*,r.client_id,r.redirect_uri,r.code_challenge,r.resource,r.board_id FROM agent_oauth_setup_codes c
       JOIN agent_oauth_requests r ON r.id=c.request_id WHERE c.hash=? AND r.status='approved'`,
      hash,
    )[0]
    if (code === undefined) return undefined
    const verifier = text(body.code_verifier)
    if (
      code.expires_at <= now ||
      code.consumed_at !== null ||
      code.client_id !== body.client_id ||
      code.resource !== body.resource ||
      code.redirect_uri !== body.redirect_uri ||
      resourceBoard(code.resource, origin) !== code.board_id ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
      code.code_challenge !== (await pkceChallenge(verifier))
    )
      return failure('Code, resource, redirect or verifier does not match')
    return issue(input, `oauth_${randomToken().slice(0, 40)}`, hash, code)
  }
  if (body.grant_type !== 'refresh_token') return undefined
  const hash = await tokenHash(text(body.refresh_token))
  const family = sql.all<SetupFamily & { consumed_at: number | null; expires_at: number }>(
    `SELECT f.*,t.consumed_at,t.expires_at FROM agent_oauth_setup_tokens t
     JOIN agent_oauth_setup_families f ON f.id=t.family_id WHERE t.hash=? AND t.kind='refresh'`,
    hash,
  )[0]
  if (family === undefined) return undefined
  if (
    family.client_id !== body.client_id ||
    family.resource !== body.resource ||
    family.expires_at <= now ||
    family.revoked_at !== null ||
    resourceBoard(family.resource, origin) !== family.board_id
  )
    return failure('Refresh token expired, revoked or bound to another resource')
  if (family.agent_id !== null && new AgentStore(sql, () => now).get(family.agent_id).state !== 'active')
    return failure('Agent access stopped')
  return issue(input, family.id, hash)
}

async function issue(input: Input, familyId: string, hash: string, code?: SetupCode): Promise<OAuthReply> {
  const { sql, now } = input
  const access = randomToken(),
    refresh = randomToken()
  const accessHash = await tokenHash(access),
    refreshHash = await tokenHash(refresh)
  const issued = sql.atomic!(() => {
    if (code !== undefined) {
      const used = sql.all<{ hash: string }>(
        'UPDATE agent_oauth_setup_codes SET consumed_at=? WHERE hash=? AND consumed_at IS NULL AND expires_at>? RETURNING hash',
        now,
        hash,
        now,
      )[0]
      if (used === undefined) return false
      sql.run(
        `INSERT INTO agent_oauth_setup_families (id,client_id,operator,board_id,scopes_json,requested_scopes_json,resource,created_at)
        VALUES (?,?,?,?,?,?,?,?)`,
        familyId,
        code.client_id,
        code.operator,
        code.board_id,
        '["sidequest:setup"]',
        code.requested_scopes_json,
        code.resource,
        now,
      )
    } else {
      const row = sql.all<{ consumed_at: number | null; revoked_at: number | null }>(
        `SELECT t.consumed_at,f.revoked_at FROM agent_oauth_setup_tokens t JOIN agent_oauth_setup_families f ON f.id=t.family_id
         WHERE t.hash=? AND t.family_id=? AND t.kind='refresh' AND t.expires_at>?`,
        hash,
        familyId,
        now,
      )[0]
      if (row === undefined || row.revoked_at !== null) return false
      if (row.consumed_at !== null) {
        sql.run('UPDATE agent_oauth_setup_families SET revoked_at=? WHERE id=?', now, familyId)
        return false
      }
      sql.run('UPDATE agent_oauth_setup_tokens SET consumed_at=? WHERE hash=?', now, hash)
    }
    sql.run(
      "INSERT INTO agent_oauth_setup_tokens (hash,family_id,kind,expires_at) VALUES (?,?,'access',?)",
      accessHash,
      familyId,
      now + 3600,
    )
    sql.run(
      "INSERT INTO agent_oauth_setup_tokens (hash,family_id,kind,expires_at) VALUES (?,?,'refresh',?)",
      refreshHash,
      familyId,
      now + 30 * 86400,
    )
    return true
  })
  if (!issued) {
    await terminate(input, familyId)
    return failure('Code already used or refresh replayed')
  }
  const family = sql.all<SetupFamily>('SELECT * FROM agent_oauth_setup_families WHERE id=?', familyId)[0]!
  return good({
    access_token: access,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: refresh,
    scope: scopes(family.scopes_json).join(' '),
    ...(family.agent_id === null ? { setup: true } : { agent_id: family.agent_id }),
  })
}

async function terminate(input: Input, familyId: string): Promise<void> {
  const row = input.sql.all<{ address: string }>(
    'SELECT a.address FROM agents a JOIN agent_oauth_setup_families f ON f.agent_id=a.id WHERE f.id=?',
    familyId,
  )[0]
  if (row !== undefined) await input.revokeSubscriptions?.(row.address, familyId, input.now)
}

async function revoke(input: Input): Promise<void> {
  if (!Schema.is(Schema.String)(input.body.token)) return
  const hash = await tokenHash(input.body.token)
  const families = input.sql.all<{ id: string }>(
    'SELECT f.id FROM agent_oauth_setup_families f JOIN agent_oauth_setup_tokens t ON t.family_id=f.id WHERE t.hash=? AND f.client_id=?',
    hash,
    text(input.body.client_id),
  )
  for (const family of families) {
    input.sql.run('UPDATE agent_oauth_setup_families SET revoked_at=? WHERE id=?', input.now, family.id)
    await terminate(input, family.id)
  }
}
