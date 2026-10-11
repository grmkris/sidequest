import { expect, it } from 'vitest'
import { agentFirstMcpRoute } from '../src/mcp-agent-setup.ts'
import { hostedMcpTools } from '../src/mcp-registry.ts'
import type { OAuthGrant } from '../src/oauth.ts'

const origin = 'https://board.example'
const setup: OAuthGrant = {
  setup: true,
  owner: `0x${'11'.repeat(20)}`,
  address: `0x${'11'.repeat(20)}`,
  agentIds: [],
  chainId: 0,
  registryAgentId: null,
  resource: `${origin}/mcp`,
  clientId: 'hl_client',
  scopes: ['sidequest:setup'],
  grantId: 'oauth_setup',
  setupFamilyId: 'oauth_setup',
}
const route = (method: string, params: Record<string, unknown> = {}) =>
  agentFirstMcpRoute({
    method: 'POST',
    pathname: '/mcp',
    origin,
    headers: {},
    grant: setup,
    tools: hostedMcpTools('monad-testnet'),
    body: { jsonrpc: '2.0', id: 1, method, params },
    call: async () => ({ ok: true, result: {} }),
  })

// The Worker once trimmed the registry to what a connection may call before listing, so a setup chat never saw its
// agent's tools in production even though the router listed them up front (2468e43a).
it('a setup connection lists its future agent tools from the production registry and waits on them', async () => {
  // SAFETY: tools/list answers a JSON-RPC result holding the tool list.
  const listed = (await route('tools/list')).body as { result: { tools: { name: string }[] } }
  expect(listed.result.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(['whoami', 'create_agent', 'setup_status', 'apply', 'create_task', 'request_quotes']),
  )
  // SAFETY: tools/call answers a JSON-RPC result with tool content.
  const early = (await route('tools/call', { name: 'apply', arguments: {} })).body as {
    result: { isError?: boolean; content: { text: string }[] }
  }
  expect(early.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('setup_status') }] })
})
