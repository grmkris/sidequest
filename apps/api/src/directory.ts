import { DirectoryError, directoryAgentId, validateDirectoryProfile } from '@sidequest/board'
import { type AsyncSql, stmt } from '@sidequest/indexer'
import {
  type DirectoryAgent,
  type DirectoryEnvelope,
  type DirectoryKind,
  type Network,
  deployment,
  prepareDirectoryIdentity,
} from '@sidequest/sdk'
import type { DirectoryCall } from './directory-object.ts'
import { enforceDirectoryIp } from './admission-rate.ts'

export const DIRECTORY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS directory_agents (
    chain_id INTEGER NOT NULL,
    registry TEXT NOT NULL,
    agent_key TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    audience TEXT NOT NULL,
    enrolled INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    projection_at INTEGER NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY (chain_id, registry, audience, agent_key)
  )`,
] as const

export const migrateDirectory = (sql: AsyncSql) => sql.batch(DIRECTORY_SCHEMA.map((query) => stmt(query)))

export async function projectDirectory(sql: AsyncSql, agent: DirectoryAgent, audience: string): Promise<void> {
  await sql.batch([
    stmt(
      `INSERT INTO directory_agents (chain_id, registry, agent_key, agent_id, audience, enrolled, revision, projection_at, json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (chain_id, registry, audience, agent_key) DO UPDATE SET enrolled = excluded.enrolled, revision = excluded.revision,
       projection_at = excluded.projection_at, json = excluded.json WHERE excluded.revision >= directory_agents.revision`,
      agent.chainId,
      agent.identityRegistry.toLowerCase(),
      agent.agentId.padStart(78, '0'),
      agent.agentId,
      audience,
      Number(agent.enrolled),
      agent.revision,
      agent.projectionAt,
      JSON.stringify(agent),
    ),
  ])
}

export async function directoryPage(
  sql: AsyncSql,
  input: { network: Network; audience: string; after?: string; limit?: number },
) {
  const config = deployment(input.network)
  const limit = input.limit ?? 24
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new DirectoryError('invalid', 'limit must be an integer from 1 to 100')
  const after = input.after === undefined ? '' : directoryAgentId(input.after).padStart(78, '0')
  const rows = await sql.all<{ json: string }>(
    'SELECT json FROM directory_agents WHERE chain_id = ? AND registry = ? AND audience = ? AND enrolled = 1 AND agent_key > ? ORDER BY agent_key LIMIT ?',
    config.chainId,
    config.identity.toLowerCase(),
    input.audience,
    after,
    limit + 1,
  )
  const agents = rows.slice(0, limit).map((row) => JSON.parse(row.json) as DirectoryAgent)
  return { agents, nextCursor: rows.length > limit ? (agents.at(-1)?.agentId ?? null) : null }
}

const properties = {
  agentId: { type: 'string', description: 'Positive decimal ERC-8004 ID in this deployment registry.' },
}
const schema = (required: string[], more: Record<string, unknown> = {}) => ({
  type: 'object',
  properties: { ...properties, ...more },
  required,
  additionalProperties: false,
})
const preparation = (description: string) => ({
  description,
  inputSchema: schema(['agentId', 'payload'], { payload: { type: 'object' }, expiresAt: { type: 'integer' } }),
})
const submission = (description: string) => ({
  description,
  inputSchema: schema(['record', 'signature'], { record: { type: 'object' }, signature: { type: 'string' } }),
})

export const directoryTools = {
  list_directory: {
    description:
      'List opted-in ERC-8004 workers, including zero-job identities. presence.accepting comes only from a signed heartbeat, which hosted agents never send: read activity.lastMcpCallAt for them. Any listed worker can be asked for a quote; neither is job admission or funding. Paginate with nextCursor.',
    inputSchema: {
      type: 'object',
      properties: { after: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
  },
  get_directory_agent: {
    description:
      'Read one opted-in worker and its current signed service advertisements. No job or settlement changes.',
    inputSchema: schema(['agentId']),
  },
  find_services: {
    description:
      'Find live service advertisements, ranked by recent activity and delivery. Each result includes an invite showing how to ask that agent for a quote with request_quotes. Ads are discovery only: they grant no job admission or payment.',
    securitySchemes: [
      { type: 'oauth2', scopes: ['sidequest:read'] },
      { type: 'oauth2', scopes: ['sidequest:setup'] },
    ],
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', maxLength: 200 },
        agentId: { type: 'string', pattern: '^\\d+$' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        cursor: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  prepare_agent_profile: {
    description:
      'Prepare inline ERC-8004 profile JSON and unsigned register calldata. The operator sends it from their wallet, reconciles the mint, then imports the confirmed agent ID. This tool never signs or sends a transaction.',
    inputSchema: {
      type: 'object',
      properties: { profile: { type: 'object' } },
      required: ['profile'],
      additionalProperties: false,
    },
  },
  prepare_directory_enrollment: preparation(
    'Prepare an enrollment/opt-out signed by the current on-chain agent wallet. payload: profile {name,description,services}, delegate address (zero for manual), adDelegate boolean, grantExpiresAt (0 or <=24 hours), enrolled boolean. Re-enrollment revokes all prior grants, beats, and ads.',
  ),
  enroll_directory: submission(
    'Verify and commit the prepared Enrollment wallet signature. Opt-in does not admit an agent to any job or grant money authority.',
  ),
  prepare_heartbeat: preparation(
    'Prepare a presence-only Heartbeat. payload: state available|busy|idle|draining, capacity 0..100, sessionId, capabilitiesHash bytes32, endpointHash bytes32. Sign locally with the delegate; refresh every 20 seconds, TTL <=60 seconds.',
  ),
  post_heartbeat: submission(
    'Verify the prepared Heartbeat delegate or current-wallet signature. Six beats/minute plus burst two. Never changes admission, job state, settlement, or ad terms.',
  ),
  prepare_service_ad: preparation(
    'Prepare a signed ServiceAd that stays listed until withdrawn when signed by the agent wallet; delegate listings remain bounded by their grant. payload: serviceId slug, name, description, inputs, outputs, turnaroundSeconds, price {model fixed|per-unit|quote|free/testnet, amountBaseUnits decimal string, token address}; optional category, tags, examples and samples {url, caption, kind, jobId?}. Samples must use this directory origin and /samples/<64 lowercase SHA-256 hex>.(png|jpg|webp); jobId is required only for delivery. Price is discovery only; ordinary jobs still need funded positive rewards.',
  ),
  publish_service_ad: submission(
    'Verify a SidequestServiceAd signature and publish the off-chain service listing; at most 10 live services per identity. Wallet-signed listings last until withdrawn; delegate-signed listings expire within their grant. Does not change portable identity or payment authority.',
  ),
  prepare_revoke_service_ad: preparation(
    'Prepare a RevokeAd signature for payload {serviceId}. Revocation retains a replay tombstone.',
  ),
  revoke_service_ad: submission(
    'Verify and revoke a service advertisement without deleting replay history or touching jobs.',
  ),
} as const

const PREPARE: Record<string, DirectoryKind> = {
  prepare_directory_enrollment: 'Enrollment',
  prepare_heartbeat: 'Heartbeat',
  prepare_service_ad: 'ServiceAd',
  prepare_revoke_service_ad: 'RevokeAd',
}
const SUBMIT: Record<string, DirectoryKind> = {
  enroll_directory: 'Enrollment',
  post_heartbeat: 'Heartbeat',
  publish_service_ad: 'ServiceAd',
  revoke_service_ad: 'RevokeAd',
}

export const directoryMutationTool = (tool: string): boolean =>
  Object.hasOwn(PREPARE, tool) || Object.hasOwn(SUBMIT, tool)

/** Preserve the admission reply across the directory RPC boundary. */
export class DirectoryCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message)
  }
}

export interface DirectoryApiDeps {
  sql: AsyncSql
  network: Network
  rpcUrl: string
  audience: string
  call: (
    agentId: string,
    request: DirectoryCall,
  ) => Promise<{ ok: true; result: unknown } | { ok: false; code: string; message: string; retryAfter?: number }>
  /** Hosted agents' last MCP calls, from the management object. */
  activity?: (agentIds: string[]) => Promise<Array<{ agent_id: string; address: string; last_activity_at: number }>>
}

/** Edge preflight for anonymous REST and public MCP. Authentication is the signed record checked by the object. */
export async function runDirectoryEdgeTool(
  deps: DirectoryApiDeps,
  edge: { bindings: Record<string, unknown>; ip?: string },
  tool: string,
  args: Record<string, unknown>,
): Promise<
  | { ok: true; result: Awaited<ReturnType<typeof runDirectoryTool>> }
  | { ok: false; code: string; message: string; retryAfter?: number }
> {
  if (directoryMutationTool(tool) || tool === 'prepare_agent_profile') {
    const rate = await enforceDirectoryIp(edge.bindings, {
      network: deps.network,
      tool,
      ...(edge.ip === undefined ? {} : { ip: edge.ip }),
    })
    if (!rate.ok) return rate
  }
  return { ok: true, result: await runDirectoryTool(deps, tool, args) }
}

const ACTIVITY_BUCKET = 300

/** Adds a hosted agent's last MCP call, to five minutes. Only the hosted wallet that is still the agent's wallet counts; a failed read adds nothing. */
export async function withActivity(
  deps: Pick<DirectoryApiDeps, 'activity'>,
  agents: DirectoryAgent[],
): Promise<DirectoryAgent[]> {
  if (deps.activity === undefined || agents.length === 0) return agents
  const rows = await deps.activity(agents.map((agent) => agent.agentId)).catch(() => [])
  const latest = new Map(rows.map((row) => [row.agent_id, row]))
  return agents.map((agent) => {
    const row = latest.get(agent.agentId)
    if (row === undefined || row.address.toLowerCase() !== agent.wallet.toLowerCase()) return agent
    return {
      ...agent,
      activity: { lastMcpCallAt: Math.floor(row.last_activity_at / ACTIVITY_BUCKET) * ACTIVITY_BUCKET },
    }
  })
}

export async function runDirectoryTool(
  deps: DirectoryApiDeps,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (tool === 'prepare_agent_profile')
    return {
      ...prepareDirectoryIdentity(deployment(deps.network).identity, validateDirectoryProfile(args.profile)),
      chainId: deployment(deps.network).chainId,
    }
  const call = async (id: string, action: DirectoryCall['action'], more: Partial<DirectoryCall> = {}) => {
    const reply = await deps.call(id, {
      network: deps.network,
      rpcUrl: deps.rpcUrl,
      audience: deps.audience,
      agentId: id,
      action,
      ...more,
    })
    if (!reply.ok) throw new DirectoryCallError(reply.code, reply.message, reply.retryAfter)
    return reply.result
  }
  if (tool === 'list_directory') {
    const page = await directoryPage(deps.sql, {
      network: deps.network,
      audience: deps.audience,
      ...(args.after === undefined ? {} : { after: String(args.after) }),
      ...(args.limit === undefined ? {} : { limit: Number(args.limit) }),
    })
    const agents = await Promise.all(
      page.agents.map(async (projection) => {
        try {
          return (await call(projection.agentId, 'read')) as DirectoryAgent
        } catch {
          return {
            ...projection,
            enrolled: false,
            ownership: 'unknown' as const,
            presence: { ...projection.presence, freshness: 'unknown' as const, accepting: false },
            ads: [],
            observedAt: Math.floor(Date.now() / 1000),
          }
        }
      }),
    )
    return {
      agents: await withActivity(
        deps,
        agents.filter((agent) => agent.enrolled),
      ),
      nextCursor: page.nextCursor,
      observedAt: Math.floor(Date.now() / 1000),
      chainId: deployment(deps.network).chainId,
      identityRegistry: deployment(deps.network).identity,
      scope: 'opted-in Sidequest directory',
    }
  }
  if (tool === 'get_directory_agent') {
    const agent = (await call(directoryAgentId(args.agentId), 'read')) as DirectoryAgent
    if (!agent.enrolled) throw new DirectoryError('not-found', 'agent is not enrolled in this directory')
    return { agent: (await withActivity(deps, [agent]))[0] }
  }
  if (tool === 'find_services') {
    const { servicesPage, parseServicesInput } = await import('./services.ts')
    return servicesPage(deps, parseServicesInput(args, 50), Math.floor(Date.now() / 1000))
  }
  const kind = PREPARE[tool]
  if (kind !== undefined) {
    return call(directoryAgentId(args.agentId), 'prepare', {
      kind,
      payload: args.payload,
      ...(args.expiresAt === undefined ? {} : { expiresAt: Number(args.expiresAt) }),
    })
  }
  const expectedKind = SUBMIT[tool]
  if (expectedKind !== undefined) {
    const record = args.record as DirectoryEnvelope | undefined
    if (record?.kind !== expectedKind) throw new DirectoryError('invalid', `this tool requires ${expectedKind}`)
    const result = (await call(directoryAgentId(record.agentId), 'submit', { record, signature: args.signature })) as {
      agent: DirectoryAgent
      projection: DirectoryAgent | null
      idempotent: boolean
    }
    if (result.projection !== null) await projectDirectory(deps.sql, result.projection, deps.audience)
    return { agent: result.agent, idempotent: result.idempotent, scope: 'directory only; no job or money authority' }
  }
  throw new DirectoryError('not-found', 'unknown directory tool')
}
