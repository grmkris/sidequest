import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { parse } from 'parse5'
import { localAssets } from './local-assets.ts'
import worker from '../worker.ts'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const explore = resolve(repo, 'apps/explore')
const output = resolve(explore, 'dist/e2e')
const args = process.argv.slice(2)
assert(
  args.length === 0 || (args.length === 2 && args[0] === '--origin'),
  'Usage: node apps/explore/scripts/docs-smoke.mjs [--origin <url>]',
)
let origin = args[1] ? new URL(args[1]).origin : undefined
let server
let htmlCount = 0
let requestCount = 0
const assets = new Set()

async function checkResponse(path, status = 200, options = {}) {
  requestCount++
  const res = await fetch(new URL(path, origin), { redirect: 'manual', ...options })
  assert.equal(res.status, status, `${path} status`)
  if (path.startsWith('/docs') || path.startsWith('/llms') || path.startsWith('/__tsr/')) {
    assert.match(res.headers.get('vary') ?? '', /(?:^|,\s*)accept(?:,|$)/i, `${path} Vary`)
    assert.equal(res.headers.get('x-frame-options'), 'DENY', `${path} frame policy`)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${path} nosniff`)
    assert.equal(res.headers.get('etag'), null, `${path} ETag`)
  }
  return res
}
function checkHtml(body, res, path) {
  htmlCount++
  assert.match(body, /content="sidequest-docs"/, `${path} docs marker`)
  assert(!body.includes('$RC(') && !body.includes('<template id="B:'), `${path} unresolved Suspense`)
  const policy = res.headers.get('content-security-policy') ?? ''
  const scriptSrc = policy.split(';').find((part) => part.trim().startsWith('script-src')) ?? ''
  assert(!scriptSrc.includes("'unsafe-inline'"), `${path} script-src allows inline scripts`)
  const nonce = /'nonce-([^']+)'/.exec(scriptSrc)?.[1]
  assert(nonce, `${path} CSP nonce`)
  const visit = (node) => {
    const attributes = new Map((node.attrs ?? []).map((attr) => [attr.name, attr.value]))
    if (node.tagName === 'script') assert.equal(attributes.get('nonce'), nonce, `${path} script nonce`)
    for (const [name, value] of attributes) {
      assert(!/^on/i.test(name), `${path} inline handler ${name}`)
      const normalized = Array.from(value)
        .filter((char) => (char.codePointAt(0) ?? 0) >= 0x21)
        .join('')
        .toLowerCase()
      assert(!normalized.startsWith('javascript:'), `${path} javascript URL`)
      if (
        (name === 'src' || name === 'href') &&
        (value.startsWith('/docs/_assets/') || value.startsWith('/__tsr/staticServerFnCache/'))
      )
        assets.add(value)
    }
    for (const child of node.childNodes ?? []) visit(child)
    if (node.content) visit(node.content)
  }
  visit(parse(body))
}
async function checks() {
  const llmsResponse = await checkResponse('/llms.txt')
  assert.equal(llmsResponse.headers.get('content-type'), 'text/plain; charset=utf-8')
  const llms = await llmsResponse.text()
  assert.match(llms, /^# Sidequest\n\n> /)
  const links = [...llms.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map((match) => new URL(match[1]))
  assert.equal(links[0]?.pathname, '/start.md', 'start.md is the first LLM link')
  const markdownPaths = links.filter((url) => url.pathname.startsWith('/docs/')).map((url) => url.pathname)
  assert(markdownPaths.length >= 3, 'LLM index lists the seed pages')
  assert.equal(new Set(markdownPaths).size, markdownPaths.length, 'duplicate LLM page')
  for (const markdownPath of markdownPaths) {
    const path = markdownPath === '/docs/index.md' ? '/docs' : markdownPath.slice(0, -3)
    const page = await checkResponse(path)
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8', `${path} HTML type`)
    assert.equal(page.headers.get('link'), `<${origin}${markdownPath}>; rel="alternate"; type="text/markdown"`)
    const body = await page.text()
    checkHtml(body, page, path)
    assert.match(body, /<h1\b/, `${path} prerendered heading`)
    const markdown = await checkResponse(markdownPath)
    assert.equal(markdown.headers.get('content-type'), 'text/markdown; charset=utf-8')
    const preferred = await checkResponse(path, 200, { headers: { Accept: 'text/markdown' } })
    assert.equal(preferred.headers.get('content-type'), 'text/markdown; charset=utf-8')
    assert.equal(await preferred.text(), await markdown.text(), `${path} Markdown twin parity`)
    const head = await checkResponse(path, 200, { method: 'HEAD' })
    assert.equal(await head.text(), '', `${path} HEAD body`)
  }
  for (const accept of ['*/*', 'text/html, text/markdown;q=0.5']) {
    const res = await checkResponse('/docs', 200, { headers: { Accept: accept } })
    checkHtml(await res.text(), res, `/docs (${accept})`)
  }
  const full = await checkResponse('/llms-full.txt')
  assert.equal(full.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert((await full.text()).startsWith('# Sidequest'))
  const search = await checkResponse('/docs/search.json')
  assert.equal(search.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(search.headers.get('cache-control'), 'public, max-age=300')
  assert(await search.json(), 'valid search JSON')
  const missing = await checkResponse('/docs/nope', 404)
  checkHtml(await missing.text(), missing, '/docs/nope')
  assert.equal((await checkResponse('/docs/nope.md', 404)).headers.get('content-type'), 'text/plain; charset=utf-8')
  const notFound = await checkResponse('/docs/not-found')
  checkHtml(await notFound.text(), notFound, '/docs/not-found')
  for (const [path, status, location] of [
    ['/docs/', 308, '/docs'],
    ['/docs/quickstart.html', 301, '/docs/quickstart'],
  ])
    assert.equal((await checkResponse(path, status)).headers.get('location'), location)
  const post = await checkResponse('/docs', 405, { method: 'POST' })
  assert.equal(post.headers.get('allow'), 'GET, HEAD')
  if (!args[1]) {
    const cache = resolve(output, '__tsr/staticServerFnCache')
    for (const file of readdirSync(cache)) assets.add(`/__tsr/staticServerFnCache/${file}`)
  }
  assert(assets.size > 0, 'docs asset references')
  for (const path of assets) {
    const asset = await checkResponse(path)
    assert(!asset.headers.get('content-type')?.startsWith('text/html'), `${path} SPA fallback`)
    if (path.startsWith('/docs/_assets/'))
      assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  }
  const source = readFileSync(resolve(repo, 'skill/start.md'), 'utf8').replaceAll('{{SIDEQUEST_ORIGIN}}', origin)
  assert.equal(await (await checkResponse('/start.md')).text(), source, 'start.md content unchanged')
  for (const role of ['connector', 'worker', 'publisher', 'arbitrator', 'self-run'])
    assert.equal(
      await (await checkResponse(`/skills/${role}/SKILL.md`)).text(),
      readFileSync(resolve(repo, `skill/${role}/SKILL.md`), 'utf8').replaceAll('{{SIDEQUEST_ORIGIN}}', origin),
      `${role} skill unchanged`,
    )
  for (const path of ['/', '/jobs']) {
    const page = await checkResponse(path)
    assert.match(page.headers.get('content-security-policy') ?? '', /https:\/\/challenges.cloudflare.com/)
    assert.equal(page.headers.get('x-frame-options'), 'DENY')
  }
  await checkResponse('/mcp', 401, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
}
try {
  if (!origin) {
    const env = {
      API: { fetch: async () => new Response('unauthorized', { status: 401 }) },
      ASSETS: localAssets(output),
    }
    server = createServer(async (request, res) => {
      try {
        const headers = new Headers()
        for (const [key, value] of Object.entries(request.headers))
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value)
        const result = await worker.fetch(
          new Request(new URL(request.url ?? '/', origin), { method: request.method ?? 'GET', headers }),
          env,
        )
        res.writeHead(result.status, Object.fromEntries(result.headers))
        res.end(Buffer.from(await result.arrayBuffer()))
      } catch (error) {
        res.writeHead(500)
        res.end(String(error))
      }
    })
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    origin = `http://127.0.0.1:${server.address().port}`
    const result = spawnSync(
      process.execPath,
      [resolve(explore, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', 'dist/e2e'],
      {
        cwd: explore,
        env: { ...process.env, SIDEQUEST_DOCS_ORIGIN: origin, SIDEQUEST_DOCS_PREBUILT: '0' },
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
      },
    )
    if (result.status !== 0) {
      process.stderr.write(result.stdout ?? '')
      process.stderr.write(result.stderr ?? '')
      throw new Error(`Explore build failed: ${result.status ?? result.error?.message}`)
    }
    console.log('Explore client build includes docs; testing the real Worker over HTTP.')
  }
  await checks()
  console.log(`Docs smoke passed: ${requestCount} HTTP checks, ${htmlCount} parsed HTML responses (${origin}).`)
} finally {
  if (server) await new Promise((done, fail) => server.close((error) => (error ? fail(error) : done())))
}
