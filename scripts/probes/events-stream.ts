#!/usr/bin/env bun
/**
 * Watches one Sidequest event over MCP Events push delivery (`events/stream`) and prints one JSON line per frame, so
 * any host that wakes on a command's output (Claude Code's Monitor tool, a supervisor loop) can react the moment
 * something happens. Reconnects with its last cursor when the stream ends (the server caps a stream at one hour).
 *
 *   SIDEQUEST_TOKEN=… bun scripts/probes/events-stream.ts [event] ['{"arguments":"json"}']
 *   SIDEQUEST_TOKEN_FILE=token.json …   reads `access_token` from an OAuth token file instead
 *
 * SIDEQUEST_MCP defaults to https://dev.sidequest.exchange/mcp; the event to `sidequest.inbox`. STREAM_SECONDS ends
 * the watch after that long (for a probe); without it the watch runs until stopped.
 */
import { readFileSync } from 'node:fs'

const MCP = process.env.SIDEQUEST_MCP ?? 'https://dev.sidequest.exchange/mcp'
const name = process.argv[2] ?? 'sidequest.inbox'
// SAFETY: the second argument is the event's arguments as a JSON object.
const args = JSON.parse(process.argv[3] ?? '{}') as Record<string, unknown>
const file = process.env.SIDEQUEST_TOKEN_FILE
// SAFETY: an OAuth token file is JSON with an access_token string.
const token =
  file === undefined
    ? process.env.SIDEQUEST_TOKEN
    : (JSON.parse(readFileSync(file, 'utf8')) as { access_token: string }).access_token
if (token === undefined || token === '') throw new Error('Set SIDEQUEST_TOKEN or SIDEQUEST_TOKEN_FILE')
const deadline =
  process.env.STREAM_SECONDS === undefined ? Infinity : Date.now() + Number(process.env.STREAM_SECONDS) * 1000
const VERSION = '2026-07-28'
const line = (value: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...value }))

interface Frame {
  method?: string
  params?: { cursor?: string | null }
  result?: unknown
}

/** The payload of one SSE event: its `data:` lines joined. */
const dataOf = (event: string) =>
  event
    .split('\n')
    .filter((row) => row.startsWith('data:'))
    .map((row) => row.slice(5).trim())
    .join('')

/** The JSON-RPC messages of an SSE body, one per `data:` event. */
async function* messages(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
    for (const data of events.map(dataOf).filter((text) => text !== ''))
      // SAFETY: every data event is one JSON-RPC message.
      yield JSON.parse(data) as Frame
  }
}

/** Opens one `events/stream` request from `cursor`. */
function open(cursor: string | null, id: number, signal: AbortSignal) {
  return fetch(MCP, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'mcp-protocol-version': VERSION,
      'mcp-method': 'events/stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'events/stream',
      params: {
        name,
        arguments: args,
        cursor,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  })
}

/** One stream from `cursor`; returns the last cursor it saw, so the next stream resumes there. */
async function stream(cursor: string | null, id: number): Promise<string | null> {
  const abort = new AbortController()
  const stop = setTimeout(() => abort.abort(), Math.max(0, deadline - Date.now()))
  let last = cursor
  try {
    const res = await open(cursor, id, abort.signal)
    if (res.body === null || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      line({ refused: res.status, body: await res.text() })
      process.exit(1)
    }
    for await (const frame of messages(res.body)) {
      last = frame.params?.cursor ?? last
      line({ method: frame.method ?? 'result', params: frame.params ?? frame.result })
    }
  } catch (error) {
    if (!abort.signal.aborted) line({ disconnected: String(error) })
  }
  clearTimeout(stop)
  return last
}

let cursor: string | null = null
for (let id = 1; Date.now() < deadline; id++) {
  cursor = await stream(cursor, id)
  if (Date.now() < deadline) await new Promise((done) => setTimeout(done, 1000))
}
