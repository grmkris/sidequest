import { agentFailureReply } from '@sidequest/board'
import type { OAuthGrant } from './oauth.ts'
import { permittedTool, requiredToolScope, toolAnnotations } from './mcp-policy.ts'
import { ROLE_GUIDES, connectorInstructions, renderSkill } from './mcp-instructions.ts'
import type { McpEvents } from './mcp-events.ts'
import { EventRpcError } from './webhooks.ts'
import { renderedSkillManifests } from './generated/skills.ts'
import { hiringTools, hiringResource, renderHiring } from './mcp-hiring.ts'
import { docsResources, readDoc, searchDocs } from './mcp-docs.ts'
import { MCP_LEGACY_PROTOCOL_VERSIONS, MCP_PROTOCOL_VERSION, MCP_SERVER_INFO } from './mcp-metadata.ts'

const PROTOCOLS = MCP_LEGACY_PROTOCOL_VERSIONS
export const MODERN_LANE = true
const MODERN_VERSION = MCP_PROTOCOL_VERSION

export interface McpReply {
  readonly status: number
  readonly body?: unknown
  readonly headers?: Record<string, string>
}

export interface McpTool {
  readonly description?: string
  readonly inputSchema?: Record<string, unknown>
  readonly title?: string
  readonly outputSchema?: Record<string, unknown>
  readonly securitySchemes?: readonly Record<string, unknown>[]
  readonly annotations?: Record<string, boolean>
  readonly _meta?: Record<string, unknown>
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): McpReply {
  return { status, body, headers: { 'cache-control': 'no-store', ...headers } }
}

const objectOutput = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  additionalProperties: true,
})
const stringOutput = { type: 'string' }
const listOutput = { type: 'array', items: { type: 'object', additionalProperties: true } }
const envelope = (result: Record<string, unknown>) =>
  objectOutput({
    ok: { type: 'boolean' },
    result,
    code: stringOutput,
    message: stringOutput,
    reason: stringOutput,
    retry: { type: 'string', enum: ['same-key', 'new-key', 'after-operator', 'none'] },
  })
const hostedOutput = envelope(
  objectOutput({
    status: { type: 'string', enum: ['confirmed', 'rejected', 'approval', 'pending', 'reverted', 'dropped'] },
    operationId: stringOutput,
    approveUrl: stringOutput,
    result: { type: 'object', additionalProperties: true },
  }),
)
const PUBLISHER_OUTPUT_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = {
  whoami: {
    ...objectOutput({
      id: stringOutput,
      name: stringOutput,
      ok: { type: 'boolean' },
      result: objectOutput({
        address: { type: ['string', 'null'] },
        agentId: { type: ['string', 'null'] },
        chainId: { type: 'number' },
      }),
    }),
    required: ['id', 'name'],
  },
  protocol_info: envelope(
    objectOutput({
      network: stringOutput,
      chainId: { type: 'number' },
      paused: { type: ['boolean', 'null'] },
      contracts: { type: 'object' },
      rewardTokens: { type: 'array', items: stringOutput },
    }),
  ),
  agent_status: envelope(objectOutput({ state: stringOutput, allowances: listOutput })),
  list_tasks: envelope({
    type: 'array',
    items: objectOutput({
      taskId: stringOutput,
      quotesCount: { type: 'number' },
      chain: { type: 'object' },
      funding: { type: 'object' },
      operationStatus: { type: ['string', 'null'] },
      nextAction: { type: ['object', 'null'] },
    }),
  }),
  get_task: envelope(
    objectOutput({
      taskId: stringOutput,
      terms: { type: 'object' },
      chain: { type: 'object' },
      funding: { type: 'object' },
      operationStatus: { type: ['string', 'null'] },
      nextAction: { type: ['object', 'null'] },
      next: { type: 'array', items: { type: 'object', additionalProperties: true } },
      deliverables: listOutput,
      onchainSubmission: { type: ['object', 'null'] },
    }),
  ),
  list_quote_requests: envelope({
    anyOf: [listOutput, objectOutput({ requests: listOutput, nextCursor: stringOutput })],
  }),
  list_quotes: envelope(
    objectOutput({
      requestId: stringOutput,
      requestHash: stringOutput,
      creator: stringOutput,
      picked: { type: ['string', 'null'] },
      quotes: listOutput,
    }),
  ),
  list_applications: envelope(listOutput),
  get_directory_agent: envelope(objectOutput({ agent: { type: 'object' } })),
  get_stake: envelope({ type: 'object', additionalProperties: true }),
  inbox: envelope(
    objectOutput({
      events: listOutput,
      cursor: { type: ['string', 'null'] },
      hasMore: { type: 'boolean' },
      gap: { type: 'boolean' },
    }),
  ),
  list_approvals: envelope(objectOutput({ approvals: listOutput })),
  check_operation: envelope(objectOutput({ id: stringOutput, stage: stringOutput, status: stringOutput })),
  create_task: hostedOutput,
  request_quotes: hostedOutput,
  pick_quote: hostedOutput,
  select_worker: hostedOutput,
  approve_work: hostedOutput,
  reject_work: hostedOutput,
  cancel_task: hostedOutput,
  settlement_actions: hostedOutput,
}

