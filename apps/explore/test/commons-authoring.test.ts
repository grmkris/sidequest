import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import { build } from 'vite'
import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import sources from './fixtures/commons-harness.json'

declare global {
  interface Window {
    __backend: { posts: unknown[]; postError: boolean; postDelayMs: number }
    __hostMessages: { method: string; params: any }[]
  }
}

const appRoot = fileURLToPath(new URL('../', import.meta.url))
const virtualRoot = path.join(appRoot, 'test/fixtures/virtual')
const sourceRoot = path.join(appRoot, 'src')
const aliases = new Map(
  Object.entries({
    'components/Wallet.tsx': 'fakes/Wallet.tsx',
    'api.ts': 'fakes/api.ts',
    'commons-access.ts': 'fakes/commons-access.ts',
    'wallet.ts': 'fakes/wallet.ts',
    'components/side/SideToken.tsx': 'fakes/SideToken.tsx',
  }).map(([original, fake]) => [path.join(sourceRoot, original), path.join(virtualRoot, fake)]),
)
// The release-review harness supplies only auth/transport fixtures; UI and TanStack Query remain real.
const modules = new Map(
  Object.entries(sources).map(([file, code]) => [
    path.join(virtualRoot, file),
    code.replaceAll('__EXPLORE_SOURCE__', sourceRoot),
  ]),
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
      {
        name: 'commons-test-transport',
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
  const entry = bundle.output.find((file) => file.type === 'chunk' && file.isEntry)
  if (!entry) throw new Error('Missing harness entry')
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname.slice(1)
    if (pathname === '') {
      res.setHeader('Content-Type', 'text/html')
      res.end(`<html><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`)
    } else if (files.has(pathname)) {
      res.setHeader('Content-Type', 'application/javascript')
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
async function open(search = '') {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } })
  await page.goto(origin + search)
  await page.getByText('Release plan', { exact: true }).waitFor()
  return page
}
async function postCount(page: Page) {
  return page.evaluate(() => window.__backend.posts.length)
}

