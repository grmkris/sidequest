/**
 * One content-free line per hosted MCP request, so a client's run ledger can be matched step by step in Workers Logs.
 * It names the method, the tool, the lane, how the request ended and the connection; never arguments, results or text.
 * Values the client chose are kept only when they look like protocol names.
 */
import { Schema } from 'effect'
import type { McpReply } from './mcp.ts'
import type { OAuthGrant } from './oauth.ts'

const NAME = /^[a-z][a-z0-9_/]{0,63}$/
const PROTOCOL = /^\d{4}-\d{2}-\d{2}$/
const CODE = /^[a-z][a-z0-9_-]{0,39}$/
/** Server-written refusal prefixes such as `role-required:` or `waiting:`; tool output text starts with JSON instead. */
const PREFIX = /^([a-z][a-z-]{1,39}):/

const Method = Schema.Struct({ method: Schema.String })
const Tool = Schema.Struct({ params: Schema.Struct({ name: Schema.String }) })
const Protocol = Schema.Struct({
  params: Schema.Struct({ _meta: Schema.Struct({ 'io.modelcontextprotocol/protocolVersion': Schema.String }) }),
})
const RpcError = Schema.Struct({ error: Schema.Struct({ code: Schema.Number }) })
const Result = Schema.Struct({
  result: Schema.Struct({
    resultType: Schema.optionalKey(Schema.String),
    isError: Schema.optionalKey(Schema.Boolean),
  }),
})
const Coded = Schema.Struct({ result: Schema.Struct({ structuredContent: Schema.Struct({ code: Schema.String }) }) })
const Texted = Schema.Struct({
  result: Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })).check(Schema.isMinLength(1)) }),
})

function named(value: string): string | undefined {
  return NAME.test(value) ? value : undefined
}

/** How a request ended: the HTTP or JSON-RPC failure, the 2026 prompt, or a tool error with its server-written code. */
function outcome(reply: McpReply): string {
  if (reply.listen !== undefined) return 'listen'
  if (reply.status === 401) return 'unauthenticated'
  if (reply.status === 403) return 'insufficient_scope'
  if (Schema.is(RpcError)(reply.body)) return `rpc-error:${reply.body.error.code}`
  if (!Schema.is(Result)(reply.body)) return reply.status === 202 || reply.status === 204 ? 'accepted' : 'other'
  if (reply.body.result.resultType === 'input_required') return 'input_required'
  if (reply.body.result.isError !== true) return 'ok'
  const code = Schema.is(Coded)(reply.body)
    ? CODE.exec(reply.body.result.structuredContent.code)?.[0]
    : Schema.is(Texted)(reply.body)
      ? PREFIX.exec(reply.body.result.content[0]!.text)?.[1]
      : undefined
  return code === undefined ? 'tool-error' : `tool-error:${code}`
}

export function mcpLogLine(input: {
  readonly request: unknown
  readonly reply: McpReply
  readonly grant: OAuthGrant | null
  readonly ms: number
}) {
  const { request, reply, grant } = input
  const method = Schema.is(Method)(request) ? (named(request.method) ?? 'other') : 'none'
  const tool = method === 'tools/call' && Schema.is(Tool)(request) ? (named(request.params.name) ?? 'other') : undefined
  const protocol =
    Schema.is(Protocol)(request) && PROTOCOL.test(request.params._meta['io.modelcontextprotocol/protocolVersion'])
      ? request.params._meta['io.modelcontextprotocol/protocolVersion']
      : 'legacy'
  return {
    event: 'mcp',
    method,
    ...(tool === undefined ? {} : { tool }),
    protocol,
    status: reply.status,
    outcome: outcome(reply),
    ms: input.ms,
    ...(grant === null
      ? {}
      : {
          grantId: grant.grantId ?? null,
          clientId: grant.clientId,
          setup: grant.setup === true,
          listening: grant.listening === true,
        }),
  }
}
