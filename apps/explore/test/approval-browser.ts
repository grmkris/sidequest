import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { chromium } from 'playwright-core'
import { build } from 'vite'
import sources from './fixtures/approval-harness.json'

async function approvalBundle() {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const src = path.join(root, 'src')
  const virtual = path.join(root, 'test/fixtures/approval-virtual')
  const modules = new Map(
    Object.entries(sources).map(([file, code]) => [path.join(virtual, file), code.replaceAll('__SRC__', src)]),
  )
  const replacements = new Map(
    Object.entries({
      'components/Wallet.tsx': 'Wallet.tsx',
      'components/Privy.tsx': 'Privy.tsx',
      'components/side/SideToken.tsx': 'SideToken.tsx',
      'wallet.ts': 'wallet.ts',
      'wallet-prompt.ts': 'wallet-prompt.ts',
      'useTokens.ts': 'useTokens.ts',
    }).map(([file, fake]) => [path.join(src, file), path.join(virtual, fake)]),
  )
  const bundle = await build({
    root,
    configFile: false,
    logLevel: 'error',
    plugins: [
      tailwindcss(),
      {
        name: 'approval-wallet-fixtures',
        enforce: 'pre',
        resolveId(source, importer) {
          const id = source.startsWith('.') && importer ? path.resolve(path.dirname(importer), source) : source
          return replacements.get(id) ?? (modules.has(id) ? id : null)
        },
        load: (id) => modules.get(id),
      },
    ],
    build: { write: false, minify: false, rolldownOptions: { input: path.join(virtual, 'main.tsx') } },
  })
  if (Array.isArray(bundle) || !('output' in bundle)) throw new Error('Approval fixture build did not emit output')
  const files = new Map(
    bundle.output.map((file) => [`/${file.fileName}`, file.type === 'chunk' ? file.code : Buffer.from(file.source)]),
  )
  const entry = bundle.output.find((file) => file.type === 'chunk' && file.isEntry)?.fileName
  if (entry === undefined) throw new Error('Approval fixture has no entry')
  const styles = [...files.keys()]
    .filter((name) => name.endsWith('.css'))
    .map((name) => `<link rel="stylesheet" href="${name}">`)
    .join('')
  const html = `<html lang="en"><head>${styles}</head><body><div id="root"></div><script type="module" src="/${entry}"></script></body></html>`
  return { files, html }
}

function assetServer({ files, html }: Awaited<ReturnType<typeof approvalBundle>>) {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://approval.test').pathname
    const body = files.get(pathname)
    // CSP keeps the old harness's external-traffic fence without a route that disables every asset's cache.
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
    )
    if (body !== undefined) {
      response.setHeader('Cache-Control', 'public, max-age=3600, immutable')
      response.setHeader('Content-Type', pathname.endsWith('.css') ? 'text/css' : 'application/javascript')
      response.end(body)
      return
    }
    if (pathname === '/') {
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Content-Type', 'text/html')
      response.end(html)
      return
    }
    response.statusCode = 404
    response.end()
  })
  return server
}

const closeServer = (server: Server) =>
  new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))

/** Real components, Query, API reads and grant validation; only wallet and token transport are fixtures. */
export async function approvalBrowser() {
  const executablePath = [chromium.executablePath(), '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
  if (executablePath === undefined) throw new Error('Install Chromium to run approval component regressions')
  const server = assetServer(await approvalBundle())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // SAFETY: listen(0, '127.0.0.1') has completed, so this is an IP socket address.
  const address = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ executablePath }).catch(async (error: unknown) => {
    await closeServer(server)
    throw error
  })
  return {
    browser,
    origin,
    close: async () => {
      try {
        await browser.close()
      } finally {
        await closeServer(server)
      }
    },
  }
}
