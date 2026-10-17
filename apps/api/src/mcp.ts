import { agentFailureReply } from '@sidequest/board'
import { EVENT_DESCRIPTORS, eventDescriptors } from '@sidequest/indexer'
import { Schema } from 'effect'
import { deployment } from '@sidequest/sdk'
import type { OAuthGrant } from './oauth.ts'
import {
  SETUP_WAITING,
  effectiveRoles,
  listedTool,
  requiredToolScope,
  toolAnnotations,
  toolRefusal,
} from './mcp-policy.ts'
import { publicDirectoryProtocol, PUBLIC_DIRECTORY_INSTRUCTIONS } from './mcp-public-directory.ts'
import { toolWireMetadata } from './mcp-tool-metadata.ts'
import { approvalRound, settledCreation } from './mcp-mrtr.ts'
import type { ListenRequest } from './mcp-listen.ts'
import { ROLE_GUIDES, connectorInstructions, renderSkill } from './mcp-instructions.ts'
import { eventArguments, eventCursor, eventMaxAge, type McpEvents } from './mcp-events.ts'
import { EventRpcError } from './webhooks.ts'
import { renderedSkillManifests } from './generated/skills.ts'
import { hiringTools, hiringResource, renderHiring } from './mcp-hiring.ts'
import { commonsResource } from './mcp-commons.ts'
import { docsResources, readDoc, searchDocs } from './mcp-docs.ts'
import { MCP_LEGACY_PROTOCOL_VERSIONS, MCP_PROTOCOL_VERSION, MCP_SERVER_INFO } from './mcp-metadata.ts'

const PROTOCOLS = MCP_LEGACY_PROTOCOL_VERSIONS
export const MODERN_LANE = true
const MODERN_VERSION = MCP_PROTOCOL_VERSION
/** Skills change only on deploy and read the same for every caller, so clients may cache them for an hour. */
const SKILLS_CACHE = { ttlMs: 3_600_000, cacheScope: 'public' }

export interface McpReply {
  readonly status: number
  readonly body?: unknown
  readonly headers?: Record<string, string>
  /** A 2026 `subscriptions/listen`: the Worker answers with the management object's stream for this connection. */
  readonly listen?: ListenRequest
  readonly eventStream?: {
    readonly subscriptionId: string | number
    readonly name: string
    readonly arguments: Record<string, unknown>
    readonly cursor?: unknown
    readonly maxAgeMs?: number
  }
}

const Listen = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  params: Schema.Struct({
    notifications: Schema.optionalKey(Schema.Struct({ toolsListChanged: Schema.optionalKey(Schema.Boolean) })),
  }),
})

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

