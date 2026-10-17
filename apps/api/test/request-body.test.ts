import { expect, it } from 'vitest'
import { MAX_API_BODY_BYTES, readRequestBody } from '../src/request-body.ts'

function request(chunks: Uint8Array[], headers?: Record<string, string>, cancel?: () => void) {
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++]
      if (chunk === undefined) controller.close()
      else controller.enqueue(chunk)
    },
    ...(cancel === undefined ? {} : { cancel }),
  })
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    body,
    duplex: 'half',
    ...(headers === undefined ? {} : { headers }),
  }
  return new Request('https://sidequest.test/mcp', init)
}

it('counts bytes across chunks, accepts the exact boundary and preserves split UTF-8', async () => {
  const bytes = new TextEncoder().encode('hi 🌱')
  const result = await readRequestBody(request([bytes.slice(0, 5), bytes.slice(5)]), bytes.length)
  expect(result).toEqual({ ok: true, bytes })
})

it('cancels a chunked body at overflow, including when its declared length understates it', async () => {
  for (const headers of [undefined, { 'content-length': '1' }]) {
    let cancelled = false
    const result = await readRequestBody(
      request([new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)], headers, () => {
        cancelled = true
      }),
      7,
    )
    expect(result).toMatchObject({ ok: false, status: 413 })
    expect(cancelled).toBe(true)
  }
})

it('rejects an oversized declared body without consuming it', async () => {
  const source = new Request('https://sidequest.test', {
    method: 'POST',
    body: 'small',
    headers: { 'content-length': '100' },
  })
  expect(await readRequestBody(source, 10)).toMatchObject({ ok: false, status: 413 })
  expect(source.bodyUsed).toBe(true)
})

it('keeps existing base64 sample uploads within the API envelope limit', async () => {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'upload_sample', arguments: { image: 'A'.repeat(4 * Math.ceil((1024 * 1024) / 3)) } },
  })
  const result = await readRequestBody(
    new Request('https://sidequest.test/mcp', { method: 'POST', body }),
    MAX_API_BODY_BYTES,
  )
  expect(result.ok).toBe(true)
})

it('returns a bounded diagnostic for an interrupted upload', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('private transport diagnostic'))
    },
  })
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half' }
  const source = new Request('https://sidequest.test', init)
  expect(await readRequestBody(source, 10)).toEqual({
    ok: false,
    status: 400,
    message: 'Request body could not be read',
  })
})

it('answers 400 when the body stream is already locked', async () => {
  const source = request([new Uint8Array([1])])
  const held = source.body?.getReader()
  expect(await readRequestBody(source, 10)).toEqual({
    ok: false,
    status: 400,
    message: 'Request body could not be read',
  })
  held?.releaseLock()
})
