import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { Browser, Page } from 'playwright-core'
import { approvalBrowser } from './approval-browser.ts'
import { backend, connectBackend } from './approval-fixture.ts'

// Real Chromium: on a shared CI runner the three browser suites run in parallel, and a step can take seconds.
vi.setConfig({ testTimeout: 20_000 })

declare global {
  interface Window {
    __approvalHarness: { sign: (() => void) | null }
  }
}

let browser: Browser
let closeFixture: () => Promise<void>
let origin: string
beforeAll(async () => {
  const fixture = await approvalBrowser()
  browser = fixture.browser
  origin = fixture.origin
  closeFixture = fixture.close
}, 30_000)
afterAll(async () => closeFixture?.())

async function open(state = backend(), search = '') {
  const page = await browser.newPage({ viewport: { width: 800, height: 900 } })
  page.setDefaultTimeout(3000)
  await connectBackend(page, state)
  await page.goto(`${origin}/?${search}`)
  return { page, state }
}

it.each([390, 1280])(
  'shows distinct same-title requests and rejects only the chosen request at %ipx',
  async (width) => {
    const { page, state } = await open()
    try {
      await page.setViewportSize({ width, height: 900 })
      await page.getByText('Open to all', { exact: false }).waitFor()
      await page.getByText('Reserved for Agent Minimum', { exact: false }).waitFor()
      await page.getByText('karl-v1', { exact: true }).waitFor()
      await page.getByText('karl-v2', { exact: true }).waitFor()
      expect(await page.getByText('A 4cm eulogy for Karl', { exact: true }).count()).toBe(2)
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
      await page.locator('#approval-v2').getByRole('button', { name: 'Reject', exact: true }).click()
      await page.getByRole('button', { name: 'Reject hire', exact: true }).click()
      await page.getByRole('status').filter({ hasText: 'Request rejected' }).waitFor()
      expect(state.writes).toEqual([{ path: '/api/approvals/v2/decide', body: { approved: false } }])
      expect(state.approvals.map((a) => a.status)).toEqual(['pending', 'rejected'])
      await page.locator('#approval-v1').getByRole('button', { name: 'Review exact budget' }).waitFor()
    } finally {
      await page.close()
    }
  },
)

it('shows a useful read error and keeps retry available', async () => {
  const state = backend()
  state.approvalsError = true
  const { page } = await open(state)
  try {
    await page.getByRole('alert').filter({ hasText: 'decision may already be saved' }).waitFor()
    await page.getByRole('button', { name: 'Retry reading approvals' }).waitFor()
    state.approvalsError = false
    await page.getByRole('button', { name: 'Retry reading approvals' }).click()
    await page.getByText('Reserved for Agent Minimum', { exact: false }).waitFor()
    expect(state.writes).toEqual([])
  } finally {
    await page.close()
  }
})

it('recovers a direct approval link after the operator read fails', async () => {
  const state = backend()
  state.agentError = true
  const { page } = await open(state, 'signedIn&approval=v1')
  try {
    await page.getByRole('alert').filter({ hasText: 'approval link is preserved' }).waitFor()
    state.agentError = false
    await page.getByRole('button', { name: 'Retry operator access' }).click()
    await page.locator('#approval-v1[data-focus]').waitFor()
    expect(state.writes).toEqual([])
  } finally {
    await page.close()
  }
})

it('preserves the linked request through sign-in without approving anything', async () => {
  const { page, state } = await open(backend(), 'signedOut&approval=v2')
  try {
    await page.getByRole('button', { name: 'Sign in to view approval' }).click()
    await page.locator('#approval-v2[data-focus]').waitFor()
    expect(new URL(page.url()).searchParams.get('approval')).toBe('v2')
    expect(state.writes).toEqual([])
  } finally {
    await page.close()
  }
})

it('opens the linked rejected request with its brief, and warns for a missing link', async () => {
  const state = backend()
  state.approvals[1]!.status = 'rejected'
  const { page } = await open(state, 'approval=v2')
  try {
    await page.locator('details#approval-v2[open]').waitFor()
    await page.getByText('Reserved for Agent Minimum', { exact: false }).waitFor()
    await page.goto(`${origin}/?approval=missing`)
    await page.getByRole('alert').filter({ hasText: 'linked approval was not found' }).waitFor()
    expect(state.writes).toEqual([])
  } finally {
    await page.close()
  }
})

