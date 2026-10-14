import { readFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build, createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AgentConnect, StartPrompt, pairingPrompt, startPrompt } from './src/components/AgentStartLink.tsx'
import { startGuide } from './start-guide-plugin.ts'
import { renderStartGuide } from './start-guide.ts'
import worker from './worker.ts'

const source = readFileSync(new URL('../../skill/start.md', import.meta.url), 'utf8')
const routes = [['/start.md', 'text/markdown; charset=utf-8']] as const

describe('agent start guide development routes', () => {
  let vite: ViteDevServer
  let http: Server
  let origin: string

  beforeAll(async () => {
    vite = await createServer({
      configFile: false,
      plugins: [startGuide()],
      server: { middlewareMode: true },
      optimizeDeps: { noDiscovery: true },
    })
    http = createHttpServer(vite.middlewares)
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    if (address === null || typeof address === 'string') throw new Error('No development server port')
    origin = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await vite?.close()
    if (http !== undefined)
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())))
  })

  it.each(routes)('serves %s from the repo with %s', async (path, type) => {
    const response = await fetch(`${origin}${path}?reader=agent`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(type)
    expect(await response.text()).toBe(renderStartGuide(source, origin))
  })

  it.each(routes)('answers HEAD %s without a body', async (path, type) => {
    const response = await fetch(`${origin}${path}`, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(type)
    expect(await response.text()).toBe('')
  })
})

describe('agent start guide built assets and deployed routes', () => {
  let files: Record<string, string>

  beforeAll(async () => {
    const result = await build({
      configFile: false,
      root: fileURLToPath(new URL('.', import.meta.url)),
      plugins: [startGuide()],
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        rollupOptions: { input: fileURLToPath(new URL('start-guide.ts', import.meta.url)) },
      },
    })
    if ('on' in result) throw new Error('Unexpected build watcher')
    const output = Array.isArray(result) ? result.flatMap((bundle) => bundle.output) : result.output
    files = Object.fromEntries(
      output.flatMap((file) =>
        file.type === 'asset' && typeof file.source === 'string' ? [[`/${file.fileName}`, file.source]] : [],
      ),
    )
  })

  const api = vi.fn(async () => new Response('unexpected API request', { status: 500 }))
  const env = () => ({
    API: { fetch: api },
    ASSETS: {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname
        const body = files[path]
        return body === undefined
          ? new Response('<html>SPA fallback</html>', { headers: { 'Content-Type': 'text/html' } })
          : new Response(request.method === 'HEAD' ? null : body, {
              headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(Buffer.byteLength(body)),
                ETag: 'template-etag',
              },
            })
      },
    },
  })

  it('emits the start guide and leaves llms.txt to the docs app', () => {
    expect(files['/start.md']).toBe(source)
    expect(files['/llms.txt']).toBeUndefined()
  })

  it.each(['https://dev.sidequest.exchange', 'https://preview.example:8443'])(
    'serves identical bodies with URLs at %s',
    async (origin) => {
      const bodies = []
      for (const [path, type] of routes) {
        const response = await worker.fetch(new Request(`${origin}${path}?reader=agent`), env())
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe(type)
        expect(response.headers.get('content-length')).toBeNull()
        expect(response.headers.get('etag')).toBeNull()
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')
        const body = await response.text()
        expect(body).toBe(renderStartGuide(source, origin))
        expect(body).not.toContain('{{SIDEQUEST_ORIGIN}}')
        expect(body).toContain(`claude mcp add --transport http --scope user sidequest ${origin}/mcp`)
        expect(body).toContain(`codex mcp add sidequest --url ${origin}/mcp`)
        expect(body).toContain('# Set yourself up on Sidequest')
        expect(body).toContain(`${origin}/skills/connector/SKILL.md`)
        expect(body).toContain(`${origin}/skills/worker/SKILL.md`)
        expect(body).toContain(`${origin}/skills/publisher/SKILL.md`)
        expect(body).toContain('**work**, **hire**, or **work and hire**')
        expect(body).toContain('Your human chooses which in the browser when they approve the agent')
        expect(body).toContain('Do not reconnect or sign in again')
        expect(body).toContain("## 3. What your human's wallet needs")
        expect(body).not.toContain('--scopes')
        expect(body).toContain('| WORK | Find jobs, quote/apply, deliver.')
        expect(body).toContain('| HIRE | Post jobs or request quotes, pick a worker, review/approve.')
        expect(body).toContain('weekly allowance pulled from wallet[0]')
        expect(body).toContain('above it becomes an Approval in Explore')
        expect(body).toContain('bad delivery can slash it')
        expect(body).toContain('small creator bond')
        const loop = body.split('## 5. WORK only:')[1]?.split('## 6. HIRE:')[0]
        expect(loop).toBeDefined()
        expect(
          loop?.match(/WORK only: call inbox with the cursor saved in your journal, follow the worker skill/g),
        ).toHaveLength(3)
        expect(loop?.match(/do not publish hires/g)).toHaveLength(3)
        expect(body).toContain(`adds\n\`${origin}/mcp\` as a custom connector`)
        expect(body).toContain('`request_quotes` → `list_quotes` →')
        expect(body).toContain('call `approve_work` only after checking the delivered work')
        bodies.push(body)
      }
      expect(bodies).toHaveLength(1)
      expect(api).not.toHaveBeenCalled()
    },
  )

  it.each(routes)('answers deployed HEAD %s without a body', async (path, type) => {
    const response = await worker.fetch(new Request(`https://dev.sidequest.exchange${path}`, { method: 'HEAD' }), env())
    expect(response.headers.get('content-type')).toBe(type)
    expect(await response.text()).toBe('')
  })

  it.each(routes)('does not serve the SPA as a missing %s document', async (path) => {
    const missing = {
      ...env(),
      ASSETS: {
        fetch: async () => new Response('<html>SPA fallback</html>', { headers: { 'Content-Type': 'text/html' } }),
      },
    }
    const response = await worker.fetch(new Request(`https://dev.sidequest.exchange${path}`), missing)
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('not found')
  })
})

