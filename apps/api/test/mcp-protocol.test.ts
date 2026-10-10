import { DatabaseSync } from 'node:sqlite'
import { fromNodeSqlite } from '@sidequest/indexer'
import { describe, expect, it, vi } from 'vitest'
import { mcpRoute, MODERN_LANE } from '../src/mcp.ts'
import { McpEvents } from '../src/mcp-events.ts'
import { tools as boardTools } from '../src/tools.ts'
import { agentTools } from '../src/tools-agents.ts'
import { directoryTools } from '../src/directory.ts'
import { tenantTools } from '../src/tools-tenant.ts'
import { feedTools } from '../src/feed.ts'
const registry = { ...boardTools, ...agentTools, ...directoryTools, ...tenantTools, ...feedTools }
import { requiredToolScope, toolAnnotations } from '../src/mcp-policy.ts'
import { connectorInstructions } from '../src/mcp-instructions.ts'
import type { OAuthGrant } from '../src/oauth.ts'

const origin = 'https://sidequest.test'
const grant: OAuthGrant = {
  owner: 'operator',
  address: '0x1111111111111111111111111111111111111111',
  chainId: 10143,
  scopes: ['sidequest:read'],
  agentIds: ['a1'],
  registryAgentId: '7',
  clientId: 'c',
  resource: `${origin}/mcp`,
}
const tools = {
  get_task: {
    description: 'Read task',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
  },
}
const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
}
const route = (
  method: string,
  params: Record<string, unknown> = {},
  overrides: Partial<Parameters<typeof mcpRoute>[0]> = {},
) =>
  mcpRoute({
    method: 'POST',
    pathname: '/mcp',
    origin,
    headers: {},
    body: { jsonrpc: '2.0', id: 1, method, params },
    grant,
    tools,
    call: async () => ({ ok: true, result: { taskId: 't1' } }),
    ...overrides,
  })
const result = (value: Awaited<ReturnType<typeof mcpRoute>>) =>
  (value.body as { result: Record<string, unknown> }).result

