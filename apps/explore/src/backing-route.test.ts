import { createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBackingRoute } from './backing-route.ts'
import { accountTab } from './account-route.ts'
import { shouldWelcome } from './onboarding.ts'

afterEach(() => vi.unstubAllGlobals())
function fixture(href: string) {
  vi.stubGlobal('window', {
    location: { origin: 'http://localhost' },
    history: {},
    addEventListener() {},
    removeEventListener() {},
  })
  vi.stubGlobal('document', {
    querySelector() {
      return null
    },
  })
  vi.stubGlobal('self', { __TSR_ROUTER__: undefined })
  const root = createRootRoute()
  const history = createMemoryHistory({ initialEntries: ['/services', href] })
  const router = createRouter({
    history,
    isServer: false,
    routeTree: root.addChildren([
      createBackingRoute(root),
      createRoute({ getParentRoute: () => root, path: '/account' }),
      createRoute({ getParentRoute: () => root, path: '/wallet/$address' }),
      createRoute({ getParentRoute: () => root, path: '/services' }),
    ]),
  })
  return { router, history }
}

describe('legacy backing navigation', () => {
  it('replaces the missing route without a broken back/forward entry and survives reload', async () => {
    const { router, history } = fixture('/backing')
    await router.load()
    expect(history.location.href).toBe('/account?tab=backing')
    expect(accountTab(history.location.search)).toBe('backing')
    history.back()
    await router.load()
    expect(history.location.pathname).toBe('/services')
    history.forward()
    await router.load()
    expect(history.location.href).toBe('/account?tab=backing')
    const reloaded = fixture(history.location.href)
    await reloaded.router.load()
    expect(accountTab(reloaded.history.location.search)).toBe('backing')
  })

  it('preserves the Account destination when in-place sign-in completes and setup is unfinished', async () => {
    const { router, history } = fixture('/backing')
    await router.load()
    expect(
      shouldWelcome({
        pathname: history.location.pathname,
        search: history.location.search,
        facts: { funded: false, hasAgent: false, backed: false },
        dismissed: false,
        shown: false,
      }),
    ).toBe(false)
    await router.invalidate()
    expect(history.location.href).toBe('/account?tab=backing')
    expect(accountTab(history.location.search)).toBe('backing')
  })

  it('keeps historical wallet context local and drops attacker-controlled context', async () => {
    for (const [old, next] of [
      [
        '/backing?account=0x0000000000000000000000000000000000000001',
        '/wallet/0x0000000000000000000000000000000000000001',
      ],
      ['/backing?account=https://evil.example', '/account?tab=backing'],
      ['/backing?next=//evil.example', '/account?tab=backing'],
    ]) {
      const { router, history } = fixture(old!)
      await router.load()
      expect(history.location.href).toBe(next)
    }
  })
})
