import { afterEach, expect, it, vi } from 'vitest'
import { Schema } from 'effect'
import * as sdk from '@sidequest/sdk'
import { getAddress } from 'viem'
import { AgentSetup } from '../src/agent-setup.ts'
import { AgentProfileUpdates } from '../src/agent-profiles.ts'
import { approveAgentSetup, bindSetupOperator } from '../src/agent-setup-owner.ts'
import { resolveOAuth } from '../src/oauth.ts'
import { permittedTool, toolAnnotations } from '../src/mcp-policy.ts'
import { agentFirstMcpRoute } from '../src/mcp-agent-setup.ts'
import { agentTools } from '../src/tools-agents.ts'
import { agentRoute } from '../src/routes/agents.ts'
import { setupFixture, origin, operator, outsider, resource } from './setup-oauth-fixture.ts'

const fixtures: ReturnType<typeof setupFixture>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.db.close()
})
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const args = {
  name: 'Quill',
  description: 'Careful code reviews',
  avatarPrompt: 'a friendly fox',
  operationKey: 'quill-setup',
}
const wallet = getAddress(`0x${'44'.repeat(20)}`)

async function fixture(verified = true) {
  const f = setupFixture()
  fixtures.push(f)
  const connection = await f.connection()
  const grant = (await resolveOAuth(f.sql, connection.tokens.access_token, resource, f.now()))!
  if (verified) bindSetupOperator(f.sql, operator, 'did:privy:owner', f.now())
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const readContract = vi.fn(async (input: { functionName: string }) =>
    input.functionName === 'ownerOf' ? operator : wallet,
  )
  // SAFETY: unit-only owner/wallet reads are the sole chain methods used by approval.
  const context = { ...base, publicClient: { ...base.publicClient, readContract } } as sdk.Ctx
  const generate = vi.fn(async () => ({ bytes: png, type: 'image/png' as const }))
  const bucket = { put: vi.fn(async () => null), get: vi.fn(async () => null) }
  const profiles = new AgentProfileUpdates({
    sql: f.sql,
    now: f.now,
    origin,
    boardId: 'team-board',
    model: { generate },
    bucket,
    directory: () => undefined,
  })
  const onboard = vi.fn(async (input: { id: string }) => {
    f.agents.bindWallet(input.id, `wallet-${input.id}`, wallet)
    for (const state of ['upgraded', 'grants-live'] as const) f.agents.advance(input.id, state)
    return f.agents.get(input.id)
  })
  const boot = () => new AgentSetup({ sql: f.sql, context, now: f.now, origin, onboard, profiles })
  const registered = (id: string) => {
    f.agents.bindRegistry(id, '41')
    f.agents.advance(id, 'registered')
    f.agents.advance(id, 'active')
  }
  const approve = (id: string, scopes = ['sidequest:work'], owner = operator) =>
    approveAgentSetup({ sql: f.sql, context, now: f.now, operator: owner, id, origin, body: { scopes } })
  return {
    ...f,
    newConnection: f.connection,
    connection,
    grant,
    context,
    readContract,
    generate,
    onboard,
    boot,
    registered,
    approve,
  }
}

it('answers setup whoami, creates its managed wallet/profile/avatar once, and returns one approval link', async () => {
  const f = await fixture()
  expect(f.boot().whoami(f.grant)).toEqual({ setup: true, operator: operator.toLowerCase(), agents: [] })
  const first = await f.boot().create(f.grant, args)
  expect(first).toMatchObject({
    agentKey: expect.stringMatching(/^setup_/),
    approveUrl: `${origin}/agents/approve/${first.agentKey}?roles=work`,
    profile: { name: 'Quill', description: 'Careful code reviews', image: expect.stringContaining('/avatars/') },
  })
  expect(await f.boot().create(f.grant, args)).toEqual(first)
  expect(f.onboard).toHaveBeenCalledTimes(1)
  expect(f.generate).toHaveBeenCalledTimes(1)
  expect(f.boot().status(f.grant, { agentKey: first.agentKey })).toMatchObject({ state: 'awaiting-approval' })
  expect(f.boot().whoami(f.grant).agents).toEqual([
    { agentKey: first.agentKey, agentId: null, name: 'Quill', state: 'grants-live' },
  ])
})