describe('2026-07-28 MCP lane', () => {
  it('discovers without initialize, with serverInfo only in _meta', async () => {
    expect(MODERN_LANE).toBe(true)
    expect(result(await route('server/discover', { _meta: meta }))).toEqual({
      resultType: 'complete',
      supportedVersions: ['2026-07-28'],
      capabilities: {
        tools: { listChanged: false },
        prompts: {},
        resources: {},
        events: {},
        extensions: { 'io.modelcontextprotocol/skills': {} },
      },
      instructions: connectorInstructions(origin),
      ttlMs: 0,
      cacheScope: 'private',
      _meta: {
        'io.modelcontextprotocol/serverInfo': {
          name: 'exchange.sidequest/sidequest',
          title: 'Sidequest',
          version: '2.0.0',
        },
      },
    })
    expect(result(await route('server/discover'))).not.toHaveProperty('serverInfo')
  })
  it.each(['tools/list', 'prompts/list', 'resources/list', 'events/list'])('decorates modern %s', async (method) => {
    const events = new McpEvents(fromNodeSqlite(new DatabaseSync(':memory:')), 'monad-testnet')
    expect(result(await route(method, { _meta: meta }, { events }))).toMatchObject({
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'private',
    })
  })
  it('keeps tools/call content shape and decorates only its result', async () => {
    expect(result(await route('tools/call', { _meta: meta, name: 'get_task', arguments: { taskId: 't1' } }))).toEqual({
      resultType: 'complete',
      content: [{ type: 'text', text: '{"ok":true,"result":{"taskId":"t1"}}' }],
      structuredContent: { ok: true, result: { taskId: 't1' } },
    })
  })
  it.each([
    ['tools/list', {}, { 'mcp-method': 'tools/call' }],
    ['tools/list', {}, { 'mcp-protocol-version': '2025-06-18' }],
    ['tools/call', { name: 'get_task' }, { 'mcp-name': 'list_tasks' }],
    ['prompts/get', { name: 'hire' }, { 'mcp-name': 'find_work' }],
    ['resources/read', { uri: 'sidequest://skills/worker' }, { 'mcp-name': 'sidequest://skills/publisher' }],
  ])('rejects inconsistent modern headers for %s', async (method, params, headers) => {
    const reply = await route(method, { ...params, _meta: meta }, { headers })
    expect(reply.status).toBe(400)
    expect(reply.body).toMatchObject({ error: { code: -32020 } })
  })
  it('accepts matching modern headers including a resource URI', async () => {
    const reply = await route(
      'resources/read',
      { uri: 'sidequest://skills/worker', _meta: meta },
      {
        headers: {
          'mcp-method': 'resources/read',
          'mcp-name': 'sidequest://skills/worker',
          'mcp-protocol-version': '2026-07-28',
        },
      },
    )
    expect(reply.status).toBe(200)
    expect(result(reply)).toHaveProperty('resultType', 'complete')
  })
  it('reports unsupported body versions with supportedVersions and HTTP 400', async () => {
    const reply = await route(
      'tools/list',
      { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2027-01-01' } },
      { headers: { 'mcp-protocol-version': '2027-01-01' } },
    )
    expect(reply.status).toBe(400)
    expect(reply.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32022, message: 'Unsupported protocol version', data: { supportedVersions: ['2026-07-28'] } },
    })
  })
  it('auth precedes malformed modern metadata, and never invokes events without a grant', async () => {
    const input = {
      method: 'POST',
      pathname: '/mcp',
      origin,
      headers: { 'mcp-method': 'wrong' },
      body: { id: 1, method: 'server/discover', params: { _meta: meta } },
      tools,
      call: vi.fn(),
    }
    expect(await mcpRoute(input)).toEqual({
      status: 401,
      headers: {
        'cache-control': 'no-store',
        'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      },
      body: { ok: false, code: 'unauthenticated', message: 'A resource-scoped OAuth bearer token is required' },
    })
    expect(input.call).not.toHaveBeenCalled()
  })
  it('decorates custom poll results too', async () => {
    const events = new McpEvents(fromNodeSqlite(new DatabaseSync(':memory:')), 'monad-testnet')
    expect(result(await route('events/poll', { _meta: meta, name: 'sidequest.inbox' }, { events }))).toMatchObject({
      resultType: 'complete',
      events: [],
      cursor: 'v1:0',
      hasMore: false,
      truncated: false,
      nextPollMs: 60000,
    })
  })
})

describe('legacy wire snapshots and rollback', () => {
  // Wire shape remains stable across lanes; canonical identity is shared with public discovery.
  it.each([true, false])('keeps initialize/tools responses byte-identical with modernLane=%s', async (modernLane) => {
    const initialize = {
      protocolVersion: '2025-03-26',
      capabilities: { tools: { listChanged: false }, prompts: {}, resources: {} },
      serverInfo: { name: 'exchange.sidequest/sidequest', title: 'Sidequest', version: '2.0.0' },
      instructions: connectorInstructions(origin),
    }
    const reply = await route('initialize', { protocolVersion: '2025-03-26' }, { modernLane })
    const actual = result(reply)
    expect(actual.capabilities).toHaveProperty('events', {})
    const { events: _events, extensions: _extensions, ...capabilities } = actual.capabilities as Record<string, unknown>
    expect(JSON.stringify({ ...actual, capabilities })).toBe(JSON.stringify(initialize))
    expect(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: (result(await route('tools/list', {}, { modernLane })).tools as Record<string, unknown>[])
            .filter((tool) => !['show_hiring_dashboard', 'show_task'].includes(String(tool.name)))
            .map(
              ({
                title: _title,
                annotations: _annotations,
                outputSchema: _outputSchema,
                securitySchemes: _securitySchemes,
                ...tool
              }) => tool,
            ),
        },
      }),
    ).toBe(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            {
              name: 'get_task',
              description: 'Read task',
              inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
            },
            {
              name: 'get_instructions',
              description: 'Read the full connector, worker or publisher role instructions.',
              inputSchema: {
                type: 'object',
                properties: { role: { type: 'string', enum: ['connector', 'worker', 'publisher'] } },
              },
            },
            {
              name: 'search_docs',
              description: 'Searches the Sidequest docs and returns pages to read with resources/read.',
              inputSchema: {
                type: 'object',
                properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
                required: ['query'],
              },
            },
          ],
        },
      }),
    )
    expect(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: result(await route('tools/call', { name: 'get_task', arguments: { taskId: 't1' } }, { modernLane }))
            .content,
        },
      }),
    ).toBe(
      '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"ok\\":true,\\"result\\":{\\"taskId\\":\\"t1\\"}}"}]}}',
    )
  })
  it('disables all modern handling while retaining legacy events', async () => {
    const events = new McpEvents(fromNodeSqlite(new DatabaseSync(':memory:')), 'monad-testnet')
    expect((await route('server/discover', { _meta: meta }, { modernLane: false })).body).toMatchObject({
      error: { code: -32601 },
    })
    const reply = await route(
      'events/list',
      { _meta: { 'io.modelcontextprotocol/protocolVersion': 'bad' } },
      { modernLane: false, events, headers: { 'mcp-method': 'wrong' } },
    )
    expect(reply.status).toBe(200)
    expect(result(reply)).not.toHaveProperty('resultType')
    expect(result(reply)).not.toHaveProperty('ttlMs')
    expect(result(reply).events).toHaveLength(4)
  })
})

