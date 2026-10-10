/** `bun test crew/bin/hosted-mcp.test.ts`: the shared MCP client's replies, refusals and secret files, without a board. */
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpToolError, mcpCall, readToken, secretFile } from './hosted-mcp.ts'

const fetchSpy = spyOn(globalThis, 'fetch')
afterEach(() => {
  fetchSpy.mockReset()
})

/** A board that answers one tools/call with `text`, flagged as an error or not. */
function board(text: string, isError = false, status = 200) {
  fetchSpy.mockResolvedValue(new Response(JSON.stringify({ result: { content: [{ text }], isError } }), { status }))
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

  it('writes secret files whole and owner-only, and reads a token back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hosted-mcp-'))
    try {
      const path = join(dir, 'nested', 'token.json')
      const token = { access_token: 'a', refresh_token: 'r', expires_at: 1, agent_id: '7', scope: 'sidequest:read' }
      secretFile(path, token)
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(token)
      expect(readToken(path)).toEqual(token)
      expect(readToken(join(dir, 'missing.json'))).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
