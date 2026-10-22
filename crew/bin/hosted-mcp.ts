/**
 * A hosted agent's tool calls over a board's /mcp, shared by the crew (crew.ts) and the hosted hirers
 * (hosted-hirers.ts), and the owner-only files their connections keep. Signing in is mcp-oauth.ts; nothing here knows
 * about members or personas.
 */
import { Option, Schema } from 'effect'
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const Refusal = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
  retry: Schema.optionalKey(Schema.String),
  retryAfter: Schema.optionalKey(Schema.Number),
})
const Envelope = Schema.Struct({
  result: Schema.optionalKey(
    Schema.Struct({
      content: Schema.optionalKey(Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) }))),
      isError: Schema.optionalKey(Schema.Boolean),
    }),
  ),
})
const Balance = Schema.Struct({ result: Schema.String })

export interface Board {
  origin: string
  mcp: string
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'

/** Written whole or not at all (a temporary file renamed over it), readable by its owner only. */
export function secretFile(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, json(value), { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
}

/**
 * A tool's refusal, with the board's code and its retry advice when it gave them (`same-key`: call again later with
 * the same operationKey; `new-key`: the key is spent; `after-operator`: the operator has to act first).
 */
export class McpToolError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly retry: string | undefined,
    readonly retryAfter: number | undefined,
    readonly serverMessage?: string,
  ) {
    super(message)
  }
}

function refusal(name: string, text: string, status: number): McpToolError {
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    // Not JSON: the message carries the text alone.
  }
  const none: typeof Refusal.Type = {}
  const reply = Option.getOrElse(Schema.decodeUnknownOption(Refusal)(parsed), () => none)
  return new McpToolError(
    `${name}: ${text.slice(0, 200) || status}`,
    reply.code,
    reply.retry,
    reply.retryAfter,
    reply.message,
  )
}

/** One MCP tool call as the connection's agent (JSON-RPC over the board's /mcp; no session needed). */
export async function mcpCall<T = unknown>(
  mcp: string,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(mcp, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  const body = Schema.decodeUnknownSync(Envelope)(await res.json())
  const text = body.result?.content?.[0]?.text ?? ''
  if (body.result?.isError === true || !res.ok) throw refusal(name, text, res.status)
  const parsed: unknown = JSON.parse(text)
  if (Schema.is(Schema.Struct({ ok: Schema.Literal(false) }))(parsed)) throw refusal(name, text, res.status)
  const inner = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Struct({ result: Schema.Unknown }))(parsed))
  // SAFETY: the tool's reply shape is the caller's contract with the board; T names what that tool returns.
  return (inner?.result ?? parsed) as T
}

/** The sponsor relay's MON: below a floor the board refuses sponsored sends, so a run would only fail. */
export async function relayMon(rpc: string, relay: string): Promise<number> {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [relay, 'latest'] }),
  })
  const { result } = Schema.decodeUnknownSync(Balance)(await res.json())
  return Number(BigInt(result) / 10n ** 14n) / 10_000
}

/** Read-only list calls are safe to retry with the exact arguments; writes never pass through this helper. */
export async function readTaskList<T>(mcp: string, token: string, args: Record<string, unknown>): Promise<T[]> {
  let last: unknown
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await mcpCall(mcp, token, 'list_tasks', args)
      if (!Array.isArray(result)) throw new Error('list_tasks: invalid read result; retry the same arguments')
      // SAFETY: task elements retain the board tool contract; the array container is checked above.
      return result as T[]
    } catch (error) {
      last = error
      if (attempt === 1 && error instanceof McpToolError && error.retry === 'read') continue
      throw error
    }
  }
  throw last
}

/** A cursor rejection permits a diagnostic read, never an acknowledgement of a shortened history window. */
export async function inboxAfter<T>(mcp: string, token: string, cursor?: string): Promise<T> {
  try {
    const page = await mcpCall<T>(mcp, token, 'inbox', cursor === undefined ? {} : { cursor })
    if (Schema.is(Schema.Struct({ gap: Schema.Literal(true) }))(page))
      throw new Error('inbox recovery required: retention gap; checkpoint unchanged')
    return page
  } catch (error) {
    if (
      cursor === undefined ||
      !(error instanceof McpToolError) ||
      error.code !== 'invalid' ||
      error.serverMessage !== 'cursor must be a value returned by inbox'
    )
      throw error
    await mcpCall<T>(mcp, token, 'inbox', {})
    throw new Error(
      'inbox recovery required: cursor rejected; seven-day diagnostic cannot acknowledge retained events; checkpoint unchanged',
      { cause: error },
    )
  }
}
