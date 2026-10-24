import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import { installFetchMock, jsonResponse, type InitScriptRequest } from './init-script-mock.ts'

declare global {
  interface Window {
    __earlyMock: Promise<unknown>
    __abortMock: AbortController
  }
}

const networkRequests: string[] = []
const server = createServer((request, response) => {
  networkRequests.push(request.url ?? '/')
  response.setHeader('Content-Type', request.url === '/asset' ? 'text/plain' : 'text/html')
  response.end(
    request.url === '/asset'
      ? 'real local response'
      : '<script>window.__earlyMock = fetch("/api/early").then(response => response.json())</script>',
  )
})
let browser: Browser
let origin: string
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // SAFETY: listen(0, '127.0.0.1') completed, so this server has an IP socket address.
  const address = server.address() as AddressInfo
  origin = `http://127.0.0.1:${address.port}`
  const executablePath = [chromium.executablePath(), '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
  if (executablePath === undefined) throw new Error('Install Chromium to run fetch fixture regressions')
  browser = await chromium.launch({ executablePath })
}, 30_000)
afterAll(async () => {
  await browser?.close()
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
})

async function opened(handler: Parameters<typeof installFetchMock>[1]): Promise<Page> {
  const page = await browser.newPage()
  await installFetchMock(page, handler)
  await page.goto(origin)
  await page.evaluate(() => window.__earlyMock)
  return page
}

it('mocks the first application fetch, Request overrides and native Response APIs, and passes assets through', async () => {
  const calls: InitScriptRequest[] = []
  const page = await opened(async (request) => {
    calls.push(request)
    return jsonResponse({ path: new URL(request.url).pathname }, 201)
  })
  try {
    expect(await page.evaluate(() => window.__earlyMock)).toEqual({ path: '/api/early' })
    expect(
      await page.evaluate(async () => {
        const request = new Request('/api/write', { method: 'POST', body: 'original', headers: { 'x-test': 'yes' } })
        const response = await fetch(request, { method: 'POST', body: 'override' })
        return {
          status: response.status,
          ok: response.ok,
          header: response.headers.get('content-type'),
          clone: await response.clone().text(),
          json: await response.json(),
          asset: await (await fetch('/asset')).text(),
        }
      }),
    ).toEqual({
      status: 201,
      ok: true,
      header: 'application/json',
      clone: '{"path":"/api/write"}',
      json: { path: '/api/write' },
      asset: 'real local response',
    })
    expect(calls[1]).toMatchObject({ method: 'POST', body: 'override', headers: { 'x-test': 'yes' } })
    expect(networkRequests.some((url) => url.startsWith('/api/'))).toBe(false)
    await page.goto(`${origin}/?second`)
    expect(await page.evaluate(() => window.__earlyMock)).toEqual({ path: '/api/early' })
    expect(calls.filter((request) => request.url.endsWith('/api/early'))).toHaveLength(2)
  } finally {
    await page.close()
  }
})

it('rejects pre-aborted and in-flight requests, and contains late replies after an abort', async () => {
  const held = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  let calls = 0
  const page = await opened(async (request) => {
    if (request.url.endsWith('/api/hold')) {
      calls++
      started.resolve()
      await held.promise
    }
    return jsonResponse({ ok: true })
  })
  try {
    expect(
      await page.evaluate(async () => {
        try {
          await fetch('/api/hold', { signal: AbortSignal.abort() })
          return 'resolved'
        } catch (error) {
          return error instanceof DOMException ? error.name : 'unexpected error'
        }
      }),
    ).toBe('AbortError')
    expect(calls).toBe(0)
    const pending = page.evaluate(async () => {
      window.__abortMock = new AbortController()
      try {
        await fetch('/api/hold', { signal: window.__abortMock.signal })
        return 'resolved'
      } catch (error) {
        return error instanceof DOMException ? error.name : 'unexpected error'
      }
    })
    await started.promise
    await page.evaluate(() => window.__abortMock.abort())
    expect(await pending).toBe('AbortError')
    held.resolve()
    expect(await page.evaluate(async () => (await fetch('/api/next')).ok)).toBe(true)
    expect(calls).toBe(1)
  } finally {
    held.resolve()
    await page.close()
  }
})

it('returns HTTP failures as Responses, network failures as TypeErrors, and isolates pages', async () => {
  const page = await opened(async (request) => {
    if (request.url.endsWith('/api/lost')) throw new Error('fixture lost response')
    return jsonResponse({ unavailable: true }, 503)
  })
  const other = await opened(async () => jsonResponse({ other: true }))
  try {
    expect(
      await page.evaluate(async () => {
        const response = await fetch('/api/unavailable')
        return { status: response.status, ok: response.ok, json: await response.json() }
      }),
    ).toEqual({ status: 503, ok: false, json: { unavailable: true } })
    expect(
      await page.evaluate(async () => {
        try {
          await fetch('/api/lost')
          return false
        } catch (error) {
          return error instanceof TypeError
        }
      }),
    ).toBe(true)
    expect(await other.evaluate(() => window.__earlyMock)).toEqual({ other: true })
  } finally {
    await page.close()
    await other.close()
  }
})
