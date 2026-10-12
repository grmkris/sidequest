import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { serverCard, catalogReply } from '../../apps/api/src/mcp-metadata.ts'
// By path: scripts/ is not a workspace package, so the bare '@sidequest/sdk' specifier does not resolve here.
import { MAINNET_LIVE } from '../../packages/sdk/src/release.ts'

type Stage = 'dev' | 'prod'
interface StageFile {
  readonly stage: Stage
  readonly network: string
  readonly origin: string
}

const root = resolve(import.meta.dirname, '../..')
const readStage = (stage: Stage): StageFile => {
  const file = JSON.parse(readFileSync(resolve(root, `infra/${stage}.json`), 'utf8')) as Partial<StageFile>
  if (
    file.stage !== stage ||
    typeof file.network !== 'string' ||
    typeof file.origin !== 'string' ||
    !file.origin.startsWith('https://')
  )
    throw new Error(`invalid infra/${stage}.json`)
  return file as StageFile
}

/** What `/release.json` must say, derived as the build derives it (`releaseInfo` in apps/explore/vite.config.ts):
 *  writes open on testnet, and on mainnet only once `MAINNET_LIVE` is true, so a drained mainnet deploy smokes green. */
export const expectedRelease = (network: string, live: boolean = MAINNET_LIVE) => ({
  network,
  mainnetLive: live,
  writesOpen: network !== 'monad-mainnet' || live,
})

const body = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const value: unknown = await response.json()
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('JSON object expected')
    return value as Record<string, unknown>
  } catch {
    throw new Error(`invalid JSON response (HTTP ${response.status})`)
  }
}
/** The indexer's cron runs every minute; a checkpoint older than this means it has stopped. */
const INDEX_MAX_AGE_SECONDS = 600

/** A docs-check fetch: the stage origin, no redirects, 20 s, and an optional Accept. */
type DocsGet = (path: string, accept?: string) => Promise<Response>

const startsWith = (response: Response, type: string): boolean =>
  (response.headers.get('content-type') ?? '').startsWith(type)

/** The prerendered page: the docs marker, Vary: Accept, a nonce policy, every script nonced, its stylesheet served. */
const checkDocsPage = async (get: DocsGet): Promise<void> => {
  const page = await get('/docs/quickstart', 'text/html')
  const html = await page.text()
  if (page.status !== 200 || !startsWith(page, 'text/html') || !html.includes('content="sidequest-docs"'))
    throw new Error('docs page missing')
  if (!/\baccept\b/i.test(page.headers.get('vary') ?? '')) throw new Error('docs Vary: Accept missing')
  const scriptSrc = /(?:^|;)\s*script-src([^;]*)/.exec(page.headers.get('content-security-policy') ?? '')?.[1] ?? ''
  if (!scriptSrc.includes("'nonce-") || scriptSrc.includes("'unsafe-inline'"))
    throw new Error('docs script policy mismatch')
  const scripts = html.match(/<script\b/g)?.length ?? 0
  const nonced = html.match(/<script\b[^>]*\snonce="/g)?.length ?? 0
  if (scripts === 0 || nonced !== scripts) throw new Error(`docs scripts without a nonce: ${scripts - nonced}`)
  const stylesheet = /<link\b[^>]*rel="stylesheet"[^>]*href="(\/[^"]+)"/.exec(html)?.[1]
  if (stylesheet === undefined) throw new Error('docs stylesheet missing')
  const css = await get(stylesheet)
  await css.body?.cancel()
  if (css.status !== 200) throw new Error(`docs stylesheet HTTP ${css.status}`)
}

/** The same URL as Markdown on Accept: text/markdown, byte-identical to its .md twin. */
const checkDocsMarkdown = async (get: DocsGet): Promise<void> => {
  const negotiated = await get('/docs/quickstart', 'text/markdown')
  const twin = await get('/docs/quickstart.md')
  const [markdown, twinText] = [await negotiated.text(), await twin.text()]
  const served = negotiated.status === 200 && twin.status === 200 && startsWith(negotiated, 'text/markdown')
  if (!served || !markdown.startsWith('# ') || markdown !== twinText)
    throw new Error('docs Markdown negotiation mismatch')
}

/** The llms.txt index for this origin, the search index, and a real 404 for a missing page. */
const checkDocsIndexes = async (origin: string, get: DocsGet): Promise<void> => {
  const llms = await get('/llms.txt')
  const llmsText = await llms.text()
  if (llms.status !== 200 || !llmsText.startsWith('# Sidequest') || !llmsText.includes(`${origin}/start.md`))
    throw new Error('llms.txt mismatch')
  const search = await get('/docs/search.json')
  if (search.status !== 200) throw new Error(`docs search HTTP ${search.status}`)
  await body(search)
  const missing = await get('/docs/not-a-page', 'text/html')
  await missing.body?.cancel()
  if (missing.status !== 404) throw new Error(`docs missing page HTTP ${missing.status}`)
}

/** The public docs Explore serves from apps/docs. */
const smokeDocs = async (origin: string, fetcher: typeof fetch): Promise<void> => {
  const get: DocsGet = (path, accept) =>
    fetcher(new URL(path, origin), {
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      ...(accept === undefined ? {} : { headers: { accept } }),
    })
  await checkDocsPage(get)
  await checkDocsMarkdown(get)
  await checkDocsIndexes(origin, get)
}

type MetadataGet = (path: string, headers?: Record<string, string>) => Promise<Response>

