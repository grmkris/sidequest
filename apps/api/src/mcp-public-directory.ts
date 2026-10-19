import { Schema } from 'effect'
import { directoryTypedDataJson, type DirectoryEnvelope } from '@sidequest/sdk'
import { agentFailureReply, DirectoryError } from '@sidequest/board'
import { DirectoryCallError } from './directory.ts'
import { PUBLIC_DIRECTORY_TOOLS } from './mcp-policy.ts'
import type { mcpRoute, McpReply, McpTool } from './mcp.ts'
import { toolWireMetadata } from './mcp-tool-metadata.ts'
import { admitToolArgs, type ToolArgsMode } from './tool-args.ts'

export const PUBLIC_DIRECTORY_INSTRUCTIONS =
  'These directory tools need no sign-in. Each prepare tool returns {record, typedData}: sign typedData with your ERC-8004 agent wallet (eth_signTypedData_v4), then call the matching submit tool with {record, signature} within 10 seconds of issuedAt. The signature is the credential. Retry an uncertain submission with the exact same record and signature.'

const RECORD_PREPARES = new Set([
  'prepare_directory_enrollment',
  'prepare_service_ad',
  'prepare_revoke_service_ad',
  'prepare_heartbeat',
])

function directoryContent(name: string, output: unknown): Record<string, unknown> {
  const content = Schema.is(Schema.Record(Schema.String, Schema.Unknown))(output) ? output : { value: output }
  if (RECORD_PREPARES.has(name) && content.ok === true) {
    // SAFETY: these four tools return the validated DirectoryService.prepare envelope on success.
    const record = content.result as DirectoryEnvelope
    return { ...content, result: { record, typedData: directoryTypedDataJson(record) } }
  }
  return content
}

const Call = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})

async function directoryOutput(
  call: Parameters<typeof mcpRoute>[0]['call'],
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    return directoryContent(name, await call(name, args, ''))
  } catch (error) {
    if (!(error instanceof DirectoryError || error instanceof DirectoryCallError))
      return { ok: false, code: 'unavailable', message: 'directory unavailable' }
    return {
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
    }
  }
}

/** Uses mcpRoute's shared protocol negotiation, with no hosted signer, grant or operation-key authority. */
export async function publicDirectoryProtocol(input: {
  methodName: string
  params: Record<string, unknown>
  tools: Record<string, McpTool>
  call: Parameters<typeof mcpRoute>[0]['call']
  respond: (result: Record<string, unknown>) => McpReply
  rpcError: (code: number, message: string) => McpReply
  toolArgsMode: ToolArgsMode
}): Promise<McpReply> {
  const { methodName, params, respond, rpcError } = input
  if (methodName === 'tools/list')
    return respond({
      tools: Object.entries(input.tools)
        .filter(([name]) => PUBLIC_DIRECTORY_TOOLS.has(name))
        .map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...toolWireMetadata(name, tool, true),
        })),
    })
  if (methodName !== 'tools/call') return rpcError(-32601, `method not found: ${methodName}`)
  if (!Schema.is(Call)(params)) return rpcError(-32602, 'tools/call needs a name and object arguments')
  if (!PUBLIC_DIRECTORY_TOOLS.has(params.name) || !Object.hasOwn(input.tools, params.name))
    return respond({
      content: [{ type: 'text', text: `not-found: no public directory tool ${params.name}` }],
      isError: true,
    })
  const admitted = admitToolArgs(
    params.name,
    input.tools[params.name]!.inputSchema,
    params.arguments ?? {},
    input.toolArgsMode,
  )
  if (!admitted.ok) {
    const failure = agentFailureReply(admitted.error, 'Invalid arguments')
    return respond({
      content: [{ type: 'text', text: JSON.stringify(failure) }],
      structuredContent: failure,
      isError: true,
    })
  }
  const structuredContent = await directoryOutput(input.call, params.name, admitted.args)
  return respond({
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(structuredContent.ok === false ? { isError: true } : {}),
  })
}
