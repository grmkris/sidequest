import { describe, expect, it } from 'vitest'
import { isApiPath } from './routing.ts'
import worker from './worker.ts'

const INDEX = '<!doctype html><title>Sidequest</title>'

function env(files: Record<string, string> = {}) {
  const api: string[] = []
  return {
    api,
    env: {
      API: {
        fetch: async (r: Request) => {
          api.push(new URL(r.url).pathname)
          return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
        },
      },
      // Cloudflare's single-page-application fallback: a known file, else index.html with 200.
      ASSETS: {
        fetch: async (r: Request) => {
          const pathname = new URL(r.url).pathname
          const path = pathname in files ? pathname : `${pathname}.html` in files ? `${pathname}.html` : pathname
          const type = path.endsWith('.png')
            ? 'image/png'
            : path.endsWith('.webmanifest')
              ? 'application/manifest+json'
              : path.endsWith('.md')
                ? 'text/markdown'
                : path.endsWith('.json')
                  ? 'application/json'
                  : path.endsWith('.js')
                    ? 'text/javascript'
                    : 'text/html'
          return path in files
            ? new Response(files[path], {
                headers: { 'content-type': type, 'content-length': String(files[path]?.length ?? 0), etag: 'fixture' },
              })
            : new Response(INDEX, { headers: { 'content-type': 'text/html' } })
        },
      },
    },
  }
}

const get = (path: string, e: ReturnType<typeof env>) =>
  worker.fetch(new Request(`https://dev.sidequest.exchange${path}`), e.env)

describe('explore worker routing', () => {
  it('sends the board API to the API, under a board prefix too', () => {
    for (const p of ['/api/get_task', '/data/jobs', '/offers/0xab.json', '/mcp', '/health']) {
      expect(isApiPath(p), p).toBe(true)
      expect(isApiPath(`/b/monad-pet${p}`), `/b/monad-pet${p}`).toBe(true)
    }
  })

  it("sends agents' avatars and registration files to the API, and keeps the agent pages in the app", () => {
    expect(isApiPath(`/avatars/${'a'.repeat(64)}.jpg`)).toBe(true)
    expect(isApiPath('/profiles/606affe7-5c69-499a-a82f-173e49789203.json')).toBe(true)
    for (const page of ['/agents/new', '/agent/2022', '/agents']) expect(isApiPath(page), page).toBe(false)
  })

  it('sends the x402 proof resource to the API, so its 402 challenge reaches the client', async () => {
    expect(isApiPath('/x402/demo')).toBe(true)
    const e = env()
    await get('/x402/demo', e)
    expect(e.api).toEqual(['/x402/demo'])
  })

  it('proxies public and tenant MCP cards instead of the SPA, without swallowing similar page paths', async () => {
    const e = env()
    for (const path of ['/mcp/server-card', '/b/monad-pet/mcp/server-card']) {
      expect(isApiPath(path)).toBe(true)
      expect((await get(path, e)).headers.get('content-type')).toBe('application/json')
    }
    expect(e.api).toEqual(['/mcp/server-card', '/b/monad-pet/mcp/server-card'])
    expect(isApiPath('/mcp/server-card-extra')).toBe(false)
    expect(isApiPath('/b/monad-pet/mcp/server-card-extra')).toBe(false)
  })

  it("serves a board's pages from the app", () => {
    for (const p of [
      '/b/monad-pet',
      '/b/monad-pet/',
      '/b/monad-pet/job/54',
      '/b/monad-pet/publish',
      '/b/monad-pet/quotes/3',
      '/b/monad-pet/agent/1942',
    ]) {
      expect(isApiPath(p), p).toBe(false)
    }
  })

  it('loads a board page as the SPA, not the API', async () => {
    const e = env()
    const res = await get('/b/monad-pet/job/54', e)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(INDEX)
    expect(e.api).toEqual([])
    expect(res.headers.get('x-frame-options')).toBe('DENY')
  })

  it('proxies OAuth discovery and consent state while keeping UI approval pages in the SPA', async () => {
    const e = env()
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server',
      '/oauth/authorize',
      '/oauth/token',
      '/oauth/requests/one',
    ]) {
      expect(isApiPath(path)).toBe(true)
      expect((await get(path, e)).headers.get('content-type')).toBe('application/json')
    }
    for (const path of ['/connect', '/approvals/one', '/workspace', '/mcp-explainer', '/health-check']) {
      expect(isApiPath(path)).toBe(false)
      expect(await (await get(path, e)).text()).toBe(INDEX)
    }
  })

  it('proxies a board tool call', async () => {
    const e = env()
    await get('/b/monad-pet/api/get_board', e)
    expect(e.api).toEqual(['/b/monad-pet/api/get_board'])
  })

  it('answers a missing file with 404, not the app page', async () => {
    const res = await get('/apple-touch-icon.png', env())
    expect(res.status).toBe(404)
  })

  it('serves existing files, the manifest with its media type', async () => {
    const e = env({ '/apple-touch-icon.png': 'png', '/manifest.webmanifest': '{}' })
    const icon = await get('/apple-touch-icon.png', e)
    expect(icon.status).toBe(200)
    expect(icon.headers.get('content-type')).toBe('image/png')
    const manifest = await get('/manifest.webmanifest', e)
    expect(manifest.headers.get('content-type')).toBe('application/manifest+json')
  })

  it('serves the agent skills as UTF-8 markdown, and a missing one as 404', async () => {
    const e = env({ '/skills/worker/SKILL.md': '# worker' })
    const skill = await get('/skills/worker/SKILL.md', e)
    expect(skill.status).toBe(200)
    expect(skill.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(await skill.text()).toBe('# worker')
    expect(e.api).toEqual([])
    expect((await get('/skills/nobody/SKILL.md', e)).status).toBe(404)
  })

  it('serves a skill whose name has a hyphen, rendered for the request origin', async () => {
    const e = env({ '/skills/self-run/SKILL.md': '# Self-run\n{{SIDEQUEST_ORIGIN}}/api' })
    const response = await worker.fetch(new Request('https://dev.sidequest.exchange/skills/self-run/SKILL.md'), e.env)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('# Self-run\nhttps://dev.sidequest.exchange/api')
  })

  it('renders connector skills for the request origin and discards the template byte metadata', async () => {
    const e = env({ '/skills/connector/SKILL.md': '# Connect\n{{SIDEQUEST_ORIGIN}}/mcp' })
    for (const origin of ['https://sidequest.exchange', 'https://dev.sidequest.exchange']) {
      const response = await worker.fetch(new Request(`${origin}/skills/connector/SKILL.md`), e.env)
      expect(await response.text()).toBe(`# Connect\n${origin}/mcp`)
      expect(response.headers.get('content-length')).toBeNull()
      expect(response.headers.get('etag')).toBeNull()
      const head = await worker.fetch(new Request(`${origin}/skills/connector/SKILL.md`, { method: 'HEAD' }), e.env)
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')
    }
  })
})