it('refuses caller-supplied ownership, missing Privy proof, changed operation arguments and a second creation key', async () => {
  const missing = await fixture(false)
  await expect(missing.boot().create(missing.grant, args)).rejects.toMatchObject({ code: 'conflict' })
  expect(missing.onboard).not.toHaveBeenCalled()
  const f = await fixture(),
    created = await f.boot().create(f.grant, args)
  await expect(f.boot().create(f.grant, { ...args, operator: outsider })).rejects.toMatchObject({ code: 'invalid' })
  await expect(f.boot().create(f.grant, { ...args, description: 'Different purpose' })).rejects.toMatchObject({
    code: 'conflict',
  })
  await expect(f.boot().create(f.grant, { ...args, operationKey: 'another-key' })).rejects.toMatchObject({
    code: 'conflict',
  })
  expect(f.agents.list(operator).map((agent) => agent.id)).toEqual([created.agentKey])
  expect(f.onboard).toHaveBeenCalledTimes(1)
})

it('replays the frozen creation result after an owner renames the pending agent', async () => {
  const f = await fixture(),
    created = await f.boot().create(f.grant, args)
  f.agents.rename(created.agentKey, 'Quill reviewed')
  expect(await f.boot().create(f.grant, args)).toEqual(created)
  expect(f.agents.get(created.agentKey).name).toBe('Quill reviewed')
  expect(f.onboard).toHaveBeenCalledTimes(1)
  expect(f.generate).toHaveBeenCalledTimes(1)
})

it('recovers an interrupted provider call under the same creation identity and stores only a fixed message', async () => {
  const f = await fixture()
  f.onboard.mockRejectedValueOnce(new Error('provider request details'))
  await expect(f.boot().create(f.grant, args)).rejects.toThrow('provider request details')
  const id = f.agents.list(operator)[0]!.id
  expect(f.boot().status(f.grant, { agentKey: id })).toMatchObject({
    state: 'failed',
    message: expect.stringContaining('original operationKey'),
  })
  expect(JSON.stringify(f.sql.all('SELECT * FROM agent_operation_steps'))).not.toContain('provider request details')
  expect((await f.boot().create(f.grant, args)).agentKey).toBe(id)
  expect(f.boot().status(f.grant, { agentKey: id })).toMatchObject({ state: 'awaiting-approval' })
})

it("the same bearer becomes the approved agent with its client's scope; approving again only changes roles", async () => {
  const f = await fixture(),
    created = await f.boot().create(f.grant, args)
  await expect(f.approve(created.agentKey)).rejects.toMatchObject({ code: 'conflict' })
  f.registered(created.agentKey)
  const other = await f.newConnection()
  await f.approve(created.agentKey)
  const bound = (await resolveOAuth(f.sql, f.connection.tokens.access_token, resource, f.now()))!
  expect(bound).toMatchObject({
    agentIds: [created.agentKey],
    scopes: ['sidequest:read', 'sidequest:work'],
    address: wallet.toLowerCase(),
    registryAgentId: '41',
  })
  expect(bound.setup).not.toBe(true)
  // The operator's other connection still waiting in setup becomes the approved agent too.
  expect((await resolveOAuth(f.sql, other.tokens.access_token, resource, f.now()))?.agentIds).toEqual([
    created.agentKey,
  ])
  expect(f.boot().status(bound, { agentKey: created.agentKey })).toMatchObject({
    state: 'ready',
    agentId: '41',
    message: expect.stringContaining('whoami'),
  })
  expect(permittedTool(bound, 'apply')).toBe(true)
  expect(permittedTool(bound, 'create_task')).toBe(false)
  expect(permittedTool(bound, 'create_agent')).toBe(false)
  // The ticks are the agent's roles: approving again changes them and leaves the connection's scope alone.
  expect(await f.approve(created.agentKey, ['sidequest:hire'])).toMatchObject({ state: 'ready' })
  expect(f.agents.roles(created.agentKey)).toEqual(['hire'])
  expect((await resolveOAuth(f.sql, f.connection.tokens.access_token, resource, f.now()))?.scopes).toEqual([
    'sidequest:read',
    'sidequest:work',
  ])
})

it("approval sets the agent's roles, while each connection keeps the scope its client asked for", async () => {
  const f = await fixture(),
    created = await f.boot().create(f.grant, args)
  f.registered(created.agentKey)
  await f.approve(created.agentKey, ['sidequest:work', 'sidequest:hire'])
  expect(f.agents.roles(created.agentKey)).toEqual(['work', 'hire'])
  expect((await resolveOAuth(f.sql, f.connection.tokens.access_token, resource, f.now()))?.scopes).toEqual([
    'sidequest:read',
    'sidequest:work',
  ])
})