function toolWireMetadata(name: string, tool: McpTool) {
  const scope = requiredToolScope(name)
  const schemes =
    scope === 'write'
      ? [
          { type: 'oauth2', scopes: ['sidequest:hire'] },
          { type: 'oauth2', scopes: ['sidequest:work'] },
        ]
      : [{ type: 'oauth2', scopes: scope === undefined ? [] : [scope] }]
  return {
    title: tool.title ?? name.replaceAll('_', ' '),
    annotations: tool.annotations ?? toolAnnotations(name),
    outputSchema: tool.outputSchema ?? PUBLISHER_OUTPUT_SCHEMAS[name] ?? { type: 'object', additionalProperties: true },
    securitySchemes: tool.securitySchemes ?? schemes,
  }
}

async function profileId(agentId: string, address: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`sidequest:profile:${agentId || address.toLowerCase()}`),
  )
  return `sq_${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/**
 * whoami for a connection: the board's answer plus the connection's profile, and inside `result` the ERC-8004 agent
 * this grant acts for, which `submit_quote` and `apply` name. Agents read `result`; the profile is for the host.
 */
function whoamiContent(output: unknown, grant: OAuthGrant, id: string, name: string) {
  const base = typeof output === 'object' && output !== null ? (output as Record<string, unknown>) : { value: output }
  const result = base.result instanceof Object ? Object.fromEntries(Object.entries(base.result)) : {}
  return { ...base, result: { ...result, agentId: grant.registryAgentId, chainId: grant.chainId }, id, name }
}

export async function mcpRoute(input: {
  readonly method: string
  readonly pathname: string
  readonly body: Record<string, unknown>
  readonly headers: Record<string, string | undefined>
  readonly events?: McpEvents
  /** Testable rollback switch; production uses MODERN_LANE. */
  readonly modernLane?: boolean
  readonly grant?: OAuthGrant
  readonly tools: Record<string, McpTool>
  readonly call: (tool: string, args: Record<string, unknown>, agentId: string) => Promise<unknown>
  readonly origin: string
}): Promise<McpReply> {
  const { method, pathname, body, grant, call, origin } = input
  const tools = { ...input.tools, ...hiringTools }
  const skillManifests = await renderedSkillManifests(origin)
  if (grant === undefined)
    return json(
      { ok: false, code: 'unauthenticated', message: 'A resource-scoped OAuth bearer token is required' },
      401,
      { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${pathname}"` },
    )
  if (method === 'GET') return json({ ok: false, code: 'method-not-allowed', message: 'SSE is not offered' }, 405)
  if (method === 'DELETE') return { status: 204, headers: { 'cache-control': 'no-store' } }
  if (method !== 'POST') return json({ ok: false, code: 'method-not-allowed' }, 405)
  const methodName = typeof body.method === 'string' ? body.method : ''
  const id = body.id
  const params = typeof body.params === 'object' && body.params !== null ? (body.params as Record<string, unknown>) : {}
  const meta =
    typeof params._meta === 'object' && params._meta !== null ? (params._meta as Record<string, unknown>) : {}
  const version = meta['io.modelcontextprotocol/protocolVersion']
  const modern =
    MODERN_LANE && (input.modernLane ?? true) && (methodName === 'server/discover' || typeof version === 'string')
  const rpcError = (code: number, message: string, status = 200, data?: unknown) =>
    json({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }, status)
  if (modern) {
    const name = methodName === 'resources/read' ? params.uri : params.name
    const expected = {
      'mcp-protocol-version': version,
      'mcp-method': methodName,
      ...(['tools/call', 'prompts/get', 'resources/read'].includes(methodName) ? { 'mcp-name': name } : {}),
    }
    if (
      Object.entries(expected).some(
        ([header, value]) => input.headers[header] !== undefined && input.headers[header] !== value,
      )
    )
      return rpcError(-32020, 'MCP header does not match the request body', 400)
    if (typeof version === 'string' && version !== MODERN_VERSION)
      return rpcError(-32022, 'Unsupported protocol version', 400, { supportedVersions: [MODERN_VERSION] })
  }
  const respond = (result: Record<string, unknown>) =>
    json({
      jsonrpc: '2.0',
      id: id ?? null,
      result: modern
        ? {
            ...result,
            resultType: 'complete',
            ...(methodName.endsWith('/list') ? { ttlMs: 0, cacheScope: 'private' } : {}),
          }
        : result,
    })
  if (id === undefined && methodName !== 'notifications/initialized')
    return { status: 202, headers: { 'cache-control': 'no-store' } }
  const capabilities = {
    tools: { listChanged: false },
    prompts: {},
    resources: {},
    events: {},
    extensions: { 'io.modelcontextprotocol/skills': {} },
  }
  if (modern && methodName === 'server/discover')
    return respond({
      resultType: 'complete',
      supportedVersions: [MODERN_VERSION],
      capabilities,
      instructions: connectorInstructions(origin),
      ttlMs: 0,
      cacheScope: 'private',
      _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
    })
  if (methodName === 'initialize') {
    return respond({
      protocolVersion:
        typeof body.params === 'object' &&
        body.params !== null &&
        PROTOCOLS.includes((body.params as { protocolVersion?: string }).protocolVersion as (typeof PROTOCOLS)[number])
          ? (body.params as { protocolVersion: (typeof PROTOCOLS)[number] }).protocolVersion
          : PROTOCOLS[0],
      capabilities,
      serverInfo: MCP_SERVER_INFO,
      instructions: connectorInstructions(origin),
    })
  }
  if (methodName === 'ping') return respond({})
  if (methodName === 'tools/list') {
    return respond({
      tools: Object.entries({
        ...tools,
        get_instructions: {
          description: 'Read the full connector, worker or publisher role instructions.',
          inputSchema: {
            type: 'object',
            properties: { role: { type: 'string', enum: ['connector', 'worker', 'publisher'] } },
          },
        },
        search_docs: {
          description: 'Searches the Sidequest docs and returns pages to read with resources/read.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
            required: ['query'],
          },
          outputSchema: { type: 'object', additionalProperties: true },
        },
      })
        .filter(([name]) => permittedTool(grant, name))
        .map(([name, tool]) => {
          const schema = tool.inputSchema ?? { type: 'object', properties: {} }
          const write = requiredToolScope(name) !== 'sidequest:read'
          const existingRequired = Array.isArray((schema as { required?: unknown }).required)
            ? (schema as unknown as { required: string[] }).required
            : []
          const wireTool = tool as McpTool
          return {
            name,
            description: wireTool.description,
            inputSchema: {
              ...schema,
              properties: {
                ...(schema.properties as Record<string, unknown>),
                ...(write
                  ? {
                      operationKey: {
                        type: 'string',
                        description:
                          'Persist this stable unique action key before calling. Reuse it with identical arguments after any lost response.',
                      },
                    }
                  : {}),
              },
              ...(write ? { required: [...existingRequired, 'operationKey'] } : {}),
            },
            ...toolWireMetadata(name, wireTool),
            ...(wireTool._meta === undefined ? {} : { _meta: wireTool._meta }),
            ...(name === 'whoami' ? { _meta: { 'openai/profile': true } } : {}),
          }
        }),
    })
  }
  if (methodName === 'prompts/list')
    return respond({
      prompts: [
        { name: 'find_work', description: 'Find available work' },
        { name: 'hire', description: 'Hire a worker' },
        { name: 'check_status', description: 'Check a job status' },
      ],
    })
  if (methodName === 'resources/list')
    return respond({
      resources: [
        ...Object.keys(ROLE_GUIDES).map((role) => ({
          uri: `sidequest://skills/${role}`,
          name: role,
          mimeType: 'text/markdown',
        })),
        ...skillManifests.map((skill) => ({ uri: skill.uri, name: skill.frontmatter.name, mimeType: 'text/markdown' })),
        { uri: hiringResource.uri, name: 'Hiring desk', mimeType: hiringResource.mimeType },
        ...docsResources(),
      ],
    })
  if (methodName === 'skills/list') {
    const after =
      params.cursor === undefined
        ? 0
        : typeof params.cursor === 'string' && /^skills:[0-9]+$/.test(params.cursor)
          ? Number(params.cursor.slice(7))
          : -1
    if (!Number.isSafeInteger(after) || after < 0 || after > skillManifests.length)
      return rpcError(-32602, 'Invalid skills cursor')
    const page = skillManifests.slice(after, after + 2).map(({ raw: _raw, ...entry }) => entry)
    return respond({
      skills: page,
      ...(after + page.length < skillManifests.length ? { nextCursor: `skills:${after + page.length}` } : {}),
    })
  }
  if (methodName === 'skills/get') {
    const skill = skillManifests.find((entry) => entry.uri === params.uri)
    if (skill === undefined) return rpcError(-32602, 'Unknown skill URI')
    const { raw: _raw, ...entry } = skill
    return respond({ skill: entry })
  }
  if (methodName.startsWith('events/') && input.events !== undefined) {
    try {
      return respond(await input.events.handle(methodName, params, grant))
    } catch (error) {
      if (error instanceof EventRpcError) return rpcError(error.code, error.message)
      return rpcError(-32603, 'Events are unavailable')
    }
  }
  if (methodName === 'prompts/get') {
    const prompts: Record<string, string> = {
      find_work:
        'Read get_instructions(role=worker), list available jobs and quotes, and propose suitable work. Check the frozen terms, bond and arbitrator before activation.',
      hire: 'Read get_instructions(role=publisher), write public acceptance criteria and request quotes. Inspect quotes and select a worker within the allowance.',
      check_status:
        'Read the task and its chain status. Report which actor must act next and any deadline. Reconcile pending operations before retries.',
    }
    const text = prompts[String(params.name)]
    if (text !== undefined) return respond({ messages: [{ role: 'user', content: { type: 'text', text } }] })
  }
  if (methodName === 'resources/read') {
    if (typeof params.uri === 'string' && params.uri.startsWith('sidequest://docs/')) {
      const text = readDoc(params.uri, origin)
      if (text === undefined) return rpcError(-32002, `Unknown docs resource: ${params.uri}`)
      return respond({ contents: [{ uri: params.uri, mimeType: 'text/markdown', text }] })
    }
    if (params.uri === hiringResource.uri) return respond({ contents: [hiringResource] })
    const skill = skillManifests.find((entry) => entry.uri === params.uri)
    if (skill !== undefined)
      return respond({ contents: [{ uri: skill.uri, mimeType: 'text/markdown', text: skill.raw }] })
    const role = String(params.uri).replace(/^sidequest:\/\/skills\//, '') as keyof typeof ROLE_GUIDES
    if (Object.hasOwn(ROLE_GUIDES, role))
      return respond({
        contents: [{ uri: params.uri, mimeType: 'text/markdown', text: renderSkill(ROLE_GUIDES[role], origin) }],
      })
  }
  if (methodName === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : ''
    const tool = tools[name]
    const args =
      typeof params.arguments === 'object' && params.arguments !== null
        ? (params.arguments as Record<string, unknown>)
        : {}
    if (!permittedTool(grant, name))
      return respond({
        content: [{ type: 'text', text: 'forbidden: this connection does not grant this tool' }],
        isError: true,
        _meta: {
          'mcp/www_authenticate': {
            error: 'insufficient_scope',
            error_description: 'This connection does not grant the requested tool',
          },
        },
      })
    if (name === 'get_instructions') {
      const role = typeof args.role === 'string' ? args.role : 'connector'
      return respond(
        Object.hasOwn(ROLE_GUIDES, role)
          ? {
              content: [{ type: 'text', text: renderSkill(ROLE_GUIDES[role as keyof typeof ROLE_GUIDES], origin) }],
              structuredContent: { instructions: renderSkill(ROLE_GUIDES[role as keyof typeof ROLE_GUIDES], origin) },
            }
          : { content: [{ type: 'text', text: 'invalid role' }], isError: true },
      )
    }
    if (name === 'search_docs') {
      const query = typeof args.query === 'string' ? args.query : ''
      if (query.trim() === '')
        return respond({ content: [{ type: 'text', text: 'query must not be empty' }], isError: true })
      const searchInput: { query: string; limit?: number } = { query }
      if (typeof args.limit === 'number') searchInput.limit = args.limit
      const result = searchDocs(searchInput, origin)
      return respond({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result })
    }
    if (tool === undefined)
      return respond({ content: [{ type: 'text', text: `not-found: no tool ${name}` }], isError: true })
    const agentId =
      typeof args.managedAgentId === 'string'
        ? args.managedAgentId
        : grant.agentIds.length === 1
          ? grant.agentIds[0]!
          : ''
    if (!grant.agentIds.includes(agentId))
      return respond({
        content: [{ type: 'text', text: 'forbidden: select one granted agent' }],
        isError: true,
        _meta: {
          'mcp/www_authenticate': {
            error: 'insufficient_scope',
            error_description: 'Select one agent granted by this connection',
          },
        },
      })
    try {
      const output = Object.hasOwn(hiringTools, name)
        ? await renderHiring(name, args, agentId, call)
        : await call(name, args, agentId)
      const structuredContent =
        name === 'whoami'
          ? whoamiContent(output, grant, await profileId(agentId, grant.address), agentId || 'Sidequest agent')
          : typeof output === 'object' && output !== null
            ? output
            : { value: output }
      const failed = typeof output === 'object' && output !== null && (output as { ok?: boolean }).ok === false
      return respond({
        content: [{ type: 'text', text: JSON.stringify(name === 'whoami' ? structuredContent : output) }],
        structuredContent,
        ...(name === 'whoami' ? { _meta: { 'openai/profile': true } } : {}),
        ...(failed
          ? {
              isError: true,
              ...(['forbidden', 'unauthenticated'].includes(String((output as { code?: string }).code))
                ? {
                    _meta: {
                      'mcp/www_authenticate': {
                        error: 'insufficient_scope',
                        error_description: String((output as { message?: string }).message ?? 'Access is not granted'),
                      },
                    },
                  }
                : {}),
            }
          : {}),
      })
    } catch (error) {
      const failure = agentFailureReply(error, 'The tool failed')
      return respond({
        content: [{ type: 'text', text: JSON.stringify(failure) }],
        structuredContent: failure,
        isError: true,
        ...(['forbidden', 'unauthenticated'].includes(failure.code)
          ? { _meta: { 'mcp/www_authenticate': { error: 'insufficient_scope', error_description: failure.message } } }
          : {}),
      })
    }
  }
  return json(
    { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `method not found: ${methodName}` } },
    200,
  )
}
