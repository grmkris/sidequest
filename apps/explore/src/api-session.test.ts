import { afterEach, expect, it, vi } from 'vitest'

// The test imports api.ts cold after resetModules (the SDK and viem with it), which takes over 5 s on a loaded runner.
vi.setConfig({ testTimeout: 20_000 })

/** A browser that refuses every storage call, as some private windows and blocked-site settings do. */
const refusing = {
  getItem: () => {
    throw new DOMException('Blocked', 'SecurityError')
  },
  setItem: () => {
    throw new DOMException('Blocked', 'SecurityError')
  },
  removeItem: () => {
    throw new DOMException('Blocked', 'SecurityError')
  },
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('keeps a session in the page when both stores refuse it, so the page’s requests stay signed in', async () => {
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), { location: { pathname: '/', origin: 'http://test.local' } }),
  )
  vi.stubGlobal('localStorage', refusing)
  vi.stubGlobal('sessionStorage', refusing)
  const sent: (string | null)[] = []
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    sent.push(new Headers(init?.headers).get('authorization'))
    return Response.json({ agents: [] })
  })
  const api = await import('./api.ts')
  api.setSession('page-session')
  expect(api.session()).toBe('page-session')
  await api.agentEndpoint('/api/agents')
  expect(sent.at(-1)).toContain('page-session')
  api.setSession(null)
  expect(api.session()).toBeNull()
})
