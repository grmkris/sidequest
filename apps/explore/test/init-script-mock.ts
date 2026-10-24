import type { Page } from 'playwright-core'

export interface InitScriptRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
}

export interface InitScriptResponse {
  status?: number
  headers?: Record<string, string>
  body: string
}

type InitScriptHandler = (request: InitScriptRequest) => Promise<InitScriptResponse>

declare global {
  interface Window {
    __sidequestMockFetch: InitScriptHandler
  }
}

/** Install a typed in-page fetch mock without registering a Playwright route (which disables Chromium's HTTP cache). */
export async function installFetchMock(page: Page, handler: InitScriptHandler): Promise<void> {
  await page.exposeFunction('__sidequestMockFetch', handler)
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)
      if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return originalFetch(input, init)
      const request = new Request(input, init)
      request.signal.throwIfAborted()
      const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.clone().text()
      request.signal.throwIfAborted()
      const aborted = Promise.withResolvers<never>()
      const abort = () => aborted.reject(request.signal.reason)
      request.signal.addEventListener('abort', abort, { once: true })
      try {
        const reply = await Promise.race([
          window
            .__sidequestMockFetch({
              url: request.url,
              method: request.method,
              headers: Object.fromEntries(request.headers.entries()),
              body,
            })
            .catch(() => {
              throw new TypeError('Failed to fetch')
            }),
          aborted.promise,
        ])
        return new Response(reply.body, {
          status: reply.status ?? 200,
          ...(reply.headers === undefined ? {} : { headers: reply.headers }),
        })
      } finally {
        request.signal.removeEventListener('abort', abort)
      }
    }
  })
}

export const jsonResponse = (body: unknown, status = 200): InitScriptResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
