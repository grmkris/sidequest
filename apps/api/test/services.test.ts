import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { fromNodeSqlite, migrate, stmt } from '@sidequest/indexer'
import { deployment, type DirectoryAgent } from '@sidequest/sdk'
import { zeroAddress } from 'viem'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { Schema } from 'effect'
import { directoryTools, migrateDirectory, projectDirectory, runDirectoryTool } from '../src/directory.ts'
import { rankServices, servicesPage, servicesRoute, type ServiceListing } from '../src/services.ts'
import { networkTool, permittedTool, requiredToolScope, toolAnnotations } from '../src/mcp-policy.ts'
import { agentFirstMcpRoute } from '../src/mcp-agent-setup.ts'
import type { OAuthGrant } from '../src/oauth.ts'

const config = deployment('monad-testnet')
const now = 1_800_000_000
const audience = 'https://api.test.invalid'
const exploreOrigin = 'https://explore.test.invalid'
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function listing(patch: Partial<ServiceListing> = {}): ServiceListing {
  return {
    agentId: '2',
    agentName: 'Quill',
    agentImage: null,
    wallet: zeroAddress,
    serviceId: 'review',
    name: 'Code review',
    description: 'Careful security research',
    inputs: 'Repository link',
    outputs: 'Written report',
    turnaroundSeconds: 3600,
    price: { model: 'quote', amountBaseUnits: '0', token: zeroAddress },
    adHash: '0x01',
    expiresAt: now + 100,
    presence: { freshness: 'unknown', state: null, accepting: false, lastSeenBucket: null },
    lastMcpCallAt: null,
    delivered: 0,
    delivered7d: 0,
    serviceUrl: `${exploreOrigin}/services/2/review`,
    invite: { tool: 'request_quotes', args: { invite: { agentId: '2' } } },
    ...patch,
  }
}

function agent(id: string, patch: Partial<DirectoryAgent> = {}): DirectoryAgent {
  const service = listing()
  return {
    chainId: config.chainId,
    identityRegistry: config.identity,
    agentId: id,
    wallet: zeroAddress,
    profile: { name: 'Quill', description: '', services: [] },
    profileSource: 'operator-supplied',
    agentURI: '',
    enrolled: true,
    ownership: 'verified',
    presence: service.presence,
    ads: [
      {
        serviceId: service.serviceId,
        name: service.name,
        description: service.description,
        inputs: service.inputs,
        outputs: service.outputs,
        turnaroundSeconds: service.turnaroundSeconds,
        price: service.price,
        adHash: '0x01',
        expiresAt: service.expiresAt,
      },
    ],
    observedAt: now,
    projectionAt: now,
    revision: 1,
    ...patch,
  }
}

async function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  await migrate(sql)
  await migrateDirectory(sql)
  const deps = { sql, network: 'monad-testnet' as const, audience, exploreOrigin }
  const enroll = (value: DirectoryAgent, scope = audience) => projectDirectory(sql, value, scope)
  return { db, sql, deps, enroll }
}

it('ranks live presence and recent MCP before delivery and keeps the input untouched', () => {
  const offline = listing({ agentId: '1', delivered7d: 100, delivered: 1000 })
  const heartbeat = listing({ agentId: '3', presence: { ...offline.presence, freshness: 'fresh', accepting: true } })
  const mcp = listing({ agentId: '2', lastMcpCallAt: now - 3600 })
  const input = [offline, heartbeat, mcp]
  expect(rankServices(input, now)).toEqual([mcp, heartbeat, offline])
  expect(input).toEqual([offline, heartbeat, mcp])
})

it('requires accepting fresh presence or an MCP call within the hour', () => {
  const active = listing({ agentId: '9', lastMcpCallAt: now - 3599 })
  const stale = listing({ agentId: '1', presence: { ...active.presence, freshness: 'stale', accepting: true } })
  const busy = listing({ agentId: '2', presence: { ...active.presence, freshness: 'fresh', accepting: false } })
  const old = listing({ agentId: '3', lastMcpCallAt: now - 3601 })
  expect(rankServices([stale, busy, old, active], now)).toEqual([active, stale, busy, old])
})

it.each([
  [{ delivered7d: 2 }, { delivered7d: 1, delivered: 100 }],
  [{ delivered: 2 }, { delivered: 1, expiresAt: now + 1000 }],
  [{ expiresAt: now + 1000 }, { expiresAt: now + 100 }],
  [{ agentId: '2' }, { agentId: '10' }],
  [{ agentId: '9007199254740992' }, { agentId: '9007199254740993' }],
  [{ serviceId: 'a-review' }, { serviceId: 'b-review' }],
])('orders delivery, ad recency and exact identifiers: %j before %j', (first, second) => {
  const a = listing(first),
    b = listing(second)
  expect(rankServices([b, a], now)).toEqual([a, b])
})

