import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { chromium, type Page } from 'playwright-core'
import { build } from 'vite'
import sources from './fixtures/approval-harness.json'

/** Real components, Query, API reads and grant validation; only wallet and token transport are fixtures. */
export async function approvalBrowser() {
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
  const executablePath = [chromium.executablePath(), '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
  if (executablePath === undefined) throw new Error('Install Chromium to run approval component regressions')
  const browser = await chromium.launch({ executablePath })
  const serve = async (page: Page) => {
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      const body = files.get(url.pathname)
      if (url.hostname !== 'approval.test') return route.abort()
      if (body !== undefined)
        return route.fulfill({
          body,
          contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript',
        })
      return route.fulfill({ body: html, contentType: 'text/html' })
    })
  }
  return { browser, serve }
}