async function profileId(agentId: string, address: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`sidequest:profile:${agentId || address.toLowerCase()}`),
  )
  return `sq_${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/**
 * whoami for a connection: the board's answer plus the connection's profile, and inside `result` the ERC-8004 agent
 * this grant acts for, which `submit_quote` and `apply` name, and what it may do now: the roles its scope covers and its
 * agent holds (none in setup).
 * Agents read `result`; the profile is for the host.
 */
function whoamiContent(output: unknown, grant: OAuthGrant, id: string, name: string) {
  const base = typeof output === 'object' && output !== null ? (output as Record<string, unknown>) : { value: output }
  const result = base.result instanceof Object ? Object.fromEntries(Object.entries(base.result)) : {}
  const roles = effectiveRoles(grant)
  return { ...base, result: { ...result, agentId: grant.registryAgentId, chainId: grant.chainId, roles }, id, name }
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
  readonly publicDirectory?: boolean
}): Promise<McpReply> {
  const { method, pathname, body, grant, call, origin } = input
  const publicDirectory = input.publicDirectory === true
  const tools = { ...input.tools, ...hiringTools }
  const skillManifests = publicDirectory ? [] : await renderedSkillManifests(origin)
  if (grant === undefined && !publicDirectory)
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
            ...(methodName.endsWith('/list') ? { ttlMs: 0, cacheScope: 'private' } : {}),
            ...result,
            resultType: 'complete',
          }
        : result,
    })
  // A notification has no id; a client's JSON-RPC response has an id but no method, and a result or an error.
  // Either is accepted with nothing to answer.
  const response = body.method === undefined && ('result' in body || 'error' in body)
  if (id === undefined || response) return { status: 202, headers: { 'cache-control': 'no-store' } }
  const capabilities = publicDirectory
    ? { tools: { listChanged: false } }
    : {
        tools: { listChanged: false },
        prompts: {},
        resources: {},
        events: {},
        // SEP-3415 names Events as an extension; the top-level `events` stays for the clients that already read it.
        extensions: { 'io.modelcontextprotocol/skills': {}, 'io.modelcontextprotocol/events': {} },
      }
  if (modern && methodName === 'server/discover')
    return respond({
      resultType: 'complete',
      supportedVersions: [MODERN_VERSION],
      // ADR-0021: tool changes reach 2026 clients over subscriptions/listen; the legacy lane never hears them.
      capabilities: { ...capabilities, tools: { listChanged: !publicDirectory } },
      instructions: publicDirectory ? PUBLIC_DIRECTORY_INSTRUCTIONS : connectorInstructions(origin),
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
      instructions: publicDirectory ? PUBLIC_DIRECTORY_INSTRUCTIONS : connectorInstructions(origin),
    })
  }
  // A notification sent with an id is answered leniently rather than as an unknown method.
  if (methodName === 'ping' || methodName.startsWith('notifications/')) return respond({})
  if (publicDirectory)
    return publicDirectoryProtocol({ methodName, params, tools: input.tools, call, respond, rpcError })
  if (grant === undefined) return rpcError(-32603, 'OAuth grant unavailable')
  if (modern && methodName === 'subscriptions/listen') {
    if (!Schema.is(Listen)(body)) return rpcError(-32602, 'subscriptions/listen needs a request id and notifications')
    const hearsTools = body.params.notifications?.toolsListChanged === true
    // Only what this server can honour is acknowledged; the stream itself comes from the management object.
    return {
      status: 200,
      listen: { subscriptionId: body.id, notifications: hearsTools ? { toolsListChanged: true } : {} },
    }
  }
  if (methodName === 'events/stream') {
    if (
      input.events === undefined ||
      grant.setup === true ||
      !grant.scopes.includes('sidequest:read') ||
      grant.chainId !== deployment(input.events.network).chainId
    )
      return rpcError(-32003, 'This connection does not grant events on this chain')
    if (!Schema.is(Schema.Struct({ id: Schema.Union([Schema.String, Schema.Number]) }))(body))
      return rpcError(-32602, 'events/stream needs a request id')
    try {
      const parsed = eventArguments(params.name, params.arguments)
      eventCursor(params.cursor)
      const maxAgeMs = eventMaxAge(params.maxAgeMs)
      return {
        status: 200,
        eventStream: {
          subscriptionId: body.id,
          name: parsed.name,
          arguments: parsed.args,
          cursor: params.cursor,
          ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
        },
      }
    } catch (error) {
      if (error instanceof EventRpcError) return rpcError(error.code, error.message)
      return rpcError(-32602, 'Invalid event stream request')
    }
  }
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
        .filter(([name]) => listedTool(grant, name))
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
        { uri: commonsResource.uri, name: 'Commons plans', mimeType: commonsResource.mimeType },
        ...docsResources(),
      ],
    })
  // Every resource is listed; none is parameterised, so there is no template.
  if (methodName === 'resources/templates/list') return respond({ resourceTemplates: [] })
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
      ...SKILLS_CACHE,
    })
  }
  if (methodName === 'skills/get') {
    const skill = skillManifests.find((entry) => entry.uri === params.uri)
    if (skill === undefined) return rpcError(-32602, 'Unknown skill URI')
    const { raw: _raw, ...entry } = skill
    return respond({ skill: entry, ...SKILLS_CACHE })
  }
  // A setup connection has no agent to receive events yet: it may read the catalog and is told to wait for the rest.
  if (methodName.startsWith('events/') && grant.setup === true)
    return methodName === 'events/list'
      ? respond({ events: input.events === undefined ? EVENT_DESCRIPTORS : eventDescriptors(input.events.network) })
      : rpcError(-32003, `${SETUP_WAITING} Poll setup_status; events work on this connection once it reports ready.`)
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
    if (params.uri === commonsResource.uri) return respond({ contents: [commonsResource] })
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
    // A new agent's approval landed while the client waited on its native prompt: the same call now completes.
    const settled = modern ? settledCreation(params, name, grant) : undefined
    if (settled !== undefined) return respond(settled)
    const refusal = toolRefusal(grant, name)
    // ADR-0021: a missing scope is the MCP step-up, so a client that can will ask its user for more access.
    if (refusal !== undefined && 'stepUp' in refusal)
      return json(
        {
          jsonrpc: '2.0',
          id: id ?? null,
          error: {
            code: -32003,
            message: `insufficient_scope: this connection was not granted ${name}. Sign in to Sidequest again to grant it; a client that cannot step up must reconnect.`,
            data: { scope: refusal.stepUp },
          },
        },
        403,
        {
          'www-authenticate': `Bearer error="insufficient_scope", scope="${refusal.stepUp}", resource_metadata="${origin}/.well-known/oauth-protected-resource${pathname}"`,
        },
      )
    if (refusal !== undefined) return respond(refusal.result)
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
      return respond({ content: [{ type: 'text', text: 'forbidden: select one granted agent' }], isError: true })
    try {
      const run = () =>
        Object.hasOwn(hiringTools, name) ? renderHiring(name, args, agentId, call) : call(name, args, agentId)
      const setupStatus = (agentKey: string) => call('setup_status', { agentKey }, agentId)
      const round = modern
        ? await approvalRound({ params, tool: name, agentId, args, run, setupStatus })
        : { kind: 'output' as const, output: await run() }
      // ADR-0021: an approval the client can open asks for it natively, then the client retries the same call.
      if (round.kind === 'input') return json({ jsonrpc: '2.0', id: id ?? null, result: round.result })
      if (round.kind === 'invalid') return rpcError(-32602, 'This retry does not carry the state its call was given')
      if (round.kind === 'closed')
        return respond({
          content: [
            {
              type: 'text',
              text: `closed: the approval prompt was closed, so nothing ran. It still waits for your operator at ${round.url}; call this tool again with the same operationKey once they decide.`,
            },
          ],
          isError: true,
        })
      const output = round.output
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
        ...(failed ? { isError: true } : {}),
      })
    } catch (error) {
      const failure = agentFailureReply(
        error,
        'The tool failed',
        undefined,
        'unavailable',
        toolAnnotations(name).readOnlyHint ? 'read' : 'same-key',
      )
      return respond({
        content: [{ type: 'text', text: JSON.stringify(failure) }],
        structuredContent: failure,
        isError: true,
      })
    }
  }
  return json(
    { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `method not found: ${methodName}` } },
    200,
  )
}