const smokeCard = async (origin: string, prefix: string, get: MetadataGet): Promise<void> => {
  const card = await get(`${prefix}/mcp/server-card`, { accept: 'application/mcp-server-card+json' })
  if (card.status !== 200 || !startsWith(card, 'application/mcp-server-card+json'))
    throw new Error('MCP Server Card missing')
  if (JSON.stringify(await body(card)) !== JSON.stringify(serverCard(origin, prefix)))
    throw new Error('MCP Server Card metadata mismatch')
  const etag = card.headers.get('etag')
  if (
    etag === null ||
    card.headers.get('access-control-allow-origin') !== '*' ||
    card.headers.get('cache-control') !== 'public, max-age=3600'
  )
    throw new Error('MCP Server Card cache or CORS mismatch')
  const cached = await get(`${prefix}/mcp/server-card`, { 'if-none-match': etag })
  await cached.body?.cancel()
  if (cached.status !== 304) throw new Error('MCP Server Card revalidation mismatch')
}

/** Discovery must be real public metadata, rather than a successful HTML SPA fallback. */
const smokeMcpMetadata = async (origin: string, fetcher: typeof fetch): Promise<void> => {
  const get: MetadataGet = (path, headers) =>
    fetcher(new URL(path, origin), {
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      ...(headers === undefined ? {} : { headers }),
    })
  for (const prefix of ['', '/b/public']) await smokeCard(origin, prefix, get)
  const catalog = await get('/.well-known/ai-catalog.json')
  if (catalog.status !== 200 || !startsWith(catalog, 'application/ai-catalog+json'))
    throw new Error('AI Catalog missing')
  if (JSON.stringify(await body(catalog)) !== catalogReply(origin, {}).body)
    throw new Error('AI Catalog metadata mismatch')
  const proof = await get('/.well-known/mcp-registry-auth')
  if (proof.status !== 200 || !/^v=MCPv1; k=ed25519; p=[A-Za-z0-9+/]{43}=\n$/.test(await proof.text()))
    throw new Error('MCP Registry public proof missing')
  const icon = await get('/icons/icon-512.png')
  const bytes = new Uint8Array(await icon.arrayBuffer())
  if (icon.status !== 200 || !startsWith(icon, 'image/png') || bytes[0] !== 137 || bytes[1] !== 80)
    throw new Error('MCP icon missing')
}

export const smoke = async (
  stage: Stage,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<void> => {
  const infra = readStage(stage)
  const get = (path: string) =>
    fetcher(new URL(path, infra.origin), { redirect: 'error', signal: AbortSignal.timeout(20_000) })
  const health = await get('/health')
  if (health.status !== 200) throw new Error(`health HTTP ${health.status}`)
  const healthBody = await body(health)
  const expectedHealth = { ok: true, runtime: 'Cloudflare-Workers', network: infra.network, board: 'public' }
  for (const [key, value] of Object.entries(expectedHealth))
    if (healthBody[key] !== value) throw new Error(`health ${key} mismatch`)

  const release = await get('/release.json')
  if (release.status !== 200) throw new Error(`release HTTP ${release.status}`)
  const releaseBody = await body(release)
  for (const [key, value] of Object.entries(expectedRelease(infra.network)))
    if (releaseBody[key] !== value) throw new Error(`release ${key} mismatch`)

  const protectedResource = await get('/.well-known/oauth-protected-resource')
  const protectedBody = await body(protectedResource)
  if (
    protectedResource.status !== 200 ||
    !Array.isArray(protectedBody.authorization_servers) ||
    !protectedBody.authorization_servers.includes(infra.origin) ||
    (protectedBody.issuer !== undefined && protectedBody.issuer !== infra.origin) ||
    protectedBody.resource !== `${infra.origin}/mcp`
  )
    throw new Error('protected resource discovery mismatch')
  const authorization = await get('/.well-known/oauth-authorization-server')
  const authorizationBody = await body(authorization)
  if (authorization.status !== 200 || authorizationBody.issuer !== infra.origin)
    throw new Error('authorization discovery mismatch')

  for (const method of ['initialize', 'tools/list']) {
    const response = await fetcher(new URL('/mcp', infra.origin), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: method,
        method,
        params: method === 'initialize' ? { protocolVersion: '2025-06-18' } : {},
      }),
    })
    const challenge = response.headers.get('www-authenticate')
    if (response.status !== 401 || challenge === null || !challenge.startsWith('Bearer '))
      throw new Error(`anonymous ${method} challenge mismatch`)
    await response.body?.cancel()
  }
  const jobs = await get('/data/jobs')
  const jobsBody = await body(jobs)
  const index: unknown = jobsBody.index
  const updatedAt = index instanceof Object && 'updated_at' in index ? Number(index.updated_at) : Number.NaN
  if (jobs.status !== 200 || jobsBody.ok !== true || !Number.isSafeInteger(updatedAt))
    throw new Error('indexer checkpoint missing')
  const age = Math.floor(now() / 1000) - updatedAt
  if (age > INDEX_MAX_AGE_SECONDS) throw new Error(`indexer checkpoint is ${age} s old`)
  await smokeMcpMetadata(infra.origin, fetcher)
  await smokeDocs(infra.origin, fetcher)
  console.log(`ok ${stage} ${infra.origin}`)
}

if (
  process.env.NODE_ENV !== 'test' &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const stage = process.argv[2]
  if (stage !== 'dev' && stage !== 'prod') {
    console.error('usage: bun scripts/ci/smoke.ts dev|prod')
    process.exitCode = 2
  } else
    smoke(stage).catch((error: unknown) => {
      console.error(`smoke failed: ${error instanceof Error ? error.message : 'unknown error'}`)
      process.exitCode = 1
    })
}
