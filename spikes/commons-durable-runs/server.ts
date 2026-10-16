import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Conflict, isCommand } from './model.ts'
import { MissionStore, SimulatedPayments } from './store.ts'

const json = (value: object, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })

export function createPreview(directory: string) {
  mkdirSync(directory, { recursive: true })
  let store = new MissionStore(join(directory, 'mission.sqlite'))
  const provider = new SimulatedPayments(join(directory, 'simulated-payments.sqlite'))
  const boot = crypto.randomUUID()
  const snapshot = () => ({ ...store.snapshot(), simulatedReceipts: provider.all(), boot })

  async function mutate(request: Request, pathname: string): Promise<Response> {
    if (pathname === '/api/recover') {
      store.close()
      store = new MissionStore(join(directory, 'mission.sqlite'))
      return json(snapshot())
    }
    const value: unknown = await request.json()
    if (!isCommand(value)) return json({ error: 'Invalid command.' }, 400)
    store.command(value)
    if (['pay', 'lose_reply', 'reconcile'].includes(value.action)) {
      store.settle(value.ticketId, provider, value.action === 'lose_reply')
    }
    return json(snapshot())
  }

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    // Loopback-only server plus exact Host/Origin checks prevent accidental exposure and cross-site writes.
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return json({ error: 'Loopback only.' }, 403)
    if (request.method === 'GET' && url.pathname === '/api/state') return json(snapshot())
    if (request.method !== 'POST') return json({ error: 'Not found.' }, 404)
    if (request.headers.get('origin') !== url.origin) return json({ error: 'Same-origin requests only.' }, 403)
    if (!['/api/command', '/api/recover'].includes(url.pathname)) return json({ error: 'Not found.' }, 404)
    try {
      return await mutate(request, url.pathname)
    } catch (error) {
      if (error instanceof Conflict) return json({ error: error.message }, 409)
      if (error instanceof SyntaxError) return json({ error: 'Invalid JSON.' }, 400)
      console.error(error)
      return json({ error: 'Could not save this step. Read the journal before retrying.' }, 500)
    }
  }
  return {
    fetch,
    close: () => {
      store.close()
      provider.close()
    },
  }
}

if (import.meta.main) {
  const preview = createPreview(process.env.COMMONS_PREVIEW_DATA ?? join(import.meta.dir, '.data'))
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, 'ui.ts')], target: 'browser' })
  if (!build.success || !build.outputs[0]) throw new Error('Preview UI build failed.')
  const assets = new Map([
    ['/', { body: Bun.file(join(import.meta.dir, 'index.html')), type: 'text/html' }],
    ['/style.css', { body: Bun.file(join(import.meta.dir, 'style.css')), type: 'text/css' }],
    ['/ui.js', { body: build.outputs[0], type: 'text/javascript' }],
  ])
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: Number(process.env.COMMONS_PREVIEW_PORT ?? 4318),
    maxRequestBodySize: 4096,
    fetch(request) {
      const asset = assets.get(new URL(request.url).pathname)
      if (request.method === 'GET' && asset)
        return new Response(asset.body, {
          headers: {
            'Content-Type': asset.type,
            'Cache-Control': 'no-store',
            'Content-Security-Policy':
              "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'",
          },
        })
      return preview.fetch(request)
    },
  })
  console.info(`Commons mission preview: ${server.url}`)
  console.info('Simulated agents and payments. Journal and recovery use local SQLite files.')
}