it('reuses script and style cache across navigation while reading fresh approval state', async () => {
  const { page, state } = await open()
  try {
    await page.getByText('karl-v1', { exact: true }).waitFor()
    const session = await page.context().newCDPSession(page)
    await session.send('Network.enable')
    const cached = new Set<string>()
    const assets = new Set<string>()
    session.on('Network.requestServedFromCache', ({ requestId }) => cached.add(requestId))
    session.on('Network.responseReceived', ({ requestId, type, response }) => {
      if (type !== 'Script' && type !== 'Stylesheet') return
      assets.add(requestId)
      if (response.fromDiskCache) cached.add(requestId)
    })
    state.approvals[1]!.status = 'rejected'
    const reads = state.reads
    await page.goto(`${origin}/?approval=v2`)
    await page.locator('details#approval-v2[open]').waitFor()
    expect(state.reads).toBeGreaterThan(reads)
    expect(assets.size).toBeGreaterThan(0)
    expect([...assets].every((id) => cached.has(id))).toBe(true)
  } finally {
    await page.close()
  }
})

it('keeps requests to another origin behind the harness CSP rather than mocking them', async () => {
  const { page } = await open()
  try {
    // Another loopback origin exercises the external-traffic fence without contacting an external host.
    const otherOrigin = `http://localhost:${new URL(origin).port}/api/agents`
    expect(
      await page.evaluate(async (target) => {
        const violation = new Promise<string>((resolve) => {
          window.addEventListener('securitypolicyviolation', (event) => resolve(event.effectiveDirective), {
            once: true,
          })
        })
        const blocked = await fetch(target).then(
          () => false,
          () => true,
        )
        return { blocked, directive: await violation }
      }, otherOrigin),
    ).toEqual({ blocked: true, directive: 'connect-src' })
  } finally {
    await page.close()
  }
})

it('does not enable signing when the frozen brief could not be verified', async () => {
  const state = backend()
  state.approvals[1]!.context!.hire = null
  const { page } = await open(state)
  try {
    const card = page.locator('#approval-v2')
    await card.getByText('The exact hire brief is unavailable.', { exact: false }).waitFor()
    expect(await card.getByRole('button', { name: 'Review exact budget' }).isDisabled()).toBe(true)
    expect(state.writes).toEqual([])
  } finally {
    await page.close()
  }
})

it('shows each loading phase and then the same direct-link request', async () => {
  const state = backend()
  const agents = Promise.withResolvers<void>()
  const approvals = Promise.withResolvers<void>()
  state.holdAgents = agents.promise
  state.holdApprovals = approvals.promise
  const { page } = await open(state, 'approval=v2')
  try {
    await page.getByRole('status').filter({ hasText: 'Loading your agent' }).waitFor()
    agents.resolve()
    await page.getByRole('status').filter({ hasText: 'Loading this agent' }).waitFor()
    approvals.resolve()
    await page.locator('#approval-v2[data-focus]').waitFor()
    expect(state.writes).toEqual([])
  } finally {
    agents.resolve()
    approvals.resolve()
    await page.close()
  }
})

it('bounds a stalled approvals read and lets the operator retry it', async () => {
  const state = backend()
  const blocked = Promise.withResolvers<void>()
  state.holdApprovals = blocked.promise
  const { page } = await open(state)
  try {
    await page.getByRole('status').filter({ hasText: 'Loading this agent' }).waitFor()
    await page.getByRole('button', { name: 'Retry reading approvals' }).waitFor({ timeout: 18_000 })
    blocked.resolve()
    await page.getByRole('button', { name: 'Retry reading approvals' }).click()
    await page.getByText('karl-v1', { exact: true }).waitFor()
    expect(state.writes).toEqual([])
  } finally {
    blocked.resolve()
    await page.close()
  }
}, 25_000)

