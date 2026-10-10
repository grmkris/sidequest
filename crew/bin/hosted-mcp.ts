/**
 * A hosted agent's MCP connection, shared by the crew (crew.ts) and the hosted hirers (hosted-hirers.ts): an OAuth
 * login with PKCE that its operator approves on the site, tokens refreshed one at a time (a refresh token works once,
 * and replaying it revokes the grant), and tool calls over the board's /mcp. Callers say where each connection keeps
 * its files; nothing here knows about members or personas.
 */
import { Option, Schema } from 'effect'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Where the operator's browser lands after consent: nothing listens there, so its address is pasted back. */
export const REDIRECT = 'http://127.0.0.1:8765/callback'

const TokenFile = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_at: Schema.Number,
  agent_id: Schema.String,
  scope: Schema.String,
})
export type Token = typeof TokenFile.Type
const ClientFile = Schema.Struct({ clientId: Schema.String })
const LoginFile = Schema.Struct({ verifier: Schema.String, state: Schema.String })
/** What /oauth/token answers: a token (its agent as a number or a string), or an error. */
const TokenReply = Schema.Struct({
  access_token: Schema.optionalKey(Schema.String),
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
  agent_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  scope: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  error_description: Schema.optionalKey(Schema.String),
})
type TokenReply = typeof TokenReply.Type
const Registration = Schema.Struct({
  client_id: Schema.optionalKey(Schema.String),
  error_description: Schema.optionalKey(Schema.String),
})
const Refusal = Schema.Struct({
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

/** One connection's OAuth files: its registered client, a pending login, its token and the refresh lock. */
export interface ConnectionFiles {
  client: string
  login: string
  token: string
  lock: string
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

/** A JSON file read as `schema`, or undefined when there is none. */
function readFile<S extends Schema.ConstraintDecoder<unknown>>(schema: S, path: string): S['Type'] | undefined {
  return existsSync(path) ? Schema.decodeUnknownSync(schema)(JSON.parse(readFileSync(path, 'utf8'))) : undefined
}

export const readToken = (path: string): Token | undefined => readFile(TokenFile, path)
const readClient = (path: string) => readFile(ClientFile, path)

async function oauthForm(board: Board, path: string, body: Record<string, string>): Promise<TokenReply> {
  const res = await fetch(`${board.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
  const reply = Schema.decodeUnknownSync(TokenReply)(await res.json())
  if (!res.ok) throw new Error(`${path}: ${res.status} ${reply.error_description ?? reply.error ?? ''}`)
  return reply
}

/**
 * Starts a login: registers the client once, saves a fresh PKCE verifier and state, and returns the address the
 * operator opens on the site to pick the agent and approve.
 */
export async function beginLogin(
  board: Board,
  files: ConnectionFiles,
  { clientName, scopes }: { clientName: string; scopes: string },
): Promise<string> {
  let client = readClient(files.client)
  if (client === undefined) {
    const res = await fetch(`${board.origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: clientName, redirect_uris: [REDIRECT] }),
    })
    const reg = Schema.decodeUnknownSync(Registration)(await res.json())
    if (reg.client_id === undefined) throw new Error(`register: ${reg.error_description ?? res.status}`)
    client = { clientId: reg.client_id }
    secretFile(files.client, client)
  }
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(12).toString('hex')
  secretFile(files.login, { verifier, state })
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: REDIRECT,
    scope: scopes,
    resource: board.mcp,
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  })
  return `${board.origin}/oauth/authorize?${q}`
}

/** Finishes a login from the address the browser landed on, and saves the token. */
export async function finishLogin(board: Board, files: ConnectionFiles, landed: string): Promise<Token> {
  const client = readClient(files.client)
  const pending = readFile(LoginFile, files.login)
  if (client === undefined || pending === undefined) throw new Error('start the login first')
  const url = new URL(landed)
  if (url.searchParams.get('error') !== null) throw new Error(`consent refused: ${url.searchParams.get('error')}`)
  if (url.searchParams.get('state') !== pending.state)
    throw new Error('that address is from a different login; start again')
  const t = await oauthForm(board, '/oauth/token', {
    grant_type: 'authorization_code',
    code: url.searchParams.get('code') ?? '',
    redirect_uri: REDIRECT,
    client_id: client.clientId,
    code_verifier: pending.verifier,
    resource: board.mcp,
  })
  return saveToken(files.token, t)
}

function saveToken(path: string, t: TokenReply): Token {
  if (t.access_token === undefined || t.refresh_token === undefined)
    throw new Error(`token: ${t.error_description ?? t.error ?? 'no token in the reply'}`)
  const token: Token = {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (t.expires_in ?? 3600),
    agent_id: String(t.agent_id),
    scope: t.scope ?? '',
  }
  secretFile(path, token)
  return token
}

/** One refresh at a time per connection: a refresh token works once, and replaying it revokes the grant. */
export async function withTokenLock<T>(lock: string, label: string, work: () => Promise<T>): Promise<T> {
  for (let waited = 0; ; waited += 250) {
    try {
      mkdirSync(lock)
      break
    } catch {
      // A lock older than a minute outlived its holder (a refresh takes seconds); a younger one is still in use.
      const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0)
      if (age > 60_000) rmSync(lock, { recursive: true, force: true })
      else if (waited > 30_000) throw new Error(`${label}: its token lock has been held for 30 s`)
      else await Bun.sleep(250)
    }
  }
  try {
    return await work()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

/** A token that stays valid for at least `minSeconds`, refreshed under the lock when it would not. */
export async function freshToken(
  board: Board,
  files: ConnectionFiles,
  minSeconds: number,
  label: string,
): Promise<Token> {
  return withTokenLock(files.lock, label, async () => {
    const t = readToken(files.token)
    const client = readClient(files.client)
    if (t === undefined || client === undefined) throw new Error(`${label} is not connected; run "login ${label}"`)
    if (t.expires_at - Math.floor(Date.now() / 1000) > minSeconds) return t
    return saveToken(
      files.token,
      await oauthForm(board, '/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id: client.clientId,
        resource: board.mcp,
      }),
    )
  })
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
  return new McpToolError(`${name}: ${text.slice(0, 200) || status}`, reply.code, reply.retry, reply.retryAfter)
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
