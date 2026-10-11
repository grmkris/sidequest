import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DOCS, DOCS_ORIGIN_PLACEHOLDER } from '../src/generated/docs.ts'
import { SKILL_MANIFESTS } from '../src/generated/skills.ts'
import { docsResources, readDoc, searchDocs } from '../src/mcp-docs.ts'
import { mcpRoute } from '../src/mcp.ts'
import { requiredToolScope } from '../src/mcp-policy.ts'
import { ROLE_GUIDES } from '../src/mcp-instructions.ts'
import { hiringResource, hiringTools } from '../src/mcp-hiring.ts'
import { tools } from '../src/tools.ts'
import { tenantTools } from '../src/tools-tenant.ts'
import { directoryTools } from '../src/directory.ts'
import { agentTools } from '../src/tools-agents.ts'
import type { OAuthGrant } from '../src/oauth.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const origin = 'https://sidequest.test'
// Reading docs needs a read grant, but never needs a selected managed agent.
const grant: OAuthGrant = {
  owner: 'operator',
  address: '0x1111111111111111111111111111111111111111',
  chainId: 10143,
  scopes: ['sidequest:read'],
  agentIds: [],
  registryAgentId: '7',
  clientId: 'c',
  resource: `${origin}/mcp`,
}
const route = (
  method: string,
  params: Record<string, unknown> = {},
  overrides: Partial<Parameters<typeof mcpRoute>[0]> = {},
) =>
  mcpRoute({
    method: 'POST',
    pathname: '/mcp',
    origin,
    headers: {},
    body: { jsonrpc: '2.0', id: 1, method, params },
    grant,
    tools: {},
    call: vi.fn(),
    ...overrides,
  })
const result = (reply: Awaited<ReturnType<typeof mcpRoute>>) =>
  (reply.body as { result: Record<string, unknown> }).result
const fixturePage = (slug: string, title = '', description = '', markdown = '', heading = '', text = '') => ({
  slug,
  path: `/docs/${slug}`,
  title,
  description,
  markdown,
  sections: heading ? [{ heading, id: slug, text }] : [],
})

describe('docs from the real content pipeline', () => {
  it('keeps the checked-in export current in under twenty seconds', () => {
    const started = performance.now()
    expect(() => execFileSync('node', ['scripts/gen-docs.mjs', '--check'], { cwd: root, stdio: 'pipe' })).not.toThrow()
    expect(performance.now() - started).toBeLessThan(20_000)
  })

  it('appends every MCP-visible page to the existing resources', async () => {
    const oldResources = [
      ...Object.keys(ROLE_GUIDES).map((role) => ({
        uri: `sidequest://skills/${role}`,
        name: role,
        mimeType: 'text/markdown',
      })),
      ...SKILL_MANIFESTS.map((skill) => ({ uri: skill.uri, name: skill.frontmatter.name, mimeType: 'text/markdown' })),
      { uri: hiringResource.uri, name: 'Hiring desk', mimeType: hiringResource.mimeType },
    ]
    const docs = DOCS.map((page) => ({
      uri: `sidequest://docs/${page.slug || 'index'}`,
      name: page.title,
      description: page.description,
      mimeType: 'text/markdown',
    }))
    expect(docsResources()).toEqual(docs)
    expect(result(await route('resources/list')).resources).toEqual([...oldResources, ...docs])
    expect(docs.map((page) => page.uri)).toContain('sidequest://docs/index')
    expect(docs.map((page) => page.uri)).not.toContain('sidequest://docs/reference/addresses')
    expect(DOCS.map((page) => page.slug)).toEqual(DOCS.map((page) => page.slug).toSorted())
  })

  it.each([origin, 'https://dev.sidequest.exchange'])(
    'returns the exact page text with origin %s',
    async (givenOrigin) => {
      for (const page of DOCS) {
        const uri = `sidequest://docs/${page.slug}`
        const text = page.markdown.replaceAll(DOCS_ORIGIN_PLACEHOLDER, givenOrigin)
        expect(readDoc(uri, givenOrigin)).toBe(text)
        expect(result(await route('resources/read', { uri }, { origin: givenOrigin })).contents).toEqual([
          { uri, mimeType: 'text/markdown', text },
        ])
        expect(text).not.toContain(DOCS_ORIGIN_PLACEHOLDER)
      }
      expect(readDoc('sidequest://docs/index', givenOrigin)).toContain(`${givenOrigin}/docs/quickstart.md`)
    },
  )

  it.each([
    'sidequest://docs/nope',
    'sidequest://docs/',
    'sidequest://docs/index/extra',
    'sidequest://docs/reference/addresses',
  ])('reports an unknown docs resource for %s', async (uri) => {
    expect(readDoc(uri, origin)).toBeUndefined()
    expect((await route('resources/read', { uri })).body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32002, message: `Unknown docs resource: ${uri}` },
    })
  })

  it('exports actual section bodies and headings, with only registered backticked tools', () => {
    const hires = DOCS.find((page) => page.slug === 'concepts/hires')!
    const activate = hires.sections.find((section) => section.id === 'activate-and-submit')!
    expect(activate.heading).toBe('Activate and submit')
    expect(activate.text).toContain('reserves the worker bond')
    expect(activate.text).not.toContain('## Review and rejection')
    const registry = new Set([
      'get_instructions',
      'search_docs',
      ...Object.keys(hiringTools),
      ...Object.keys(tools),
      ...Object.keys(tenantTools),
      ...Object.keys(directoryTools),
      ...Object.keys(agentTools),
    ])
    const named = new Set(
      DOCS.flatMap((page) => [...page.markdown.matchAll(/`([a-z]+(?:_[a-z0-9]+)+)`/g)].map((match) => match[1]!)),
    )
    expect([...named].filter((name) => !registry.has(name))).toEqual([])
  })
})

