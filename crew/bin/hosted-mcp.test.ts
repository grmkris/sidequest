/** `bun test crew/bin/hosted-mcp.test.ts`: the shared MCP client's replies, refusals and secret files, without a board. */
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Schema } from 'effect'
import { McpToolError, inboxAfter, mcpCall, readTaskList, secretFile } from './hosted-mcp.ts'

const fetchSpy = spyOn(globalThis, 'fetch')
afterEach(() => {
  fetchSpy.mockReset()
})

/** A board that answers one tools/call with `text`, flagged as an error or not. */
function board(text: string, isError = false, status = 200) {
  fetchSpy.mockImplementation(
    async () => new Response(JSON.stringify({ result: { content: [{ text }], isError } }), { status }),
  )
}

function requestBody(init?: RequestInit) {
  return JSON.parse(Schema.decodeUnknownSync(Schema.String)(init?.body))
}

describe('hosted MCP client', () => {
  it('unwraps a tool result', async () => {
    board(JSON.stringify({ ok: true, result: { address: '0xabc', agentId: '7' } }))
    expect(await mcpCall('https://board.test/mcp', 'token', 'whoami')).toEqual({ address: '0xabc', agentId: '7' })
  })

  it('turns a refusal into an error that carries the board code and retry advice', async () => {
    board(JSON.stringify({ ok: false, code: 'invalid', retry: 'new-key', retryAfter: 30, message: 'spent' }), true)
    const failure = await mcpCall('https://board.test/mcp', 'token', 'pick_quote').catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(McpToolError)
    expect(failure).toMatchObject({
      code: 'invalid',
      retry: 'new-key',
      retryAfter: 30,
      message: expect.stringMatching(/^pick_quote: /),
    })
  })

  it('keeps a refusal that is not JSON as its message alone', async () => {
    board('upstream went away', true, 502)
    const failure = await mcpCall('https://board.test/mcp', 'token', 'get_task').catch((e: unknown) => e)
    expect(failure).toMatchObject({ code: undefined, message: 'get_task: upstream went away' })
  })

  it('writes secret files whole and owner-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hosted-mcp-'))
    try {
      const path = join(dir, 'nested', 'token.json')
      const token = { access_token: 'a', token_type: 'Bearer', refresh_token: 'r', expires_at: 1 }
      secretFile(path, token)
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(token)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

it('retries a transient task read with identical arguments and no write key, preserving an empty success', async () => {
  fetchSpy.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        result: {
          content: [
            {
              text: JSON.stringify({
                ok: false,
                code: 'unavailable',
                retry: 'read',
                message: 'retry this read with the same arguments',
              }),
            },
          ],
          isError: true,
        },
      }),
    ),
  )
  fetchSpy.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        result: {
          content: [{ text: JSON.stringify({ ok: true, result: [] }) }],
        },
      }),
    ),
  )
  const args = { role: 'holder', limit: 20 }
  expect(await readTaskList('https://board.test/mcp', 'token', args)).toEqual([])
  expect(fetchSpy).toHaveBeenCalledTimes(2)
  const bodies = fetchSpy.mock.calls.map(([, init]) => requestBody(init))
  expect(bodies[0]).toEqual(bodies[1])
  expect(bodies[0].params.arguments).toEqual(args)
  expect(bodies[0].params.arguments).not.toHaveProperty('operationKey')
})

it('never treats a failed or malformed task list as an empty successful list', async () => {
  board(JSON.stringify({ ok: false, code: 'unavailable', retry: 'read', message: 'retry read' }))
  const failure = await readTaskList('https://board.test/mcp', 'token', {}).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    code: 'unavailable',
    retry: 'read',
  })
  board(JSON.stringify({ ok: true, result: {} }))
  const malformed = await readTaskList('https://board.test/mcp', 'token', {}).catch((error: unknown) => error)
  expect(malformed).toMatchObject({ message: expect.stringContaining('invalid read result') })
})

it('reports a rejected server cursor after a cursorless diagnostic', async () => {
  fetchSpy.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        result: {
          content: [
            {
              text: JSON.stringify({ ok: false, code: 'invalid', message: 'cursor must be a value returned by inbox' }),
            },
          ],
          isError: true,
        },
      }),
    ),
  )
  fetchSpy.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        result: {
          content: [{ text: JSON.stringify({ ok: true, result: { events: [], cursor: 'v1:968' } }) }],
        },
      }),
    ),
  )
  const failure = await inboxAfter('https://board.test/mcp', 'token', 'v1:9672026-10-15T00:48:08Z').catch(
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({ message: expect.stringContaining('recovery required') })
  const args = fetchSpy.mock.calls.map(([, init]) => requestBody(init).params.arguments)
  expect(args).toEqual([{ cursor: 'v1:9672026-10-15T00:48:08Z' }, {}])
})

it.each(['requestId must be a nonempty string', 'invalid cursor', 'cursor service unavailable'])(
  'does not discard the cursor on unrelated invalid error: %s',
  async (message) => {
    board(JSON.stringify({ ok: false, code: 'invalid', message }), true)
    const failure = await inboxAfter('https://board.test/mcp', 'token', 'v1:7').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(McpToolError)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  },
)

it('reports gap before the wake checker can promote the returned cursor', async () => {
  board(JSON.stringify({ ok: true, result: { events: [], cursor: 'v1:99', gap: true } }))
  const failure = await inboxAfter('https://board.test/mcp', 'token', 'v1:7').catch((error: unknown) => error)
  expect(failure).toMatchObject({ message: expect.stringContaining('retention gap') })
  expect(fetchSpy).toHaveBeenCalledTimes(1)
})
