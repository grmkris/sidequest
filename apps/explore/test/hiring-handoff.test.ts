import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright-core'
import { build } from 'vite'
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import tailwindcss from '@tailwindcss/vite'
import sources from './fixtures/hiring-harness.json'

declare global {
  interface Window {
    __hiring: {
      agents: import('../src/api.ts').ManagedAgent[]
      fail: boolean
      delay: number
      reads: number
      writes: string[]
      copied: string
    }
  }
}

const appRoot = fileURLToPath(new URL('../', import.meta.url))
const virtualRoot = path.join(appRoot, 'test/fixtures/virtual')
const sourceRoot = path.join(appRoot, 'src')
const aliases = new Map([
  [path.join(sourceRoot, 'components/Wallet.tsx'), path.join(virtualRoot, 'Wallet.tsx')],
  [path.join(sourceRoot, 'wallet.ts'), path.join(virtualRoot, 'wallet.ts')],
  [path.join(sourceRoot, 'components/BondHorizonNotice.tsx'), path.join(virtualRoot, 'BondHorizonNotice.tsx')],
])
// The release-review harness supplies only auth/transport fixtures; UI and TanStack Query remain real.
const modules = new Map(
  Object.entries(sources).map(([file, code]) => [path.join(virtualRoot, file), code.replaceAll('__SRC__', sourceRoot)]),
)
let server: Server
let browser: Browser
let origin: string
beforeAll(async () => {
  const bundle = await build({
    configFile: false,
    root: appRoot,
    logLevel: 'error',
    define: { __SIDEQUEST_NETWORK__: '"monad-testnet"', __SIDEQUEST_STAGE__: '"dev"', __SIDEQUEST_RELAY__: '""' },
    build: { write: false, minify: false, rolldownOptions: { input: path.join(virtualRoot, 'main.tsx') } },
    plugins: [
      tailwindcss(),
      {
        name: 'hiring-test-transport',
        enforce: 'pre',
        async resolveId(source, importer, options) {
          if (modules.has(source)) return source
          if (importer?.startsWith(virtualRoot) && source.startsWith('.'))
            return path.resolve(path.dirname(importer), source)
          if (importer === undefined || source.startsWith('\0')) return null
          const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
          return resolved ? aliases.get(resolved.id) : null
        },
        load(id) {
          return modules.get(id)
        },
      },
    ],
  })
  if (Array.isArray(bundle) || !('output' in bundle)) throw new Error('Expected one browser bundle')
  const files = new Map(bundle.output.map((file) => [file.fileName, file.type === 'chunk' ? file.code : file.source]))
  const css = bundle.output
    .filter((file) => file.fileName.endsWith('.css'))
    .map((file) => `<link rel="stylesheet" href="/${file.fileName}">`)
    .join('')
  const entry = bundle.output.find((file) => file.type === 'chunk' && file.isEntry)
  if (!entry) throw new Error('Missing harness entry')
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname.slice(1)
    if (pathname === '' || !files.has(pathname)) {
      res.setHeader('Content-Type', 'text/html')
      res.end(
        `<html><head>${css}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`,
      )
    } else if (files.has(pathname)) {
      res.setHeader('Content-Type', pathname.endsWith('.css') ? 'text/css' : 'application/javascript')
      res.end(files.get(pathname))
    } else {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // SAFETY: listen(0, '127.0.0.1') has completed, so this is an IP socket address.
  const address = server.address() as AddressInfo
  origin = `http://127.0.0.1:${address.port}/`
  // Hosted Ubuntu CI supplies Chrome; local development can use Playwright's downloaded Chromium.
  const executablePath = [chromium.executablePath(), '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
  if (!executablePath)
    throw new Error('Install Chromium with playwright-core install chromium to run component regressions')
  browser = await chromium.launch({ executablePath })
}, 30000)
afterAll(async () => {
  await browser?.close()
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
})
async function open(search = '?signedIn', width = 390, route = '/') {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  page.setDefaultTimeout(2000)
  page.on('pageerror', (error) => console.error('harness page error', error.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('harness console', msg.text())
  })
  await page.goto(origin + route.replace(/^\//, '') + search)
  await page.locator('button').filter({ hasText: 'Post a job' }).click()
  await page.getByLabel('Job brief', { exact: true }).waitFor()
  return page
}

it('keeps the brief through sign-in, copies the verified public instruction and closes without mutation', async () => {
  const page = await open('')
  try {
    await page.getByLabel('Job brief', { exact: true }).fill('Build a report with tests')
    expect(await page.getByLabel('Agent instruction').count()).toBe(0)
    await page.getByRole('button', { name: 'Sign in to choose a publisher' }).click()
    const prompt = page.getByLabel('Agent instruction')
    await prompt.waitFor()
    expect(await page.getByLabel('Job brief', { exact: true }).inputValue()).toBe('Build a report with tests')
    const text = await prompt.inputValue()
    expect(text).toContain('agent #10401, wallet 0x0000000000000000000000000000000000000001')
    expect(text).toContain(origin.replace(/\/$/, '') + '/mcp')
    expect(text).toContain('whoami')
    expect(text).toContain('hire access')
    expect(text).toContain('request_quotes')
    expect(text).toContain('required wallet authorization or operator approval')
    expect(text).toContain('original operation key and exact arguments')
    expect(text).toContain('Build a report with tests')
    await page.getByRole('button', { name: 'Copy', exact: true }).click()
    await page.getByRole('button', { name: 'Copy copied', exact: true }).waitFor()
    expect(await page.evaluate(() => window.__hiring.copied)).toBe(text)
    await page.keyboard.press('Escape')
    await page.locator('button').filter({ hasText: 'Post a job' }).waitFor()
    expect(await page.evaluate(() => window.__hiring.writes)).toEqual([])
  } finally {
    await page.close()
  }
})

it('offers setup for no agents and retains a board-scoped draft after leaving and reloading', async () => {
  const page = await open('?signedIn&mode=none')
  try {
    await page.getByRole('link', { name: 'Set up an agent', exact: true }).waitFor()
    await page.getByLabel('Job brief', { exact: true }).fill('Keep this draft')
    expect(await page.getByLabel('Agent instruction').count()).toBe(0)
    expect(await page.getByRole('link', { name: 'Set up an agent', exact: true }).getAttribute('href')).toBe(
      '/agents/new',
    )
    await page.goto(origin + 'agents/new')
    await page.goto(origin + '?signedIn&mode=none')
    await page.locator('button').filter({ hasText: 'Post a job' }).click()
    expect(await page.getByLabel('Job brief', { exact: true }).inputValue()).toBe('Keep this draft')
    await page.goto(origin + 'b/acme?signedIn&mode=none')
    await page.locator('button').filter({ hasText: 'Post a job' }).click()
    expect(await page.getByLabel('Job brief', { exact: true }).inputValue()).toBe('')
  } finally {
    await page.close()
  }
})

it('requires a choice for multiple publishers and pins the selected tenant resource', async () => {
  const page = await open('?signedIn&mode=many', 390, '/b/acme')
  try {
    await page.getByLabel('Publisher', { exact: true }).waitFor()
    expect(await page.getByLabel('Agent instruction').count()).toBe(0)
    await page.getByLabel('Publisher', { exact: true }).selectOption('p2')
    const text = await page.getByLabel('Agent instruction').inputValue()
    expect(text).toContain('/b/acme/mcp')
    expect(text).toContain('agent #10402, wallet 0x0000000000000000000000000000000000000002')
    expect(text).not.toContain('agent #10401')
    expect(await page.evaluate(() => window.__hiring.writes)).toEqual([])
  } finally {
    await page.close()
  }
})

it('hides stale identities during refresh and after a failed lookup, preserving the brief for retry', async () => {
  const page = await open()
  try {
    await page.getByLabel('Agent instruction').waitFor()
    await page.getByLabel('Job brief', { exact: true }).fill('Keep on retry')
    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      window.__hiring.delay = 300
      window.__hiring.fail = true
    })
    await page.locator('button').filter({ hasText: 'Post a job' }).click()
    await page.getByText('Checking your publishers…').waitFor()
    expect(await page.getByLabel('Agent instruction').count()).toBe(0)
    await page.getByRole('alert').filter({ hasText: 'could not be verified' }).waitFor()
    expect(await page.getByLabel('Agent instruction').count()).toBe(0)
    await page.evaluate(() => {
      window.__hiring.fail = false
    })
    await page.getByRole('button', { name: 'Retry publishers', exact: true }).click()
    await page.getByLabel('Agent instruction').waitFor()
    expect(await page.getByLabel('Job brief', { exact: true }).inputValue()).toBe('Keep on retry')
    expect(await page.getByLabel('Agent instruction').inputValue()).toContain('Keep on retry')
  } finally {
    await page.close()
  }
})

it('withholds Work-only, unknown-role and revoked publishers and links to existing access remedies', async () => {
  const page = await open('?signedIn&mode=blocked', 390, '/b/acme')
  try {
    await page.getByText('These agents are unavailable for hiring:').waitFor()
    expect(await page.getByLabel('Agent instruction').count()).toBe(0)
    await page.getByText('Hiring Agent: Hire access is not enabled.').waitFor()
    await page.getByText('Unknown Agent: Hire access could not be verified.').waitFor()
    await page.getByText('Revoked Agent: setup incomplete or access revoked.').waitFor()
    expect(await page.getByRole('link', { name: 'Manage access and connections' }).first().getAttribute('href')).toBe(
      '/b/acme/agent/10401?tab=manage',
    )
    await page.evaluate(() => {
      const first = window.__hiring.agents[0]
      if (!first) throw new Error('Missing test publisher')
      window.__hiring.agents = [{ ...first, roles: ['hire'] }]
    })
    await page.getByRole('button', { name: 'Retry publishers', exact: true }).click()
    await page.getByLabel('Agent instruction').waitFor()
    // Revocation in a later read must also remove a previously usable prompt.
    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      const first = window.__hiring.agents[0]
      if (!first) throw new Error('Missing test publisher')
      first.state = 'revoked'
    })
    await page.locator('button').filter({ hasText: 'Post a job' }).click()
    await page.getByText('These agents are unavailable for hiring:').waitFor()
    expect(await page.getByLabel('Agent instruction').count()).toBe(0)
  } finally {
    await page.close()
  }
})

it.each([1280, 390])('supports keyboard opening, editing and closing at %ipx with no overflow', async (width) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  try {
    await page.goto(origin + '?signedIn')
    const trigger = page.locator('button').filter({ hasText: 'Post a job' })
    await trigger.focus()
    await page.keyboard.press('Enter')
    await page.getByLabel('Agent instruction').waitFor()
    await page.getByLabel('Job brief', { exact: true }).fill('A focused job brief for review')
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    expect(await page.getByRole('dialog').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false)
    // Evidence is optional and deliberately written outside the checkout during normal tests.
    if (process.env.HIRING_EVIDENCE_DIR)
      await page.screenshot({ path: `${process.env.HIRING_EVIDENCE_DIR}/${width}.png`, fullPage: true })
    await page.keyboard.press('Escape')
    await trigger.waitFor()
    expect(await page.evaluate(() => window.__hiring.writes)).toEqual([])
  } finally {
    await page.close()
  }
})
