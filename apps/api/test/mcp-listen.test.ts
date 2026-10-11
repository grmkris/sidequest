import { Schema } from 'effect'
import { expect, it } from 'vitest'
import { McpListeners } from '../src/mcp-listen.ts'

const decoder = new TextDecoder()
const message = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

/** Reads the frames a stream has produced so far, as parsed JSON-RPC messages or comments. */
async function frames(reader: ReadableStreamDefaultReader<Uint8Array>, count: number) {
  const seen: Array<Record<string, unknown> | 'comment'> = []
  let buffer = ''
  while (seen.length < count) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value)
    for (const block of buffer.split('\n\n').slice(0, -1))
      seen.push(block.startsWith(':') ? 'comment' : message(block.slice('data: '.length)))
    buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2)
  }
  return seen
}
const meta = (id: string | number) => ({ _meta: { 'io.modelcontextprotocol/subscriptionId': id } })

it('acknowledges first, says the tools changed at once, and pushes each later change', async () => {
  const listeners = new McpListeners({ now: () => 1_000 })
  const response = listeners.open('grant-a', { subscriptionId: 7, notifications: { toolsListChanged: true } }, 'v1')
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  const reader = response.body!.getReader()
  expect(await frames(reader, 2)).toEqual([
    {
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: { notifications: { toolsListChanged: true }, ...meta(7) },
    },
    { jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: meta(7) },
  ])
  expect(listeners.listening('grant-a')).toBe(true)
  expect(listeners.listening('grant-b')).toBe(false)
  listeners.toolsChanged(['grant-b', 'grant-a'])
  expect(await frames(reader, 1)).toEqual([
    { jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: meta(7) },
  ])
})

it('acknowledges only what it honours, and a stream without tools never hears tool changes', async () => {
  const listeners = new McpListeners({ now: () => 1_000 })
  const reader = listeners.open('grant-a', { subscriptionId: 'r1', notifications: {} }, 'v1').body!.getReader()
  expect(await frames(reader, 1)).toEqual([
    {
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: { notifications: {}, ...meta('r1') },
    },
  ])
  expect(listeners.listening('grant-a')).toBe(false)
  listeners.toolsChanged(['grant-a'])
  listeners.keepalive()
  expect(await frames(reader, 1)).toEqual(['comment'])
})

it('ends a disconnected connection with a final response and stops treating it as listening', async () => {
  const listeners = new McpListeners({ now: () => 1_000 })
  const reader = listeners
    .open('grant-a', { subscriptionId: 9, notifications: { toolsListChanged: true } }, 'v1')
    .body!.getReader()
  await frames(reader, 2)
  listeners.close(['grant-a'])
  expect(await frames(reader, 2)).toEqual([{ jsonrpc: '2.0', id: 9, result: { resultType: 'complete', ...meta(9) } }])
  expect((await reader.read()).done).toBe(true)
  expect(listeners.listening('grant-a')).toBe(false)
})

it('closes streams past their lifetime abruptly, and gives way to a fifth stream on one connection', async () => {
  let now = 1_000
  const listeners = new McpListeners({ now: () => now, lifetimeMs: 60_000 })
  const readers = [1, 2, 3, 4, 5].map((id) =>
    listeners
      .open('grant-a', { subscriptionId: id, notifications: { toolsListChanged: true } }, 'v1')
      .body!.getReader(),
  )
  await frames(readers[0]!, 2)
  expect((await readers[0]!.read()).done).toBe(true)
  now += 60_000
  listeners.keepalive()
  for (const reader of readers.slice(1)) {
    await frames(reader, 2)
    expect((await reader.read()).done).toBe(true)
  }
  expect(listeners.listening('grant-a')).toBe(false)
})

it('tells a connection its tools changed only when its access did, ends a gone one, and forgets a cancelled stream', async () => {
  const listeners = new McpListeners({ now: () => 1_000 })
  const open = (grant: string, id: number) =>
    listeners.open(grant, { subscriptionId: id, notifications: { toolsListChanged: true } }, 'work').body!.getReader()
  const [a, b] = [open('grant-a', 1), open('grant-b', 2)]
  await frames(a, 2)
  await frames(b, 2)
  const access: Record<string, string | undefined> = { 'grant-a': 'work', 'grant-b': 'work+hire' }
  listeners.sync((grant) => access[grant])
  listeners.keepalive()
  expect(await frames(a, 1)).toEqual(['comment'])
  expect(await frames(b, 2)).toEqual([
    { jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: meta(2) },
    'comment',
  ])
  delete access['grant-a']
  listeners.sync((grant) => access[grant])
  expect(await frames(a, 1)).toEqual([{ jsonrpc: '2.0', id: 1, result: { resultType: 'complete', ...meta(1) } }])
  await b.cancel()
  expect(listeners.active()).toBe(false)
})
