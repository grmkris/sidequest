/** The operator's controls over a hosted agent's access: its roles, and the clients connected as it (ADR-0021). */
import { AGENT_ROLES, AgentStore, BoardError, type Sql } from '@sidequest/board'
import { fromD1 } from '@sidequest/indexer'
import { Schema } from 'effect'
import type { Address } from 'viem'
import type { AgentRouteRequest } from './routes/agents.ts'
import { terminateGrantSubscriptions } from './webhooks.ts'

const Roles = Schema.Struct({ roles: Schema.Array(Schema.Literals(AGENT_ROLES)).check(Schema.isMaxLength(2)) })
const strings = Schema.decodeUnknownSync(Schema.Array(Schema.String))

export interface AgentConnection {
  readonly id: string
  readonly client: string
  readonly resource: string
  /** The roles this client asked for: the most it can do, whatever the agent's roles allow. */
  readonly scopes: readonly string[]
  readonly createdAt: number
  readonly lastUsedAt: number | null
}

/** A live family has an unexpired access token or an unused refresh token. */
const LIVE = `EXISTS (SELECT 1 FROM %TOKENS% t WHERE t.family_id=f.id AND t.expires_at>?
  AND (t.kind='access' OR (t.kind='refresh' AND t.consumed_at IS NULL)))`

/** The clients acting as this agent now: direct connections and setup connections it was approved through. */
export function agentConnections(sql: Sql, agentId: string, now: number): AgentConnection[] {
  const select = (families: string, tokens: string) =>
    sql.all<{
      id: string
      name: string
      resource: string
      scopes_json: string
      created_at: number
      last_used_at: number | null
    }>(
      `SELECT f.id,c.name,f.resource,f.scopes_json,f.created_at,a.last_used_at FROM ${families} f
       JOIN agent_oauth_clients c ON c.id=f.client_id LEFT JOIN agent_oauth_activity a ON a.family_id=f.id
       WHERE f.agent_id=? AND f.revoked_at IS NULL AND ${LIVE.replace('%TOKENS%', tokens)}`,
      agentId,
      now,
    )
  return [
    ...select('agent_oauth_families', 'agent_oauth_tokens'),
    ...select('agent_oauth_setup_families', 'agent_oauth_setup_tokens'),
  ]
    .map((row) => ({
      id: row.id,
      client: row.name,
      resource: row.resource,
      scopes: strings(JSON.parse(row.scopes_json)),
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    }))
    .toSorted((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt))
}

/** Ends one connection: its tokens stop at once and its event subscriptions are terminated. */
export function disconnectAgent(sql: Sql, agentId: string, familyId: string, now: number): boolean {
  if (sql.atomic === undefined) throw new BoardError('unavailable', 'Disconnecting requires atomic storage')
  return sql.atomic(
    () =>
      ['agent_oauth_families', 'agent_oauth_setup_families']
        .map(
          (table) =>
            sql.all<{ id: string }>(
              `UPDATE ${table} SET revoked_at=? WHERE id=? AND agent_id=? AND revoked_at IS NULL RETURNING id`,
              now,
              familyId,
              agentId,
            ).length,
        )
        .reduce((a, b) => a + b, 0) > 0,
  )
}

export async function agentAccess(input: {
  readonly request: AgentRouteRequest
  readonly sql: Sql
  readonly operator: Address
  readonly bindings: Record<string, unknown>
  readonly now: () => number
}) {
  const { request, sql, operator, bindings, now } = input
  const agents = new AgentStore(sql, now)
  const agent = agents.owned(request.id ?? '', operator)
  if (request.action === 'roles') {
    let roles: readonly (typeof AGENT_ROLES)[number][]
    try {
      roles = Schema.decodeUnknownSync(Roles, { onExcessProperty: 'error' })(request.body).roles
    } catch {
      throw new BoardError('invalid', 'Send the roles to keep: work, hire, both or none')
    }
    return { roles: agents.setRoles(agent.id, roles) }
  }
  if (request.action === 'connections') return { connections: agentConnections(sql, agent.id, now()) }
  const familyId = Schema.is(Schema.String)(request.body.familyId) ? request.body.familyId : ''
  if (!disconnectAgent(sql, agent.id, familyId, now()))
    throw new BoardError('not-found', 'No live connection with this id acts as this agent')
  if (bindings.Database !== undefined && agent.address !== null)
    // SAFETY: Database is this Worker's D1 binding whenever it is present.
    await terminateGrantSubscriptions(fromD1(bindings.Database as never), agent.address, familyId, now())
  return { connections: agentConnections(sql, agent.id, now()) }
}