describe('hosted tool metadata', () => {
  const fullGrant = { ...grant, scopes: ['sidequest:read', 'sidequest:hire', 'sidequest:work'] }
  it.each([{}, { _meta: meta }])('annotates every visible tool on both lanes', async (params) => {
    const listed = result(await route('tools/list', params, { grant: fullGrant, tools: registry })).tools as Record<
      string,
      unknown
    >[]
    expect(listed.length).toBeGreaterThan(30)
    for (const tool of listed) {
      expect(tool.title).toEqual(expect.any(String))
      expect(tool.annotations).toEqual({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: false,
      })
      expect(tool.outputSchema).toMatchObject({ type: 'object' })
      expect(tool.securitySchemes).toEqual(expect.arrayContaining([{ type: 'oauth2', scopes: expect.any(Array) }]))
    }
    expect(listed.find((tool) => tool.name === 'check_operation')?.inputSchema).not.toHaveProperty(
      'properties.operationKey',
    )
    expect(listed.find((tool) => tool.name === 'whoami')).toHaveProperty('_meta.openai/profile', true)
    expect(listed.find((tool) => tool.name === 'set_backer_share')).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      inputSchema: { required: expect.arrayContaining(['bps', 'operationKey']), additionalProperties: false },
    })
    expect(requiredToolScope('check_operation')).toBe('sidequest:read')
    expect(requiredToolScope('add_statement')).toBe('sidequest:work')
    expect(toolAnnotations('settlement_actions')).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    expect(toolAnnotations('request_quotes')).toMatchObject({ destructiveHint: false })
  })
  it('gives a hire-only connection publishing tools and no payment, stake, earnings or permission tools', async () => {
    const hireGrant = { ...grant, scopes: ['sidequest:read', 'sidequest:hire'] }
    const names = (
      result(await route('tools/list', { _meta: meta }, { grant: hireGrant, tools: registry })).tools as {
        name: string
      }[]
    ).map((tool) => tool.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'create_task',
        'request_quotes',
        'pick_quote',
        'select_worker',
        'approve_work',
        'reject_work',
        'cancel_task',
        'settlement_actions',
      ]),
    )
    for (const name of [
      'x402_pay',
      'sweep_earnings',
      'request_unstake',
      'cancel_unstake',
      'withdraw_stake',
      'request_permissions',
      'use_permission',
      'revoke_permission',
      'set_backer_share',
    ]) {
      expect(names).not.toContain(name)
      expect(requiredToolScope(name)).toBe('sidequest:work')
    }
    const call = vi.fn()
    const refused = result(
      await route(
        'tools/call',
        { _meta: meta, name: 'x402_pay', arguments: { operationKey: 'k' } },
        { grant: hireGrant, tools: registry, call },
      ),
    )
    expect(refused).toMatchObject({ isError: true, _meta: { 'mcp/www_authenticate': { error: 'insufficient_scope' } } })
    expect(call).not.toHaveBeenCalled()
  })
  it.each(['get_task', 'create_task'])('keeps complete text and structured output for %s', async (name) => {
    const output = {
      ok: true,
      result: {
        status: name === 'create_task' ? 'approval' : 'open',
        taskId: 't1',
        approveUrl: 'https://sidequest.test/approve',
      },
    }
    const reply = result(
      await route(
        'tools/call',
        { name, arguments: { operationKey: 'one' } },
        { grant: fullGrant, tools: registry, call: async () => output },
      ),
    )
    expect(reply.structuredContent).toMatchObject(JSON.parse((reply.content as { text: string }[])[0]!.text))
  })
  it('keeps profile identity stable across client grants and carries it in text', async () => {
    const one = result(await route('tools/call', { name: 'whoami' }, { tools: registry }))
    const two = result(
      await route('tools/call', { name: 'whoami' }, { tools: registry, grant: { ...grant, clientId: 'different' } }),
    )
    expect(one.structuredContent).toEqual(two.structuredContent)
    expect(one.structuredContent).toMatchObject({
      id: expect.stringMatching(/^sq_[a-f0-9]{64}$/),
      name: expect.any(String),
      // The ERC-8004 agent this connection acts for, where agents read tool results (gap 3: quoting needed it).
      result: { agentId: '7', chainId: 10143 },
    })
    expect(JSON.parse((one.content as { text: string }[])[0]!.text)).toEqual(one.structuredContent)
  })
  it('adds a linking challenge only to grant/auth failures', async () => {
    const call = vi.fn()
    const denied = result(await route('tools/call', { name: 'create_task' }, { tools: registry, call }))
    expect(denied).toMatchObject({
      isError: true,
      _meta: { 'mcp/www_authenticate': { error: 'insufficient_scope', error_description: expect.any(String) } },
    })
    expect(call).not.toHaveBeenCalled()
    const failed = result(
      await route(
        'tools/call',
        { name: 'get_task' },
        { call: async () => ({ ok: false, code: 'forbidden', message: 'Grant revoked' }) },
      ),
    )
    expect(failed).toHaveProperty('_meta.mcp/www_authenticate')
  })
})