describe('authenticated search_docs', () => {
  it('advertises read scope, read-only idempotent metadata, and no operation key', async () => {
    const listed = result(await route('tools/list')).tools as Record<string, unknown>[]
    const tool = listed.find((entry) => entry.name === 'search_docs')!
    expect(requiredToolScope('search_docs')).toBe('sidequest:read')
    expect(tool).toMatchObject({
      description: expect.stringContaining('resources/read'),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      securitySchemes: [{ type: 'oauth2', scopes: ['sidequest:read'] }],
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
        required: ['query'],
      },
      outputSchema: { type: 'object', additionalProperties: true },
    })
    expect(tool.inputSchema).not.toHaveProperty('properties.operationKey')
  })

  it.each([{}, { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }])(
    'serves real docs search without selecting an agent on both protocol lanes',
    async (meta) => {
      const call = vi.fn()
      const actual = result(
        await route(
          'tools/call',
          { ...meta, name: 'search_docs', arguments: { query: 'activation', limit: 1 } },
          { call },
        ),
      )
      const expected = searchDocs({ query: 'activation', limit: 1 }, origin)
      expect(actual.structuredContent).toEqual(expected)
      expect(JSON.parse((actual.content as { text: string }[])[0]!.text)).toEqual(expected)
      expect(expected.results).toHaveLength(1)
      expect(expected.results[0]).toMatchObject({
        slug: 'concepts/hires',
        uri: 'sidequest://docs/concepts/hires',
        url: `${origin}/docs/concepts/hires`,
        markdownUrl: `${origin}/docs/concepts/hires.md`,
        section: 'Activate and submit',
      })
      expect(call).not.toHaveBeenCalled()
    },
  )

  it('ranks the page a reader means first', () => {
    for (const [query, slug] of [
      ['connect', 'quickstart'],
      ['dispute', 'guides/work'],
      ['admin powers', 'trust'],
      ['backing', 'concepts/bonds-and-staking'],
    ] as const) {
      expect(searchDocs({ query, limit: 1 }, origin).results[0]?.slug).toBe(slug)
    }
  })

  it.each([undefined, '', ' \t\n ', 42])('returns a tool error for an empty or invalid query %s', async (query) => {
    expect(result(await route('tools/call', { name: 'search_docs', arguments: { query } }))).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'query must not be empty' }],
    })
  })

  it('returns no matches for an unknown query and never leaks the origin placeholder', () => {
    expect(searchDocs({ query: 'not-a-document-query-123456' }, origin)).toEqual({
      query: 'not-a-document-query-123456',
      results: [],
    })
    const matches = searchDocs({ query: 'quickstart' }, origin)
    expect(matches.results.length).toBeGreaterThan(0)
    expect(JSON.stringify(matches)).not.toContain(DOCS_ORIGIN_PLACEHOLDER)
    for (const match of matches.results) expect(match.snippet.length).toBeLessThanOrEqual(240)
  })

  it('requires the read scope for search discovery and calling', async () => {
    const hireGrant = { ...grant, scopes: ['sidequest:hire'] }
    expect(
      (result(await route('tools/list', {}, { grant: hireGrant })).tools as { name: string }[]).map(
        (tool) => tool.name,
      ),
    ).not.toContain('search_docs')
    // ADR-0021: calling it anyway is MCP's step-up, asking the client for the read scope.
    const called = await route(
      'tools/call',
      { name: 'search_docs', arguments: { query: 'work' } },
      { grant: hireGrant },
    )
    expect(called.status).toBe(403)
    expect(called.headers?.['www-authenticate']).toContain('scope="sidequest:hire sidequest:read"')
  })

  it.each(['resources/list', 'resources/read', 'tools/list', 'tools/call'])(
    'returns 401 without a grant for %s',
    async (method) => {
      const call = vi.fn()
      const { grant: _grant, ...input } = {
        method: 'POST',
        pathname: '/mcp',
        origin,
        headers: {},
        body: {
          id: 1,
          method,
          params: { uri: 'sidequest://docs/index', name: 'search_docs', arguments: { query: 'work' } },
        },
        grant,
        tools: {},
        call,
      }
      expect((await mcpRoute(input)).status).toBe(401)
      expect(call).not.toHaveBeenCalled()
    },
  )
})

