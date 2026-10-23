import { AgentStore, agentRoles, type Sql } from '@sidequest/board'
import { Schema } from 'effect'
import type { OAuthReply } from './oauth.ts'
import { randomToken, resourceBoard, tokenHash } from './oauth-validation.ts'
import { verifyOidcToken } from './oidc-verify.ts'
import { migrateWorkloadSchema } from './workload-schema.ts'
import { workloadPolicyView, type WorkloadPolicyRow } from './workload-policies.ts'

const noStore = { 'cache-control': 'no-store', pragma: 'no-cache' }
const fail = (error: string, description: string): OAuthReply => ({
  status: 400,
  body: { error, error_description: description },
  headers: noStore,
})
const string = Schema.is(Schema.String)
const WORKLOAD_ACCESS_TTL = 300

function cappedScopes(sql: Sql, row: WorkloadPolicyRow, requested: unknown): string[] | undefined {
  const agent = new AgentStore(sql, () => 0).get(row.agent_id)
  if (agent.state !== 'active') return undefined
  const roles = agentRoles(agent)
  const cap = workloadPolicyView(row).scopes.filter(
    (scope) => scope === 'sidequest:read' || roles.some((role) => scope === `sidequest:${role}`),
  )
  const scopes =
    requested === undefined ? cap : string(requested) ? [...new Set(requested.split(' ').filter(Boolean))] : []
  return scopes.length > 0 && scopes.every((scope) => cap.includes(scope)) ? scopes : undefined
}

function persistFamily(input: {
  sql: Sql
  row: WorkloadPolicyRow
  familyId: string
  hash: string
  allowed: string[]
  now: number
  origin: string
  label: string
}) {
  const { sql, row, familyId, hash, allowed, now, origin, label } = input
  sql.run(
    `INSERT OR IGNORE INTO agent_oauth_clients (id,name,redirect_uris_json,created_at) VALUES (?,?,'[]',?)`,
    row.id,
    label,
    now,
  )
  sql.run(
    `INSERT INTO agent_oauth_families (id,client_id,agent_id,board_id,scopes_json,resource,created_at)
      VALUES (?,?,?,?,?,?,?)`,
    familyId,
    row.id,
    row.agent_id,
    resourceBoard(row.resource, origin)!,
    JSON.stringify(allowed),
    row.resource,
    now,
  )
  sql.run('INSERT INTO agent_workload_connections (family_id,policy_id) VALUES (?,?)', familyId, row.id)
  sql.run(
    `INSERT INTO agent_oauth_tokens (hash,family_id,kind,expires_at) VALUES (?,?,'access',?)`,
    hash,
    familyId,
    now + WORKLOAD_ACCESS_TTL,
  )
}

/** RFC 7523 §2.1: a platform-issued assertion is the grant, never a client secret or a refresh credential. */
export async function workloadToken(input: {
  sql: Sql
  body: Record<string, unknown>
  origin: string
  now: number
  enabled: boolean
  fetch?: typeof fetch
}): Promise<OAuthReply> {
  const { sql, body, origin, now } = input
  if (!input.enabled) return fail('unsupported_grant_type', 'Workload OIDC is disabled')
  if (!string(body.client_id) || !string(body.resource) || resourceBoard(body.resource, origin) === undefined)
    return fail('invalid_request', 'Require the policy id as client_id and its exact MCP resource')
  migrateWorkloadSchema(sql)
  const row = sql.all<WorkloadPolicyRow>(
    'SELECT * FROM agent_workload_policies WHERE id=? AND resource=? AND enabled=1 AND deleted_at IS NULL',
    body.client_id,
    body.resource,
  )[0]
  if (row === undefined) return fail('invalid_grant', 'No active trust policy for this client and resource')
  let saved: ReturnType<typeof workloadPolicyView>
  try {
    saved = workloadPolicyView(row)
  } catch {
    return fail('invalid_grant', 'invalid-policy')
  }
  const verified = await verifyOidcToken(string(body.assertion) ? body.assertion : undefined, [saved.policy], {
    now,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  })
  if (!verified.ok) return fail('invalid_grant', verified.code)
  const access = randomToken()
  const hash = await tokenHash(access)
  const replay = await tokenHash(JSON.stringify([verified.claims.iss, verified.claims.jti]))
  const familyId = `oauth_${randomToken().slice(0, 40)}`
  if (sql.atomic === undefined) throw new Error('Workload OAuth requires atomic storage')
  const scopes = sql.atomic(() => {
    // Verification awaits network I/O. Recheck the exact policy and current agent roles before issuing anything.
    const current = sql.all<WorkloadPolicyRow>(
      'SELECT * FROM agent_workload_policies WHERE id=? AND enabled=1 AND deleted_at IS NULL',
      row.id,
    )[0]
    if (current === undefined || JSON.stringify(workloadPolicyView(current)) !== JSON.stringify(saved)) return undefined
    const allowed = cappedScopes(sql, current, body.scope)
    if (allowed === undefined) return undefined
    sql.run('DELETE FROM agent_workload_assertions WHERE expires_at<=?', now)
    const used = sql.all(
      `INSERT OR IGNORE INTO agent_workload_assertions (hash,expires_at) VALUES (?,?) RETURNING hash`,
      replay,
      verified.claims.exp,
    )
    if (used.length === 0) return undefined
    persistFamily({
      sql,
      row,
      familyId,
      hash,
      allowed,
      now,
      origin,
      label: `Workload: ${saved.policy.label ?? row.id}`,
    })
    return allowed
  })
  if (scopes === undefined) return fail('invalid_grant', 'Assertion replayed, scope exceeds grant, or access stopped')
  return {
    status: 200,
    headers: noStore,
    body: {
      access_token: access,
      token_type: 'Bearer',
      expires_in: WORKLOAD_ACCESS_TTL,
      scope: scopes.join(' '),
      agent_id: row.agent_id,
    },
  }
}