describe('Explore onboarding examples', () => {
  const origin = 'https://dev.sidequest.exchange'
  const start = `Set yourself up on Sidequest: call the Sidequest whoami tool first. If you have no Sidequest tools, read ${origin}/start.md.`
  const scout = { name: 'Scout', agentId: '42' }

  it('gives the landing one role-free prompt that starts from the connector and falls back to the served guide', () => {
    // A hosted app such as ChatGPT may not open start.md, so the prompt starts from the connector's own whoami.
    expect(startPrompt(origin)).toBe(start)
    expect(pairingPrompt(origin, scout)).toBe(
      `Connect to Sidequest as Scout (agent 42): call the Sidequest whoami tool first. If you have no Sidequest tools, read ${origin}/start.md.`,
    )
    // The human chooses work, hire or both in the browser when approving the agent, so the prompt can stay role-free.
    expect(source).toMatch(/Your human chooses which in the browser/)
    vi.stubGlobal('window', { location: { origin } })
    try {
      const html = renderToStaticMarkup(createElement(StartPrompt))
      // Step 1 is the MCP URL to add as a connector; step 2 the prompt.
      expect(html).toContain(`${origin}/mcp</code>`)
      expect(html).toContain('Copy URL')
      expect(html.indexOf('/mcp</code>')).toBeLessThan(html.indexOf(start))
      expect(html).toContain('Copy prompt')
      expect(html).toContain('ChatGPT')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('ends setup with the MCP URL and the line naming the agent, until an app acts as it', () => {
    vi.stubGlobal('window', { location: { origin } })
    try {
      const waiting = renderToStaticMarkup(createElement(AgentConnect, { agent: scout, connected: null }))
      expect(waiting).toContain(`${origin}/mcp</code>`)
      expect(waiting).toContain('Connect to Sidequest as Scout (agent 42)')
      expect(waiting).toContain('Copy prompt')
      const connected = renderToStaticMarkup(
        createElement(AgentConnect, { agent: scout, connected: 'ChatGPT is connected as Scout.' }),
      )
      expect(connected).toContain('ChatGPT is connected as Scout.')
      expect(connected).toContain(`${origin}/mcp</code>`)
      expect(connected).not.toContain('Copy prompt')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
