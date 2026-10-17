import { Ajv } from 'ajv'
import { expect, it } from 'vitest'
import { normalizeOpenUI } from '@sidequest/sdk/commons-ui/openui'
import { commonsTools } from '../src/commons/tools.ts'
import { mcpRoute } from '../src/mcp.ts'
import { COMMONS_UI_URI, commonsResource } from '../src/mcp-commons.ts'
import type { OAuthGrant } from '../src/oauth.ts'

const origin = 'https://sidequest.test'
const grant: OAuthGrant = {
  owner: 'operator',
  address: '0x1111111111111111111111111111111111111111',
  chainId: 10143,
  scopes: ['sidequest:read'],
  agentIds: ['fixture-agent'],
  registryAgentId: '7',
  clientId: 'fixture',
  resource: `${origin}/mcp`,
}
async function route(method: string, params: Record<string, unknown> = {}, output: unknown = {}) {
  const reply = await mcpRoute({
    method: 'POST',
    pathname: '/mcp',
    origin,
    headers: {},
    grant,
    body: { jsonrpc: '2.0', id: 1, method, params },
    tools: commonsTools,
    call: async () => output,
  })
  expect(reply.status).toBe(200)
  // SAFETY: the real route returned HTTP 200 for the known JSON-RPC method above; assertions inspect its result.
  return (reply.body as { result: Record<string, unknown> }).result
}

it('discovers and reads the versioned, self-contained Commons App', async () => {
  expect((await route('resources/list')).resources).toContainEqual({
    uri: COMMONS_UI_URI,
    name: 'Commons plans',
    mimeType: 'text/html;profile=mcp-app',
  })
  expect((await route('resources/read', { uri: COMMONS_UI_URI })).contents).toEqual([commonsResource])
  expect(commonsResource._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: [], frameDomains: [] })
  expect(commonsResource.text).toContain("connect-src 'none'")
  expect(commonsResource.text).toContain("script-src 'sha256-")
})

it('advertises the App only on thread reads and validates attachments in structured output', async () => {
  // SAFETY: tools/list returns the route's tool registry; assertions below verify the relevant metadata and schema.
  const listed = (await route('tools/list')).tools as Array<{
    name: string
    _meta?: Record<string, unknown>
    outputSchema: Record<string, unknown>
  }>
  const thread = listed.find((tool) => tool.name === 'list_messages')!
  expect(thread._meta).toMatchObject({ ui: { resourceUri: COMMONS_UI_URI }, 'openai/outputTemplate': COMMONS_UI_URI })
  expect(listed.find((tool) => tool.name === 'list_roadmap')?._meta).toBeUndefined()
  const presentation = normalizeOpenUI(
    'root = Plan("Review", "Read the evidence.", [AskQuestion("Ready?", ["Yes", "Revise"])])',
  )
  const output = {
    ok: true,
    result: {
      subject: 'lobby',
      messages: [
        {
          id: 1,
          subject: 'lobby',
          author: grant.address,
          body: 'Review this plan.',
          presentation,
          badges: [],
          mentions: [],
          replyTo: null,
          hidden: null,
          createdAt: 1,
        },
      ],
      cursor: null,
      hasMore: false,
      nextPollSeconds: 10,
      viewer: null,
    },
  }
  const reply = await route('tools/call', { name: 'list_messages', arguments: { subject: 'lobby' } }, output)
  expect(reply.structuredContent).toEqual(output)
  const validate = new Ajv({ strict: false }).compile(thread.outputSchema)
  expect(validate(reply.structuredContent), JSON.stringify(validate.errors)).toBe(true)
  const invalid = {
    ...output,
    result: {
      ...output.result,
      messages: [{ ...output.result.messages[0], presentation: { ...presentation, version: 99 } }],
    },
  }
  expect(validate(invalid)).toBe(false)
})