it('flattens only live ads from named verified enrollments in this deployment and audience', async () => {
  const f = await fixture()
  const live = agent('2')
  await f.enroll({
    ...live,
    ads: [
      ...live.ads,
      { ...live.ads[0]!, serviceId: 'expired', expiresAt: now },
      { ...live.ads[0]!, serviceId: 'old', expiresAt: now - 1 },
    ],
  })
  await f.enroll(agent('3', { ownership: 'unknown' }))
  await f.enroll(agent('4', { ownership: 'changed' }))
  await f.enroll(agent('5', { profile: { name: '  ', description: '', services: [] } }))
  await f.enroll(agent('6', { enrolled: false }))
  await f.enroll(agent('7'), 'https://other.invalid')
  await f.enroll(agent('8', { chainId: 1 }))
  await f.enroll(agent('9', { identityRegistry: zeroAddress }))
  const page = await servicesPage(f.deps, {}, now)
  expect(page.services).toHaveLength(1)
  expect(page.services[0]).toMatchObject({
    agentId: '2',
    agentName: 'Quill',
    agentImage: null,
    delivered: 0,
    delivered7d: 0,
    serviceUrl: `${exploreOrigin}/services/2/review`,
    invite: { tool: 'request_quotes', args: { invite: { agentId: '2' } } },
  })
  expect(page).toMatchObject({
    observedAt: now,
    chainId: config.chainId,
    identityRegistry: config.identity,
    nextCursor: null,
  })
})

it.each(['CoDE', 'SeCURity', 'REPOSITORY', 'REPORT', 'quILL', '  quill\tcode\nreport '])(
  'matches every case-insensitive query term across the service and agent: %s',
  async (q) => {
    const f = await fixture()
    await f.enroll(agent('2'))
    expect((await servicesPage(f.deps, { q }, now)).services).toHaveLength(1)
    expect((await servicesPage(f.deps, { q: `${q} missing` }, now)).services).toEqual([])
  },
)

it('filters one agent and preserves a projected image', async () => {
  const f = await fixture()
  const profile = { name: 'Quill', description: '', services: [], image: `${exploreOrigin}/avatar.png` }
  await f.enroll(agent('2', { profile }))
  await f.enroll(agent('3'))
  const page = await servicesPage(f.deps, { agentId: '2', q: ' ' }, now)
  expect(page.services.map((value) => value.agentId)).toEqual(['2'])
  expect(page.services[0]?.agentImage).toBe(profile.image)
})

it('pages after filtering and ranking, with defaults and a final null cursor', async () => {
  const f = await fixture()
  for (let id = 1; id <= 27; id++) await f.enroll(agent(String(id)))
  const first = await servicesPage(f.deps, {}, now)
  expect(first.services).toHaveLength(24)
  expect(first.nextCursor).toEqual(expect.any(String))
  const second = await servicesPage(f.deps, { cursor: first.nextCursor! }, now)
  expect(second.services.map((value) => value.agentId)).toEqual(['25', '26', '27'])
  expect(second.nextCursor).toBeNull()
  expect(
    (await servicesPage(f.deps, { cursor: second.nextCursor ?? first.nextCursor!, limit: 100 }, now)).services,
  ).toHaveLength(3)
})

it('reads projections once, batches wallet-bound MCP activity and adds real indexed delivery counts', async () => {
  const f = await fixture()
  await f.enroll(agent('2'))
  await f.enroll(agent('3'))
  await f.sql.batch([
    stmt(
      "INSERT INTO jobs (chain_id, job_id, agent_id, status, kind, updated_block) VALUES (?, '1', '2', 'completed', 'sidequest-v1', 100)",
      config.chainId,
    ),
    stmt("INSERT INTO events VALUES (?, 'fixture', 100, 0, 'fixture', '1', 'JobCompleted', '{}')", config.chainId),
    stmt('INSERT INTO block_times VALUES (?, 100, ?)', config.chainId, now - 7 * 24 * 3600),
  ])
  const all = vi.spyOn(f.sql, 'all')
  const activity = vi.fn(async () => [
    { agent_id: '2', address: zeroAddress, last_activity_at: now + 299 },
    { agent_id: '3', address: config.identity, last_activity_at: now },
  ])
  const page = await servicesPage({ ...f.deps, activity }, {}, now)
  expect(activity).toHaveBeenCalledExactlyOnceWith(['2', '3'])
  expect(all.mock.calls.filter(([query]) => query.includes('FROM directory_agents'))).toHaveLength(1)
  expect(page.services[0]).toMatchObject({ agentId: '2', lastMcpCallAt: now, delivered: 1, delivered7d: 1 })
  expect(page.services[1]?.lastMcpCallAt).toBeNull()
})

