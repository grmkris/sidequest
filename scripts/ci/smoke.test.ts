import { expect, test } from 'bun:test'
import { expectedRelease, smoke } from './smoke.ts'
import {
  catalogReply,
  serverCardReply,
  registryProofReply,
  type McpMetadataReply,
} from '../../apps/api/src/mcp-metadata.ts'
import registryProof from '../../apps/api/src/mcp-registry-proof.json' with { type: 'json' }

const origin = 'https://dev.sidequest.exchange'
const NOW = 1_791_400_000_000
const docsHtml = (script = '<script nonce="n1">self.__TSR=1</script>') =>
  `<!DOCTYPE html><html><head><link rel="stylesheet" href="/docs/_assets/app-x.css"/><meta name="generator" content="sidequest-docs"/>${script}<script nonce="n1" type="module" src="/docs/_assets/a.js"></script></head><body>Connect an agent</body></html>`
const docsHeaders = {
  'content-type': 'text/html; charset=utf-8',
  vary: 'Accept',
  'content-security-policy': "default-src 'self'; script-src 'self' 'nonce-n1'; style-src 'self' 'unsafe-inline'",
}
const docsMarkdown = '# Connect an agent\n\n> Add Sidequest to an MCP client.\n'
/** The docs responses a healthy Explore gives; a test replaces one to make it fail. */
const docsResponses = (): Record<string, (accept: string | null) => Response> => ({
  '/docs/quickstart': (accept) =>
    accept === 'text/markdown'
      ? new Response(docsMarkdown, { headers: { 'content-type': 'text/markdown; charset=utf-8', vary: 'Accept' } })
      : new Response(docsHtml(), { headers: docsHeaders }),
  '/docs/quickstart.md': () =>
    new Response(docsMarkdown, { headers: { 'content-type': 'text/markdown; charset=utf-8' } }),
  '/docs/_assets/app-x.css': () => new Response('body{}', { headers: { 'content-type': 'text/css' } }),
  '/llms.txt': () =>
    new Response(`# Sidequest\n\n> An open job protocol.\n\n- [Set yourself up](${origin}/start.md)\n`),
  '/docs/search.json': () => Response.json({ type: 'advanced' }),
  '/docs/not-a-page': () => new Response('not found', { status: 404 }),
})

const metadataReplies: Record<string, (headers: Record<string, string>) => McpMetadataReply> = {
  '/mcp/server-card': (headers) => serverCardReply(origin, '', headers),
  '/b/public/mcp/server-card': (headers) => serverCardReply(origin, '/b/public', headers),
  '/.well-known/ai-catalog.json': (headers) => catalogReply(origin, headers),
  '/.well-known/mcp-registry-auth': () => registryProofReply(registryProof.proof),
}

const metadataFixture = (
  pathname: string,
  init: RequestInit | undefined,
  badPath: string | undefined,
  override: object | undefined,
) => {
  const reply = metadataReplies[pathname]?.(Object.fromEntries(new Headers(init?.headers)))
  if (reply === undefined) return undefined
  if (pathname === badPath) return Response.json(override)
  return new Response(reply.status === 304 ? null : reply.body, { status: reply.status, headers: reply.headers })
}

const transport = (
  badPath?: string,
  override?: object,
  docs: Record<string, (accept: string | null) => Response> = docsResponses(),
): { fetcher: typeof fetch; methods: string[] } => {
  const methods: string[] = []
  const fetcher = (async (input, init) => {
    const pathname = new URL(String(input)).pathname
    const doc = docs[pathname]
    if (doc !== undefined) return doc(new Headers(init?.headers).get('accept'))
    if (pathname === '/icons/icon-512.png')
      return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } })
    const metadata = metadataFixture(pathname, init, badPath, override)
    if (metadata !== undefined) return metadata
    if (pathname === '/mcp') {
      expect(init?.method).toBe('POST')
      const request = JSON.parse(String(init?.body)) as { method: string }
      methods.push(request.method)
      return new Response('{}', {
        status: badPath === pathname ? 200 : 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="test"' },
      })
    }
    const documents: Record<string, object> = {
      '/health': { ok: true, runtime: 'Cloudflare-Workers', network: 'monad-testnet', board: 'public' },
      '/release.json': { network: 'monad-testnet', mainnetLive: false, writesOpen: true },
      '/.well-known/oauth-protected-resource': { resource: `${origin}/mcp`, authorization_servers: [origin] },
      '/.well-known/oauth-authorization-server': { issuer: origin },
      '/data/jobs': { ok: true, index: { next_block: 1, updated_at: NOW / 1000 - 60 }, jobs: [] },
    }
    return Response.json(pathname === badPath ? override : documents[pathname])
  }) as typeof fetch
  return { fetcher, methods }
}