// Jonas, 11 Oct: his coding agent reconnected while Lizandro waited for approval and never became Lizandro.
it('a reconnect waiting in setup follows and becomes the approved agent; one proposing another agent keeps waiting', async () => {
  const f = await fixture(),
    created = await f.boot().create(f.grant, args)
  const grantOf = async (tokens: { access_token: string }) =>
    (await resolveOAuth(f.sql, tokens.access_token, resource, f.now()))!
  const reconnect = await f.newConnection()
  expect(f.boot().status(await grantOf(reconnect.tokens), { agentKey: created.agentKey })).toMatchObject({
    state: 'awaiting-approval',
  })
  // A connection that proposed a different agent (the fixture gives every created agent the same wallet).
  const proposer = await f.newConnection()
  f.sql.run(
    'INSERT INTO agent_setup_connections (agent_key,family_id,board_id,resource,created_at) VALUES (?,?,?,?,?)',
    'setup_second',
    (await grantOf(proposer.tokens)).setupFamilyId ?? '',
    'team-board',
    resource,
    f.now(),
  )
  f.registered(created.agentKey)
  const approved = await f.approve(created.agentKey)
  expect(approved.connections).toHaveLength(2)
  const bound = await grantOf(reconnect.tokens)
  expect(bound.agentIds).toEqual([created.agentKey])
  expect(f.boot().status(bound, { agentKey: created.agentKey })).toMatchObject({ state: 'ready' })
  expect((await grantOf(proposer.tokens)).setup).toBe(true)
})

it('approval refuses a foreign owner or a changed live wallet, and ignores revoked and expired connections', async () => {
  const f = await fixture(),
    created = await f.boot().create(f.grant, args)
  f.registered(created.agentKey)
  await expect(f.approve(created.agentKey, ['sidequest:work'], outsider)).rejects.toThrow('another operator')
  f.readContract.mockResolvedValue(outsider)
  await expect(f.approve(created.agentKey)).rejects.toMatchObject({ code: 'conflict' })
  f.readContract.mockImplementation(async (input) => (input.functionName === 'ownerOf' ? operator : wallet))
  await f.route('/oauth/revoke', { token: f.connection.tokens.access_token, client_id: f.connection.clientId })
  expect((await f.approve(created.agentKey)).connections).toEqual([])
  expect(await resolveOAuth(f.sql, f.connection.tokens.access_token, resource, f.now())).toBeUndefined()
})

it('does not expose other agents or scopes through setup status and stops bound tokens when the agent is revoked', async () => {
  const f = await fixture(),
    created = await f.boot().create(f.grant, args)
  expect(() => f.boot().status(f.grant, { agentKey: 'someone-else' })).toThrow('belongs to this operator')
  for (const tool of ['apply', 'create_task', 'update_profile', 'inbox', 'settlement_actions'])
    expect(permittedTool(f.grant, tool)).toBe(false)
  expect(toolAnnotations('create_agent')).toMatchObject({ readOnlyHint: false, idempotentHint: true })
  expect(toolAnnotations('setup_status')).toMatchObject({ readOnlyHint: true, idempotentHint: true })
  f.registered(created.agentKey)
  await f.approve(created.agentKey)
  f.agents.advance(created.agentKey, 'revoked')
  expect(await resolveOAuth(f.sql, f.connection.tokens.access_token, resource, f.now())).toBeUndefined()
  expect(
    (
      await f.route('/oauth/token', {
        grant_type: 'refresh_token',
        client_id: f.connection.clientId,
        resource,
        refresh_token: f.connection.tokens.refresh_token,
      })
    )?.status,
  ).toBe(400)
})