it('continues service discovery when the hosted activity batch is unavailable', async () => {
  const f = await fixture()
  await f.enroll(agent('2'))
  const activity = vi.fn(async () => {
    throw new Error('management unavailable')
  })
  expect((await servicesPage({ ...f.deps, activity }, {}, now)).services[0]?.lastMcpCallAt).toBeNull()
})

it.each(['/data/services', '/b/team-board/data/services'])('serves the cached public envelope at %s', async (path) => {
  const f = await fixture()
  await f.enroll(agent('2'))
  const response = HttpServerResponse.toWeb(
    await servicesRoute(f.deps, new URL(path, audience), now, {
      'access-control-allow-origin': exploreOrigin,
    }),
  )
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('public, max-age=30')
  expect(response.headers.get('access-control-allow-origin')).toBe(exploreOrigin)
  expect(await response.json()).toMatchObject({
    ok: true,
    services: [{ agentId: '2' }],
    nextCursor: null,
    observedAt: now,
  })
})

it.each([
  'limit=0',
  'limit=101',
  'limit=1.5',
  'limit=no',
  'limit=',
  'cursor=',
  'cursor=bad',
  'agentId=bad',
  'agentId=',
  `q=${'a'.repeat(201)}`,
])('returns the directory-style invalid error envelope for %s', async (query) => {
  const f = await fixture()
  const response = HttpServerResponse.toWeb(
    await servicesRoute(f.deps, new URL(`/data/services?${query}`, audience), now, {}),
  )
  expect(response.status).toBe(400)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual({ ok: false, code: 'invalid', message: expect.any(String) })
})

it('allows setup and read grants with read-only annotations on both networks', () => {
  expect(permittedTool({ scopes: ['sidequest:setup'], setup: true }, 'find_services')).toBe(true)
  expect(permittedTool({ scopes: ['sidequest:read'] }, 'find_services')).toBe(true)
  expect(permittedTool({ scopes: [] }, 'find_services')).toBe(false)
  expect(requiredToolScope('find_services')).toBe('sidequest:read')
  expect(toolAnnotations('find_services')).toEqual({
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  })
  expect(networkTool('monad-mainnet', 'find_services')).toBe(true)
})

it('executes find_services without an agent DO and rejects MCP limits above 50 or unknown inputs', async () => {
  const f = await fixture()
  await f.enroll(
    agent('2', { ads: agent('2').ads.map((ad) => ({ ...ad, expiresAt: Math.floor(Date.now() / 1000) + 100 })) }),
  )
  const call = vi.fn(async () => {
    throw new Error('must not read agent DO')
  })
  const deps = { ...f.deps, rpcUrl: '', call }
  expect(await runDirectoryTool(deps, 'find_services', {})).toMatchObject({ services: [{ agentId: '2' }] })
  expect(call).not.toHaveBeenCalled()
  for (const input of [{ limit: 51 }, { limit: '2' }, { q: 42 }, { extra: true }])
    await expect(runDirectoryTool(deps, 'find_services', input)).rejects.toMatchObject({ code: 'invalid' })
})

it('advertises and calls find_services over setup MCP before an agent is created', async () => {
  const f = await fixture()
  const grant: OAuthGrant = {
    owner: 'operator',
    address: zeroAddress,
    chainId: config.chainId,
    clientId: 'fixture',
    resource: `${audience}/mcp`,
    agentIds: [],
    registryAgentId: '',
    scopes: ['sidequest:setup'],
    setup: true,
  }
  const call = vi.fn(async () => ({ ok: true, result: await servicesPage(f.deps, {}, now) }))
  const route = (method: string, params = {}) =>
    agentFirstMcpRoute({
      method: 'POST',
      pathname: '/mcp',
      origin: audience,
      headers: {},
      grant,
      tools: directoryTools,
      body: { jsonrpc: '2.0', id: 1, method, params },
      call,
    })
  const listed = Schema.decodeUnknownSync(
    Schema.Struct({ result: Schema.Struct({ tools: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) }) }),
  )((await route('tools/list')).body)
  expect(listed.result.tools.find((tool) => tool.name === 'find_services')).toMatchObject({
    name: 'find_services',
    inputSchema: directoryTools.find_services.inputSchema,
    securitySchemes: directoryTools.find_services.securitySchemes,
  })
  expect((await route('tools/call', { name: 'find_services', arguments: {} })).status).toBe(200)
  expect(call).toHaveBeenCalledExactlyOnceWith('find_services', {}, '')
})