test('smoke checks both anonymous method-specific MCP requests', async () => {
  const fake = transport()
  await smoke('dev', fake.fetcher, () => NOW)
  expect(fake.methods).toEqual(['initialize', 'tools/list'])
})

test('smoke rejects cards replaced by HTML, invalid catalog and missing public proof', async () => {
  for (const [path, message] of [
    ['/mcp/server-card', 'MCP Server Card missing'],
    ['/b/public/mcp/server-card', 'MCP Server Card missing'],
    ['/.well-known/ai-catalog.json', 'AI Catalog missing'],
    ['/.well-known/mcp-registry-auth', 'MCP Registry public proof missing'],
  ] as const)
    expect(await failure(smoke('dev', transport(path, {}).fetcher, () => NOW))).toBe(message)
})

test('smoke refuses an unexpected runtime, closed writes, foreign issuer or missing bearer challenge', async () => {
  for (const [path, override] of [
    ['/health', { ok: true, runtime: 'local', network: 'monad-testnet', board: 'public' }],
    ['/release.json', { network: 'monad-testnet', mainnetLive: false, writesOpen: false }],
    ['/.well-known/oauth-authorization-server', { issuer: 'https://foreign.example' }],
    [
      '/.well-known/oauth-protected-resource',
      { resource: `${origin}/mcp`, authorization_servers: ['https://foreign.example'] },
    ],
  ] as const)
    await expect(smoke('dev', transport(path, override).fetcher, () => NOW)).rejects.toThrow('mismatch')
  await expect(smoke('dev', transport('/mcp').fetcher, () => NOW)).rejects.toThrow('challenge mismatch')
})

test('a drained mainnet build serves closed writes, and smoke expects exactly what the pin says', () => {
  expect(expectedRelease('monad-mainnet', false)).toEqual({
    network: 'monad-mainnet',
    mainnetLive: false,
    writesOpen: false,
  })
  expect(expectedRelease('monad-mainnet', true)).toMatchObject({ mainnetLive: true, writesOpen: true })
  expect(expectedRelease('monad-testnet', false)).toMatchObject({ writesOpen: true })
})

const failure = (run: Promise<void>): Promise<string> =>
  run.then(
    () => 'passed',
    (error: unknown) => (error instanceof Error ? error.message : 'unknown'),
  )

test('smoke refuses an unbuilt or stalled index', async () => {
  const unbuilt = { ok: false, code: 'unavailable', message: 'the index is not built yet' }
  expect(await failure(smoke('dev', transport('/data/jobs', unbuilt).fetcher, () => NOW))).toBe(
    'indexer checkpoint missing',
  )
  const stale = { ok: true, index: { next_block: 1, updated_at: NOW / 1000 - 3600 }, jobs: [] }
  expect(await failure(smoke('dev', transport('/data/jobs', stale).fetcher, () => NOW))).toBe(
    'indexer checkpoint is 3600 s old',
  )
})

test('smoke checks the docs: nonced scripts, the linked stylesheet, Markdown on Accept, llms.txt, search and 404', async () => {
  expect(await failure(smoke('dev', transport().fetcher, () => NOW))).toBe('passed')
  const broken = (path: string, response: (accept: string | null) => Response) => {
    const docs = docsResponses()
    docs[path] = response
    return failure(smoke('dev', transport(undefined, undefined, docs).fetcher, () => NOW))
  }
  expect(
    await broken(
      '/docs/quickstart',
      () => new Response(docsHtml('<script>inline()</script>'), { headers: docsHeaders }),
    ),
  ).toBe('docs scripts without a nonce: 1')
  expect(
    await broken(
      '/docs/quickstart',
      () =>
        new Response(docsHtml(), {
          headers: { ...docsHeaders, 'content-security-policy': "script-src 'self' 'nonce-n1' 'unsafe-inline'" },
        }),
    ),
  ).toBe('docs script policy mismatch')
  expect(
    await broken(
      '/docs/quickstart',
      () => new Response(docsHtml().replace('sidequest-docs', 'x'), { headers: docsHeaders }),
    ),
  ).toBe('docs page missing')
  expect(await broken('/docs/_assets/app-x.css', () => new Response('not found', { status: 404 }))).toBe(
    'docs stylesheet HTTP 404',
  )
  expect(await broken('/docs/quickstart.md', () => new Response('# Something else\n'))).toBe(
    'docs Markdown negotiation mismatch',
  )
  expect(
    await broken(
      '/llms.txt',
      () => new Response('# Sidequest\n\n- [Set yourself up](https://elsewhere.example/start.md)\n'),
    ),
  ).toBe('llms.txt mismatch')
  expect(await broken('/docs/not-a-page', () => new Response('<html>app shell</html>', { status: 200 }))).toBe(
    'docs missing page HTTP 200',
  )
})