// Clients cache tools/list, so a setup chat lists the agent's tools up front and can use them once approved.
it('MCP setup tools work without an agent selector; future tools are listed up front and wait for approval', async () => {
  const f = await fixture(),
    created = await f.boot().create(f.grant, args)
  const call = vi.fn(async () => ({ ok: true, result: f.boot().whoami(f.grant) }))
  const route = (grant: typeof f.grant, method: string, params: Record<string, unknown> = {}) =>
    agentFirstMcpRoute({
      method: 'POST',
      pathname: '/b/team-board/mcp',
      origin,
      headers: {},
      grant,
      tools: { ...agentTools, whoami: {}, apply: {}, create_task: {} },
      body: { jsonrpc: '2.0', id: 1, method, params },
      call,
    })
  const List = Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          inputSchema: Schema.Struct({ required: Schema.optionalKey(Schema.Array(Schema.String)) }),
        }),
      ),
    }),
  })
  const listed = Schema.decodeUnknownSync(List)((await route(f.grant, 'tools/list')).body).result.tools
  expect(listed.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(['create_agent', 'setup_status', 'whoami', 'apply', 'create_task']),
  )
  const Call = Schema.Struct({
    result: Schema.Struct({
      isError: Schema.optionalKey(Schema.Boolean),
      content: Schema.Array(Schema.Struct({ text: Schema.String })),
      _meta: Schema.optionalKey(Schema.Unknown),
    }),
  })
  const early = Schema.decodeUnknownSync(Call)((await route(f.grant, 'tools/call', { name: 'apply' })).body).result
  expect(early).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('setup_status') }] })
  // A wait, never insufficient_scope: that would send the client to sign in again.
  expect(early._meta).toBeUndefined()
  expect(call).not.toHaveBeenCalledWith('apply', expect.anything(), expect.anything())
  expect(listed.find((tool) => tool.name === 'create_agent')?.inputSchema.required).toEqual(['name', 'operationKey'])
  expect(listed.find((tool) => tool.name === 'setup_status')?.inputSchema.required).toEqual(['agentKey'])
  const whoami = async (grant: typeof f.grant) =>
    Schema.decodeUnknownSync(
      Schema.Struct({ result: Schema.Struct({ structuredContent: Schema.Struct({ result: Schema.Unknown }) }) }),
    )((await route(grant, 'tools/call', { name: 'whoami' })).body).result.structuredContent.result
  expect(await whoami(f.grant)).toMatchObject({ setup: true, roles: [] })
  expect(call).toHaveBeenCalledWith('whoami', {}, '')
  f.registered(created.agentKey)
  await f.approve(created.agentKey)
  const bound = (await resolveOAuth(f.sql, f.connection.tokens.access_token, resource, f.now()))!
  expect(await whoami(bound)).toMatchObject({ roles: ['work'] })
  const names = Schema.decodeUnknownSync(List)((await route(bound, 'tools/list')).body).result.tools.map(
    (tool) => tool.name,
  )
  expect(names).toContain('apply')
  expect(names).toContain('setup_status')
  expect(names).not.toContain('create_agent')
  expect(names).not.toContain('create_task')
  expect(f.boot().status(bound, { agentKey: created.agentKey })).toMatchObject({
    state: 'ready',
    message: expect.stringContaining('tools now work'),
  })
})

it('keeps approved scopes on refresh and leaves expired setup families unbound', async () => {
  const f = await fixture(),
    created = await f.boot().create(f.grant, args)
  f.registered(created.agentKey)
  await f.approve(created.agentKey)
  const refreshed = await f.route('/oauth/token', {
    grant_type: 'refresh_token',
    client_id: f.connection.clientId,
    resource,
    refresh_token: f.connection.tokens.refresh_token,
  })
  const tokens = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String, scope: Schema.String }))(
    refreshed?.body,
  )
  expect(tokens.scope).toBe('sidequest:read sidequest:work')
  expect(await resolveOAuth(f.sql, tokens.access_token, resource, f.now())).toMatchObject({
    agentIds: [created.agentKey],
    setupFamilyId: f.grant.setupFamilyId,
  })
  expect(await resolveOAuth(f.sql, tokens.access_token, `${origin}/mcp`, f.now())).toBeUndefined()
  const expired = await fixture(),
    abandoned = await expired.boot().create(expired.grant, args)
  expired.registered(abandoned.agentKey)
  expired.clock(expired.now() + 30 * 86400)
  expect((await expired.approve(abandoned.agentKey)).connections).toEqual([])
  expect(
    expired.sql.all<{ agent_id: string | null }>('SELECT agent_id FROM agent_oauth_setup_families')[0]?.agent_id,
  ).toBeNull()
})

it('routes Privy ownership confirmation and approval through the owner management path', () => {
  expect(agentRoute('POST', '/api/agents/setup-identity', {})).toEqual({ action: 'setup-identity', body: {} })
  expect(agentRoute('POST', '/api/agents/quill/approve', { scopes: ['sidequest:work'] })).toMatchObject({
    action: 'approve',
    id: 'quill',
  })
  expect(agentRoute('GET', '/api/agents/quill/approve', {})).toBeUndefined()
})
