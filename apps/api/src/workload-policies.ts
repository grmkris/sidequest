import { AgentStore, BoardError, type Sql } from '@sidequest/board'
import { Option, Schema } from 'effect'
import { OidcPolicySchema, validateOidcPolicy } from '@sidequest/sdk/oidc-policy'
import type { Address } from 'viem'
import { randomToken, resourceBoard } from './oauth-validation.ts'
import { migrateWorkloadSchema, workloadOidcEnabled } from './workload-schema.ts'

const WORKLOAD_SCOPES = ['sidequest:read', 'sidequest:work', 'sidequest:hire'] as const
export const WORKLOAD_EXTENSION = 'io.modelcontextprotocol/oauth-client-credentials'
export const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
const Strings = Schema.decodeUnknownSync(Schema.Array(Schema.String))

export interface WorkloadPolicyRow {
  id: string
  agent_id: string
  policy_json: string
  scopes_json: string
  resource: string
  enabled: number
  deleted_at: number | null
}

export function workloadPolicyView(row: WorkloadPolicyRow) {
  return {
    id: row.id,
    policy: OidcPolicySchema.parse(JSON.parse(row.policy_json)),
    scopes: Strings(JSON.parse(row.scopes_json)),
    resource: row.resource,
    enabled: row.enabled === 1,
  }
}

const Create = Schema.Struct({
  resource: Schema.String,
  scopes: Schema.Array(Schema.Literals(WORKLOAD_SCOPES)),
  policy: Schema.Unknown,
})
const Change = Schema.Struct({ id: Schema.String, decision: Schema.Literals(['disable', 'delete']) })

function createPolicy(sql: Sql, agentId: string, body: Record<string, unknown>, origin: string, now: number) {
  const decoded = Schema.decodeUnknownOption(Create, { onExcessProperty: 'error' })(body)
  if (Option.isNone(decoded)) throw new BoardError('invalid', 'Require policy, MCP resource and explicit scopes')
  const input = decoded.value
  const errors = validateOidcPolicy(input.policy)
  if (errors.length > 0)
    throw new BoardError('invalid', errors.map((error) => `${error.path}: ${error.message}`).join('; '))
  const policy = OidcPolicySchema.parse(input.policy)
  if (!Object.hasOwn(policy.claims, 'sub')) throw new BoardError('invalid', 'Pin an exact subject (sub) rule')
  if (resourceBoard(input.resource, origin) === undefined || !input.scopes.includes('sidequest:read'))
    throw new BoardError('invalid', 'Require a same-origin MCP resource and sidequest:read')
  const live = sql.all('SELECT id FROM agent_workload_policies WHERE agent_id=? AND deleted_at IS NULL', agentId)
  if (live.length >= 20) throw new BoardError('invalid', 'At most 20 policies per agent')
  const id = `wlp_${randomToken().slice(0, 40)}`
  sql.run(
    `INSERT INTO agent_workload_policies (id,agent_id,policy_json,scopes_json,resource,created_at)
    VALUES (?,?,?,?,?,?)`,
    id,
    agentId,
    JSON.stringify(policy),
    JSON.stringify([...new Set(input.scopes)]),
    input.resource,
    now,
  )
}

/** Called only after the management object's operator session check; the bearer issued to a workload cannot call it. */
export function manageWorkloadPolicies(input: {
  sql: Sql
  agentId: string
  operator: Address
  action: string
  body: Record<string, unknown>
  bindings: Record<string, unknown>
  now: number
}) {
  const { sql, operator, agentId, action, bindings, now, body } = input
  const agent = new AgentStore(sql, () => now).owned(agentId, operator)
  migrateWorkloadSchema(sql)
  const enabled = workloadOidcEnabled(bindings)
  if (action !== 'workload-policies' && !enabled) throw new BoardError('unavailable', 'Workload OIDC is disabled')
  if (action === 'workload-policy-add') {
    if (agent.state !== 'active') throw new BoardError('forbidden', 'Agent is not active')
    const origin = Schema.decodeUnknownSync(Schema.String)(bindings.PUBLIC_ORIGIN)
    createPolicy(sql, agent.id, body, new URL(origin).origin, now)
  }
  if (action === 'workload-policy-change') {
    const change = Schema.decodeUnknownOption(Change, { onExcessProperty: 'error' })(body)
    if (Option.isNone(change)) throw new BoardError('invalid', 'Require policy id and disable or delete decision')
    const changed = sql.all(
      `UPDATE agent_workload_policies SET enabled=0,deleted_at=?
      WHERE id=? AND agent_id=? AND deleted_at IS NULL RETURNING id`,
      change.value.decision === 'delete' ? now : null,
      change.value.id,
      agent.id,
    )
    if (changed.length === 0) throw new BoardError('not-found', 'Policy not found for this agent')
    // Existing families stay revoked even if a future version adds re-enable or policy editing.
    sql.run(
      `UPDATE agent_oauth_families SET revoked_at=? WHERE id IN
      (SELECT family_id FROM agent_workload_connections WHERE policy_id=?)`,
      now,
      change.value.id,
    )
  }
  return {
    enabled,
    policies: sql
      .all<WorkloadPolicyRow>(
        'SELECT * FROM agent_workload_policies WHERE agent_id=? AND deleted_at IS NULL ORDER BY created_at,id',
        agent.id,
      )
      .map(workloadPolicyView),
  }
}