describe('deterministic scoring with connection and ranking fixtures', () => {
  let search: typeof searchDocs
  // The seed quickstart has no connection text. The content lane supplies that prose after merging.
  const fixtures = [
    fixturePage('body', '', '', 'connect connect connect connect connect'),
    fixturePage('description', '', 'connect', 'connect'),
    fixturePage('heading', '', '', 'connect', 'connect'),
    fixturePage('quickstart', 'Connect', '', 'connect', 'Connect your client', 'Open the connection guide.'),
    fixturePage('title', 'connect', '', 'connect'),
    fixturePage('alpha', '', '', 'connect'),
    fixturePage('beta', '', '', 'connect'),
    fixturePage('phrase', 'connect client', '', 'connect client'),
    fixturePage('terms', '', '', 'connect another client'),
    fixturePage('long', '', '', `${'x'.repeat(300)} connect ${'x'.repeat(400)}`),
    ...Array.from({ length: 12 }, (_, i) => fixturePage(`tail-${String(i).padStart(2, '0')}`, '', '', 'connect')),
  ]
  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('../src/generated/docs.ts', () => ({ DOCS: fixtures, DOCS_ORIGIN_PLACEHOLDER }))
    search = (await import('../src/mcp-docs.ts')).searchDocs
  })
  afterAll(() => {
    vi.doUnmock('../src/generated/docs.ts')
    vi.resetModules()
  })

  it('finds quickstart for connect, matches case-insensitively, and breaks ties by slug', () => {
    const matches = search({ query: 'CONNECT', limit: 10 }, origin)
    expect(matches.results[0]).toMatchObject({ slug: 'quickstart', section: 'Connect your client' })
    expect(matches).toEqual(search({ query: 'CONNECT', limit: 10 }, origin))
    expect(matches.results.map((match) => match.slug)).toEqual(
      search({ query: 'connect', limit: 10 }, origin).results.map((match) => match.slug),
    )
    const order = matches.results.map((match) => match.slug)
    expect(order.indexOf('alpha')).toBeLessThan(order.indexOf('beta'))
  })

  it('uses title, heading, description, then capped body weights', () => {
    const order = search({ query: 'connect', limit: 10 }, origin).results.map((match) => match.slug)
    expect(order.indexOf('title')).toBeLessThan(order.indexOf('heading'))
    expect(order.indexOf('heading')).toBeLessThan(order.indexOf('description'))
    // Description+one text hit equals three body hits; alphabetical tie-break chooses body.
    expect(order.indexOf('body')).toBeLessThan(order.indexOf('description'))
  })

  it('matches the whole query and individual terms, with literal punctuation', () => {
    const matches = search({ query: 'connect client', limit: 10 }, origin)
    expect(matches.results.map((match) => match.slug)).toContain('phrase')
    expect(matches.results.map((match) => match.slug)).toContain('terms')
    expect(search({ query: '[connect]' }, origin).results).toEqual([])
  })

  it.each([
    [undefined, 5],
    [0, 1],
    [-5, 1],
    [2.9, 2],
    [30, 10],
    [Number.NaN, 5],
  ])('clamps limit %s to %s', (limit, expected) => {
    const input = limit === undefined ? { query: 'connect' } : { query: 'connect', limit }
    expect(search(input, origin).results).toHaveLength(expected)
  })

  it('bounds long snippets while keeping the match visible', () => {
    const match = search({ query: 'connect', limit: 10 }, origin).results.find((entry) => entry.slug === 'long')!
    expect(match.snippet.length).toBeLessThanOrEqual(240)
    expect(match.snippet).toContain('connect')
  })
})
