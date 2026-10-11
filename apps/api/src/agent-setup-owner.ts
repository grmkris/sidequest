/** Owner-only identity proof and approval; a setup bearer can never approve itself. */
import { AgentStore, BoardError, type Sql } from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import { Schema } from 'effect'
import type { Address } from 'viem'
import { privyOperator } from './privy-operator.ts'
import type { AgentRouteRequest } from './routes/agents.ts'
import { profileOrigin } from './profiles.ts'
import { resourceBoard } from './oauth-validation.ts'
import { bindWaitingSetupConnections, boundScopes } from './oauth-setup.ts'

const strings = Schema.decodeUnknownSync(Schema.Array(Schema.String))
const Roles = Schema.Array(Schema.Literals(['sidequest:work', 'sidequest:hire'])).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2),
)
const Approval = Schema.Struct({ scopes: Roles })
const binding = (bindings: Record<string, unknown>, key: string) =>
  Schema.decodeUnknownSync(Schema.String)(bindings[key] ?? '')

export function bindSetupOperator(sql: Sql, operator: Address, userId: string, now: number): void {
  const previous = sql.all<{ privy_user_id: string }>(
    'SELECT privy_user_id FROM agent_setup_operators WHERE operator=?',
    operator.toLowerCase(),
  )[0]
  if (previous !== undefined && previous.privy_user_id !== userId)
    throw new BoardError('conflict', 'The verified operator identity cannot change')
  sql.run(
    `INSERT INTO agent_setup_operators (operator,privy_user_id,verified_at) VALUES (?,?,?)
    ON CONFLICT(operator) DO UPDATE SET verified_at=excluded.verified_at`,
    operator.toLowerCase(),
    userId,
    now,
  )
}

export async function ownerAgentSetup(input: {
  request: AgentRouteRequest
  sql: Sql
  context: sdk.Ctx
  operator: Address
  privyToken?: string
  bindings: Record<string, unknown>
  now: () => number
}) {
  if (input.request.action === 'approve')
    return approveAgentSetup({
      ...input,
      id: input.request.id ?? '',
      body: input.request.body,
      origin: profileOrigin(binding(input.bindings, 'PUBLIC_ORIGIN')),
    })
  if (input.privyToken === undefined) throw new BoardError('unauthenticated', 'A current Privy session is required')
  const userId = await privyOperator({
    token: input.privyToken,
    appId: binding(input.bindings, 'PRIVY_APP_ID'),
    appSecret: binding(input.bindings, 'PRIVY_APP_SECRET'),
    operator: input.operator,
    now: input.now(),
  })
  if (userId === undefined)
    throw new BoardError('forbidden', 'The Privy user does not own this embedded operator wallet')
  bindSetupOperator(input.sql, input.operator, userId, input.now())
  return { operator: input.operator, verified: true }
}

interface Candidate {
  id: string
  board_id: string
  resource: string
  agent_id: string | null
  scopes_json: string
  requested_scopes_json: string
}

export async function approveAgentSetup(input: {
  sql: Sql
  context: sdk.Ctx
  now: () => number
  operator: Address
  id: string
  origin: string
  body: Record<string, unknown>
}) {
  const { sql, context, operator, id, now, origin } = input
  let approved: readonly string[]
  try {
    approved = [...new Set(Schema.decodeUnknownSync(Approval, { onExcessProperty: 'error' })(input.body).scopes)]
  } catch {
    throw new BoardError('invalid', 'Approve one or both role scopes: sidequest:work, sidequest:hire')
  }
  const agent = new AgentStore(sql, now).owned(id, operator)
  if (
    agent.state !== 'active' ||
    agent.agent_id === null ||
    agent.address === null ||
    agent.chain_id !== context.deployment.chainId ||
    agent.registry.toLowerCase() !== context.deployment.identity.toLowerCase()
  )
    throw new BoardError('conflict', 'Register and bind this agent before approving the connection')
  const [owner, wallet] = await Promise.all([
    context.publicClient.readContract({
      address: agent.registry,
      abi: sdk.identityAbi,
      functionName: 'ownerOf',
      args: [BigInt(agent.agent_id)],
    }),
    sdk.agentWallet(context, BigInt(agent.agent_id)),
  ])
  if (owner.toLowerCase() !== operator.toLowerCase() || wallet.toLowerCase() !== agent.address.toLowerCase())
    throw new BoardError('conflict', 'Current registry ownership or wallet binding differs from this agent')
  const candidates = sql.all<Candidate>(
    `SELECT f.* FROM agent_oauth_setup_families f JOIN agent_setup_connections c ON c.family_id=f.id
     WHERE c.agent_key=? AND f.operator=? AND f.board_id=c.board_id AND f.resource=c.resource AND f.revoked_at IS NULL
     AND EXISTS (SELECT 1 FROM agent_oauth_setup_tokens t WHERE t.family_id=f.id AND t.expires_at>?
       AND (t.kind='access' OR (t.kind='refresh' AND t.consumed_at IS NULL)))`,
    id,
    operator.toLowerCase(),
    now(),
  )
  const result = candidates.map((family) => approvalBinding(family, id, origin))
  const places = sql.all<{ board_id: string; resource: string }>(
    'SELECT DISTINCT board_id,resource FROM agent_setup_connections WHERE agent_key=?',
    id,
  )
  if (sql.atomic === undefined) throw new BoardError('unavailable', 'Approval requires atomic storage')
  const waiting = sql.atomic(() => {
    // The ticks are the agent's roles; every connection keeps the scope its client asked for (ADR-0021).
    new AgentStore(sql, now).setRoles(
      id,
      approved.map((scope) => (scope === 'sidequest:work' ? 'work' : 'hire')),
    )
    for (const entry of result)
      sql.run(
        'UPDATE agent_oauth_setup_families SET agent_id=?,scopes_json=? WHERE id=? AND revoked_at IS NULL',
        id,
        JSON.stringify(entry.scopes),
        entry.familyId,
      )
    // The proposing connection may have been replaced by a reconnect: the operator's other waiting ones join it.
    return places
      .filter((place) => resourceBoard(place.resource, origin) === place.board_id)
      .flatMap((place) =>
        bindWaitingSetupConnections(sql, {
          operator,
          boardId: place.board_id,
          resource: place.resource,
          agentId: id,
          now: now(),
        }),
      )
  })
  return { agentKey: id, agentId: agent.agent_id, state: 'ready', connections: [...result, ...waiting] }
}

/** A connection the agent proposed becomes it with its client's own scope; one already bound elsewhere is a conflict. */
function approvalBinding(family: Candidate, id: string, origin: string) {
  if (resourceBoard(family.resource, origin) !== family.board_id)
    throw new BoardError('forbidden', 'Approval cannot change the connection resource')
  if (family.agent_id !== null && family.agent_id !== id)
    throw new BoardError('conflict', 'This connection already approved another agent')
  return {
    familyId: family.id,
    resource: family.resource,
    scopes: boundScopes(strings(JSON.parse(family.requested_scopes_json))),
  }
}
