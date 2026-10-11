import { expect, it } from 'vitest'
import { mcpLogLine } from '../src/mcp-log.ts'
import type { OAuthGrant } from '../src/oauth.ts'

const grant: OAuthGrant = {
  owner: 'operator',
  address: '0x1111111111111111111111111111111111111111',
  chainId: 10143,
  scopes: ['sidequest:read', 'sidequest:hire'],
  agentIds: ['a1'],
  registryAgentId: '7',
  clientId: 'client-1',
  resource: 'https://sidequest.test/mcp',
  grantId: 'oauth_family',
  listening: true,
}
const modern = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' }
const call = (name: string, extra: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: { brief: 'secret brief text' }, _meta: modern, ...extra },
})
const line = (request: unknown, body: unknown, status = 200) =>
  mcpLogLine({ request, reply: { status, body }, grant, ms: 12 })

it('names the method, tool, lane, ending and connection, and nothing the client wrote', () => {
  const ok = line(call('create_task'), { result: { content: [{ text: '{"ok":true}' }], resultType: 'complete' } })
  expect(ok).toEqual({
    event: 'mcp',
    method: 'tools/call',
    tool: 'create_task',
    protocol: '2026-07-28',
    status: 200,
    outcome: 'ok',
    ms: 12,
    grantId: 'oauth_family',
    clientId: 'client-1',
    setup: false,
    listening: true,
  })
  expect(JSON.stringify(ok)).not.toContain('secret')
  expect(line({ method: 'tools/list', params: {} }, { result: { tools: [] } }).protocol).toBe('legacy')
  expect(line(call('Drop <script>'), { result: {} }).tool).toBe('other')
})

it('tells each way a request can end apart', () => {
  expect(line(call('apply'), { result: { resultType: 'input_required' } }).outcome).toBe('input_required')
  expect(
    line(call('create_task'), {
      result: { isError: true, structuredContent: { code: 'role-required' }, content: [{ text: 'role-required: …' }] },
    }).outcome,
  ).toBe('tool-error:role-required')
  expect(
    line(call('apply'), { result: { isError: true, content: [{ text: 'waiting: your operator…' }] } }).outcome,
  ).toBe('tool-error:waiting')
  expect(line(call('get_task'), { result: { isError: true, content: [{ text: '{"ok":false}' }] } }).outcome).toBe(
    'tool-error',
  )
  expect(line(call('x402_pay'), { error: { code: -32003 } }, 403).outcome).toBe('insufficient_scope')
  expect(line(call('x402_pay'), { error: { code: -32602 } }).outcome).toBe('rpc-error:-32602')
  expect(line({ method: 'tools/list' }, { ok: false }, 401).outcome).toBe('unauthenticated')
  expect(
    mcpLogLine({
      request: { method: 'subscriptions/listen' },
      reply: { status: 200, listen: { subscriptionId: 1, notifications: {} } },
      grant: null,
      ms: 3,
    }),
  ).toEqual({ event: 'mcp', method: 'subscriptions/listen', protocol: 'legacy', status: 200, outcome: 'listen', ms: 3 })
})