it('serves authenticated static skills with pagination and matching resource bytes', async () => {
  const first = result(await route('skills/list'))
  expect(first.skills).toHaveLength(2)
  expect(first.nextCursor).toBe('skills:2')
  const last = result(await route('skills/list', { cursor: first.nextCursor }))
  expect(last.skills).toHaveLength(1)
  expect(last).not.toHaveProperty('nextCursor')
  for (const entry of [...(first.skills as { uri: string }[]), ...(last.skills as { uri: string }[])]) {
    expect(result(await route('skills/get', { uri: entry.uri }))).toEqual({ skill: entry })
    const read = result(await route('resources/read', { uri: entry.uri })).contents as { uri: string; text: string }[]
    expect(read).toHaveLength(1)
    expect(read[0]!.uri).toBe(entry.uri)
    expect(read[0]!.text).toMatch(/^---\nname:/)
  }
  expect((await route('skills/list', { cursor: 'broken' })).body).toMatchObject({ error: { code: -32602 } })
  for (const method of ['skills/list', 'skills/get', 'resources/read']) {
    const unauth = await mcpRoute({
      method: 'POST',
      pathname: '/mcp',
      origin,
      headers: {},
      body: { id: 1, method, params: { uri: 'skill://sidequest/sidequest-publisher/SKILL.md' } },
      tools: registry,
      call: async () => ({}),
    })
    expect(unauth.status).toBe(401)
  }
})