async function sign(page: Page) {
  const card = page.locator('#approval-v2')
  await card.getByRole('button', { name: 'Review exact budget' }).click()
  await expect.poll(() => card.getByRole('button', { name: 'Sign and approve hire' }).isEnabled()).toBe(true)
  await card.getByRole('button', { name: 'Sign and approve hire' }).click()
  await card.getByRole('status').filter({ hasText: 'Waiting for your wallet signature' }).waitFor()
  expect(await card.getByRole('button', { name: 'Sign and approve hire' }).isDisabled()).toBe(true)
  await page.waitForFunction(() => window.__approvalHarness.sign !== null)
  await page.evaluate(() => window.__approvalHarness.sign!())
}

it('keeps an in-flight card disabled when polling moves it to approved, then shows pending execution', async () => {
  const state = backend()
  state.outcome = 'pending'
  const decision = Promise.withResolvers<void>()
  state.holdDecision = decision.promise
  const { page } = await open(state)
  try {
    await page.clock.install()
    await sign(page)
    await page.getByRole('status').filter({ hasText: 'Saving approval' }).waitFor()
    await page.clock.fastForward(10_001)
    await page.getByText('This is taking longer than usual.', { exact: false }).waitFor()
    await expect.poll(() => state.approvals[1]!.status).toBe('approved')
    await page.getByRole('button', { name: 'Refresh approvals' }).click()
    const retry = page
      .locator('#approval-v2')
      .getByRole('button', { name: 'Reconcile and continue approved operation' })
    await retry.waitFor()
    expect(await retry.isDisabled()).toBe(true)
    decision.resolve()
    await page.getByRole('status').filter({ hasText: 'execution is not confirmed' }).waitFor()
    await expect.poll(() => retry.isEnabled()).toBe(true)
    expect(state.writes.filter((w) => w.path.endsWith('/decide'))).toHaveLength(1)
  } finally {
    decision.resolve()
    await page.close()
  }
})

it('keeps the confirmation receipt after the card moves into history during the post', async () => {
  const state = backend()
  const decision = Promise.withResolvers<void>()
  state.holdDecision = decision.promise
  const { page } = await open(state)
  try {
    await sign(page)
    await expect.poll(() => state.approvals[1]!.status).toBe('approved')
    state.approvals[1]!.status = 'executed'
    await page.getByRole('button', { name: 'Refresh approvals' }).click()
    await page.locator('details#approval-v2').waitFor()
    decision.resolve()
    await page.getByRole('status').filter({ hasText: 'karl-v2: Operation confirmed.' }).waitFor()
    expect(state.writes.filter((w) => w.path.endsWith('/decide'))).toHaveLength(1)
    expect(await page.locator('#approval-v2').getByRole('button', { name: 'Sign and approve hire' }).count()).toBe(0)
  } finally {
    decision.resolve()
    await page.close()
  }
})

it.each(['reverted', 'dropped'])(
  'reports a %s reconciliation instead of silently clearing the card',
  async (outcome) => {
    const state = backend()
    state.approvals[1]!.status = 'approved'
    state.outcome = outcome
    const { page } = await open(state)
    try {
      await page
        .locator('#approval-v2')
        .getByRole('button', { name: 'Reconcile and continue approved operation' })
        .click()
      await page.getByRole('status').filter({ hasText: outcome }).waitFor()
      expect(state.writes.map((w) => w.path)).toEqual(['/api/approvals/v2/retry'])
    } finally {
      await page.close()
    }
  },
)

it('reads back a lost decision response without resubmitting and disables stale actions on read failure', async () => {
  const state = backend()
  state.loseResponse = true
  const decision = Promise.withResolvers<void>()
  state.holdDecision = decision.promise
  const { page } = await open(state)
  try {
    await sign(page)
    await expect.poll(() => state.approvals[1]!.status).toBe('approved')
    state.approvalsError = true
    decision.resolve()
    await page.getByRole('alert').filter({ hasText: 'decision may already be saved' }).waitFor()
    expect(await page.locator('#approval-v2').getByRole('button', { name: 'Sign and approve hire' }).isDisabled()).toBe(
      true,
    )
    state.approvalsError = false
    await page.getByRole('button', { name: 'Retry reading approvals' }).click()
    await page.locator('details#approval-v2').waitFor()
    expect(state.writes.filter((w) => w.path.endsWith('/decide'))).toHaveLength(1)
  } finally {
    decision.resolve()
    await page.close()
  }
})
