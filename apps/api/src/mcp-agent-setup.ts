/** Keep the existing transport while setup tools address an operator connection before minting. */
import { Schema } from 'effect'
import { mcpRoute, type McpReply } from './mcp.ts'

const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))
const records = Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)))
const strings = Schema.decodeUnknownSync(Schema.Array(Schema.String))

export async function agentFirstMcpRoute(input: Parameters<typeof mcpRoute>[0]): Promise<McpReply> {
  const grant = input.grant
  let transport = input
  if (grant?.setup === true) {
    // The transport selection uses the operator connection identity. Execution re-resolves the real setup grant
    // and receives no agent ID; this adapter never creates agent authority or forwards setup calls to a tenant.
    const { events: _events, ...setupTransport } = input
    transport = {
      ...setupTransport,
      grant: { ...grant, agentIds: [grant.owner] },
      tools: {
        ...input.tools,
        whoami: { ...input.tools.whoami, securitySchemes: [{ type: 'oauth2', scopes: ['sidequest:setup'] }] },
      },
      call: (tool, args) => input.call(tool, args, ''),
    }
  }
  const reply = await mcpRoute(transport)
  if (input.body.method !== 'tools/list' || reply.status !== 200) return reply
  const body = record(reply.body)
  const result = record(body.result)
  const tools = records(result.tools).map((tool) => {
    // The docs a setup connection may read say so, so a client that reads securitySchemes does not ask to sign in again.
    if (grant?.setup === true && (tool.name === 'get_instructions' || tool.name === 'search_docs'))
      return { ...tool, securitySchemes: [{ type: 'oauth2', scopes: ['sidequest:setup'] }] }
    if (tool.name === 'create_agent') {
      const schema = record(tool.inputSchema)
      return { ...tool, inputSchema: { ...schema, required: [...new Set(strings(schema.required))] } }
    }
    if (tool.name !== 'setup_status') return tool
    const schema = record(tool.inputSchema)
    const { operationKey: _key, ...properties } = record(schema.properties)
    return {
      ...tool,
      inputSchema: {
        ...schema,
        properties,
        required: strings(schema.required).filter((name) => name !== 'operationKey'),
      },
      securitySchemes: [
        { type: 'oauth2', scopes: grant?.setup === true ? ['sidequest:setup'] : (grant?.scopes ?? []) },
      ],
    }
  })
  return { ...reply, body: { ...body, result: { ...result, tools } } }
}