const DOC_HTML =
  '<!doctype html><html><head><meta name="generator" content="sidequest-docs"></head><body><h1>Quickstart</h1><script>window.app=1</script><script src="/docs/_assets/app.js"></script></body></html>'
const DOC_FILES = {
  '/docs.html': DOC_HTML,
  '/docs/quickstart.html': DOC_HTML,
  '/docs/not-found.html': DOC_HTML.replace('Quickstart', 'That page is off the board.'),
  '/docs/index.md': '# Sidequest\n',
  '/docs/quickstart.md': '# Quickstart\n\nStart here.',
  '/docs/search.json': '{"count":1}',
  '/llms.txt': '# Sidequest\n',
  '/llms-full.txt': '# Full docs\n',
  '/docs/_assets/app.js': 'console.log(1)',
  '/__tsr/staticServerFnCache/one.json': '{}',
}
const docsRequest = (path: string, options: RequestInit = {}, e = env(DOC_FILES)) =>
  worker.fetch(new Request(`https://dev.sidequest.exchange${path}`, options), e.env)
describe('Explore docs worker', () => {
  it('puts a fresh CSP nonce on every script and advertises Markdown', async () => {
    const first = await docsRequest('/docs/quickstart')
    const second = await docsRequest('/docs/quickstart')
    const policy = first.headers.get('content-security-policy')!
    const nonce = /'nonce-([^']+)'/.exec(policy)![1]
    const scriptPolicy = policy.split(';').find((part) => part.trim().startsWith('script-src'))!
    expect(scriptPolicy).not.toContain("'unsafe-inline'")
    expect(first.headers.get('vary')).toBe('Accept')
    expect(first.headers.get('link')).toBe(
      '<https://dev.sidequest.exchange/docs/quickstart.md>; rel="alternate"; type="text/markdown"',
    )
    expect(first.headers.get('content-length')).toBeNull()
    expect(first.headers.get('etag')).toBeNull()
    const body = await first.text()
    const scripts = [...body.matchAll(/<script\b[^>]*>/g)]
    expect(scripts).toHaveLength(2)
    for (const [script] of scripts) expect(script).toContain(`nonce="${nonce}"`)
    expect(second.headers.get('content-security-policy')).not.toBe(policy)
  })
  it.each(['*/*', 'text/html, text/markdown;q=0.5'])('serves HTML for Accept %s', async (accept) => {
    const res = await docsRequest('/docs/quickstart', { headers: { accept } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await res.text()).toContain('<h1>Quickstart</h1>')
  })
  it('negotiates the same Markdown as the explicit twin', async () => {
    const preferred = await docsRequest('/docs/quickstart', { headers: { accept: 'text/markdown' } })
    const twin = await docsRequest('/docs/quickstart.md')
    expect(preferred.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(preferred.headers.get('access-control-allow-origin')).toBe('*')
    expect(preferred.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'")
    expect(await preferred.text()).toBe(await twin.text())
    expect(await (await docsRequest('/docs.md')).text()).toBe(DOC_FILES['/docs/index.md'])
  })
  it('serves the styled missing page with 404 and rejects Markdown/asset fallbacks', async () => {
    const missing = await docsRequest('/docs/nope')
    expect(missing.status).toBe(404)
    expect(await missing.text()).toContain('That page is off the board.')
    for (const path of ['/docs/nope.md', '/docs/_assets/nope.js', '/__tsr/staticServerFnCache/nope.json']) {
      const res = await docsRequest(path)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('not found')
    }
    const missingMd = await docsRequest('/docs/nope', { headers: { accept: 'text/markdown' } })
    expect(missingMd.status).toBe(404)
    expect(missingMd.headers.get('content-type')).toContain('text/plain')
    expect((await docsRequest('/docs/search.json', {}, env())).status).toBe(404)
  })
  it.each(['/docs', '/docs/quickstart.md', '/docs/search.json', '/docs/nope', '/llms.txt', '/docs/_assets/app.js'])(
    'answers HEAD %s with the GET status and no body',
    async (path) => {
      const head = await docsRequest(path, { method: 'HEAD' })
      const getRes = await docsRequest(path)
      expect(head.status).toBe(getRes.status)
      expect(head.headers.get('content-type')).toBe(getRes.headers.get('content-type'))
      expect(await head.text()).toBe('')
    },
  )
  it.each(['/docs/', '/docs', '/docs/quickstart.md', '/docs/search.json', '/docs/_assets/app.js', '/llms-full.txt'])(
    'limits %s to GET/HEAD',
    async (path) => {
      const res = await docsRequest(path, { method: 'POST' })
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('GET, HEAD')
    },
  )
  it('redirects canonical HTML URLs and the docs root slash', async () => {
    for (const [path, status, location] of [
      ['/docs/', 308, '/docs'],
      ['/docs/quickstart.html', 301, '/docs/quickstart'],
      ['/docs.html', 301, '/docs'],
    ] as const) {
      const res = await docsRequest(path)
      expect(res.status).toBe(status)
      expect(res.headers.get('location')).toBe(location)
    }
  })
  it('serves search, LLM text, immutable assets, and the static server-function cache', async () => {
    const e = env(DOC_FILES)
    const search = await docsRequest('/docs/search.json', {}, e)
    expect(search.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(search.headers.get('cache-control')).toBe('public, max-age=300')
    expect(await search.json()).toEqual({ count: 1 })
    for (const path of ['/llms.txt', '/llms-full.txt'])
      expect((await docsRequest(path, {}, e)).headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect((await docsRequest('/docs/_assets/app.js', {}, e)).headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(await (await docsRequest('/__tsr/staticServerFnCache/one.json', {}, e)).json()).toEqual({})
    expect(e.api).toEqual([])
  })
  it('keeps the existing SPA policy and guide behavior', async () => {
    for (const path of ['/', '/jobs', '/embed']) {
      const res = await docsRequest(path)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-security-policy')).toContain('https://challenges.cloudflare.com')
      expect(res.headers.get('content-security-policy')).not.toContain('nonce-')
      expect(res.headers.get('x-frame-options')).toBe('DENY')
    }
    // Delivery posters load from the worker's host: any https image, never a frame or a script from it.
    const policy = (await docsRequest('/jobs')).headers.get('content-security-policy')!
    const directive = (name: string) =>
      policy
        .split(';')
        .find((part) => part.trim().startsWith(`${name} `))!
        .trim()
    expect(directive('img-src')).toBe("img-src 'self' data: blob: https:")
    expect(directive('frame-src')).not.toContain('https: ')
    expect(directive('script-src')).toBe("script-src 'self' https://challenges.cloudflare.com")
    // A delivered 3D model is fetched from its host and its textures decode through blob: URLs; no eval anywhere.
    expect(directive('connect-src')).toMatch(/^connect-src 'self' https: blob: /)
    expect(policy).not.toContain('unsafe-eval')
    const guide = await docsRequest('/start.md', {}, env({ '/start.md': '# Start\n{{SIDEQUEST_ORIGIN}}/mcp' }))
    expect(await guide.text()).toBe('# Start\nhttps://dev.sidequest.exchange/mcp')
  })
})