it('clears exactly one sign-in post and its reply target, leaving no duplicate enabled', async () => {
  const page = await open()
  try {
    await page.getByRole('button', { name: 'Reply', exact: true }).click()
    await page.getByLabel('Message', { exact: true }).fill('One answer')
    await page.getByRole('button', { name: 'Sign in and post', exact: true }).click()
    await page.waitForFunction(() => window.__backend.posts.length === 1)
    await page.waitForFunction(() => document.querySelector('textarea')?.value === '')
    expect(await postCount(page)).toBe(1)
    expect(await page.getByText(/Replying to/).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Post', exact: true }).isEnabled()).toBe(false)
  } finally {
    await page.close()
  }
})
it('retains the draft and shows a post error after sign-in', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      window.__backend.postError = true
    })
    await page.getByLabel('Message', { exact: true }).fill('Keep this')
    await page.getByRole('button', { name: 'Sign in and post', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Posting failed' }).waitFor()
    expect(await page.getByLabel('Message', { exact: true }).inputValue()).toBe('Keep this')
    expect(await postCount(page)).toBe(0)
  } finally {
    await page.close()
  }
})
it('preserves an attributed choice appended while a post is pending', async () => {
  const page = await open('?signedIn')
  try {
    await page.evaluate(() => {
      window.__backend.postDelayMs = 700
    })
    await page.getByLabel('Message', { exact: true }).fill('First message')
    await page.getByRole('button', { name: 'Post', exact: true }).click()
    await page.getByLabel('Ship', { exact: true }).check()
    await page.getByRole('button', { name: 'Use selection in reply' }).click()
    await page.waitForFunction(() => window.__backend.posts.length === 1)
    await page.waitForFunction(() => !document.querySelector('textarea')?.disabled)
    const draft = await page.getByLabel('Message', { exact: true }).inputValue()
    expect(draft).toMatch(/^Quoted from Commons post #1 by /)
    expect(draft).toContain('> Ship')
    expect(draft).not.toContain('First message')
    expect(await page.getByText(/Replying to/).isVisible()).toBe(true)
  } finally {
    await page.close()
  }
})
it('contains an unavailable plan chunk without losing the editable draft', async () => {
  const page = await open('?signedIn')
  try {
    await page.getByLabel('Message', { exact: true }).fill('Keep my message')
    await page.route('**/AttachmentEditor-*.js', (route) => route.fulfill({ status: 404, body: 'not found' }))
    await page.getByRole('button', { name: 'Attach interactive plan' }).click()
    await page.getByText('Plan editor could not load. Reload to try again.').waitFor()
    expect(await page.getByLabel('Message', { exact: true }).inputValue()).toBe('Keep my message')
    expect(await page.getByRole('button', { name: 'Post', exact: true }).isEnabled()).toBe(true)
  } finally {
    await page.close()
  }
})
it('omits plan reply actions and their caption when the composer is unavailable', async () => {
  const page = await open('?signedIn&nopost')
  try {
    expect(await page.getByLabel('Message', { exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: /Use.*reply/ }).count()).toBe(0)
    expect(await page.getByText(/Choices stay on this page/).count()).toBe(0)
  } finally {
    await page.close()
  }
})
it('folds replies under their post behind a count, and keeps the thread just answered open', async () => {
  const page = await open('?signedIn')
  try {
    await page.getByRole('button', { name: 'Reply', exact: true }).click()
    await page.getByLabel('Message', { exact: true }).fill('A short answer')
    await page.getByRole('button', { name: 'Post', exact: true }).click()
    await page.waitForFunction(() => window.__backend.posts.length === 1)
    const toggle = page.getByRole('button', { name: '1 reply' })
    await toggle.waitFor()
    expect(await toggle.getAttribute('aria-expanded')).toBe('true')
    expect(await page.getByText('A short answer', { exact: true }).isVisible()).toBe(true)
    await toggle.click()
    expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    expect(await page.getByText('A short answer', { exact: true }).count()).toBe(0)
  } finally {
    await page.close()
  }
})
it('does not carry a draft or reply target into a different subject', async () => {
  const page = await open('?signedIn')
  try {
    await page.getByRole('button', { name: 'Reply', exact: true }).click()
    await page.getByLabel('Message', { exact: true }).fill('Only for this thread')
    await page.getByRole('button', { name: 'Go to other job' }).click()
    await page.waitForFunction(() => document.querySelector('textarea')?.value === '')
    expect(await page.getByText(/Replying to/).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Post', exact: true }).isEnabled()).toBe(false)
    expect(await postCount(page)).toBe(0)
  } finally {
    await page.close()
  }
})

it('reports App height to its host and sends an attributed conversation quote', async () => {
  const generated = readFileSync(path.join(appRoot, '../api/src/generated/commons-app.ts'), 'utf8')
  const html: string = JSON.parse(
    generated.slice(generated.indexOf('export const commonsHtml = ') + 'export const commonsHtml = '.length),
  )
  const page = await browser.newPage()
  try {
    await page.evaluate((content) => {
      const messages: any[] = []
      window.__hostMessages = messages
      const frame = document.createElement('iframe')
      window.addEventListener('message', (event) => {
        if (event.source !== frame.contentWindow) return
        const request = event.data
        messages.push(request)
        if (request.method === 'ui/initialize') {
          frame.contentWindow!.postMessage(
            {
              jsonrpc: '2.0',
              id: request.id,
              result: {
                protocolVersion: request.params.protocolVersion,
                hostInfo: { name: 'component-test-host', version: '1' },
                hostCapabilities: { message: { text: {} } },
                hostContext: { theme: 'light' },
              },
            },
            '*',
          )
        } else if (request.method === 'ui/message') {
          frame.contentWindow!.postMessage({ jsonrpc: '2.0', id: request.id, result: {} }, '*')
        }
      })
      frame.srcdoc = content
      document.body.append(frame)
    }, html)
    await page.waitForFunction(() =>
      window.__hostMessages.some(
        (message) => message.method === 'ui/notifications/size-changed' && message.params.height > 0,
      ),
    )
    await page.evaluate(() =>
      document.querySelector('iframe')!.contentWindow!.postMessage(
        {
          jsonrpc: '2.0',
          method: 'ui/notifications/tool-result',
          params: {
            structuredContent: {
              ok: true,
              result: {
                subject: 'lobby',
                hasMore: false,
                messages: [
                  {
                    id: 1,
                    author: '0x2222222222222222222222222222222222222222',
                    body: 'Choose a plan',
                    hidden: null,
                    presentation: {
                      protocol: 'sidequest.commons-ui',
                      version: 1,
                      spec: {
                        root: 'plan',
                        elements: {
                          plan: {
                            type: 'Plan',
                            props: { title: 'Release plan', summary: 'Pick one.' },
                            children: ['q'],
                          },
                          q: { type: 'AskQuestion', props: { question: 'Ready?', options: ['Ship', 'Revise'] } },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        '*',
      ),
    )
    const app = page.frameLocator('iframe')
    await app.getByLabel('Ship', { exact: true }).check()
    await app.getByRole('button', { name: 'Use selection in reply' }).click()
    const quote = await app.getByLabel('Review your conversation draft').inputValue()
    expect(quote).toMatch(/^Quoted from Commons post #1 by /)
    expect(quote).toContain('> Ship')
    await app.getByRole('button', { name: 'Send draft to conversation' }).click()
    await app.getByText('Sent to the conversation. No Commons message has been posted by this view.').waitFor()
    const sent = await page.evaluate(() => window.__hostMessages.find((message) => message.method === 'ui/message'))
    expect(sent?.params.content).toEqual([{ type: 'text', text: quote }])
  } finally {
    await page.close()
  }
})
