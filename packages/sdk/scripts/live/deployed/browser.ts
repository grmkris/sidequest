/** Real hosted Chromium, including Privy's own login and signing UI. */
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { type Address, type Hex } from 'viem'
import { join } from 'node:path'
import { ORIGIN, required } from './guards.ts'
import { RunState } from './state.ts'
import { Chain } from './chain.ts'

export interface ManagedAgent {
  id: string
  name: string
  state: string
  operator: Address
  address: Address | null
  agent_id: string | null
  privy_wallet_id: string | null
  privy_user_id: string
}

interface LoginPageState {
  localStorage: { getItem(key: string): string | null }
  document: {
    querySelector(selector: string): unknown | null
    querySelectorAll(selector: string): ArrayLike<{ disabled: boolean; textContent: string | null }>
  }
}

export class HostedBrowser {
  readonly errors: string[] = []
  readonly responses: Array<{ path: string; body: unknown }> = []
  #context: BrowserContext | undefined
  #page: Page | undefined
  #pending = new Set<Promise<void>>()

  constructor(
    /** Where the persistent Chromium profile lives: a run's directory, or an operator's. */
    readonly run: Pick<RunState, 'directory'>,
    readonly chain?: Chain,
  ) {}

  get context(): BrowserContext {
    if (this.#context === undefined) throw new Error('P8_BROWSER_NOT_STARTED')
    return this.#context
  }

  get page(): Page {
    if (this.#page === undefined) throw new Error('P8_BROWSER_NOT_STARTED')
    return this.#page
  }

  async start(readonly = false): Promise<void> {
    if (this.#context !== undefined) return
    this.errors.length = 0
    this.responses.length = 0
    this.#context = await chromium.launchPersistentContext(join(this.run.directory, 'chromium'), {
      headless: true,
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_PATH ??
        '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
      viewport: { width: 1440, height: 900 },
    })
    this.#page = await this.context.newPage()
    this.page.on('pageerror', () => this.errors.push('P8_BROWSER_PAGE_ERROR'))
    this.context.on('response', (response) => {
      const url = new URL(response.url())
      if (url.origin !== ORIGIN || !url.pathname.includes('/api/')) return
      const pending = response
        .json()
        .then((body) => {
          this.responses.push({ path: url.pathname, body })
        })
        .catch(() => {})
        .finally(() => this.#pending.delete(pending))
      this.#pending.add(pending)
    })
    if (readonly) {
      // Abort writes; there is no replacement response and no injected wallet.
      await this.context.route('**/*', async (route) => {
        const request = route.request()
        if (request.method() === 'GET' || request.method() === 'HEAD' || request.method() === 'OPTIONS')
          return route.continue()
        const url = new URL(request.url())
        if (url.origin === ORIGIN && url.pathname === '/api/protocol_info') return route.continue()
        try {
          const payload = request.postDataJSON()
          const calls = Array.isArray(payload) ? payload : [payload]
          const reads = new Set([
            'eth_chainId',
            'eth_call',
            'eth_getCode',
            'eth_getBalance',
            'eth_blockNumber',
            'eth_getBlockByNumber',
            'eth_getTransactionCount',
          ])
          if (calls.every((call) => reads.has(call?.method))) return route.continue()
        } catch {
          // Unknown POSTs stay blocked.
        }
        await route.abort('blockedbyclient')
      })
    }
  }

  async settle(): Promise<void> {
    await Promise.all(this.#pending)
    if (this.errors.length > 0) throw new Error(this.errors[0])
  }

  async operator(): Promise<Address> {
    const owner = await this.page.evaluate(() => {
      const storage = (globalThis as unknown as { localStorage: { getItem(key: string): string | null } }).localStorage
      return JSON.parse(storage.getItem('sidequest.session-owner') ?? 'null') as {
        address?: string
      } | null
    })
    if (owner?.address === undefined || !/^0x[0-9a-fA-F]{40}$/.test(owner.address))
      throw new Error('P8_OPERATOR_SESSION_UNAVAILABLE')
    return owner.address as Address
  }

  /**
   * Signs in through Privy and the board's SIWE prompt. Without `creds`, the Privy test account from the environment
   * (PRIVY_TEST_EMAIL, PRIVY_TEST_OTP); with them, a real email whose code `otp` fetches once it is sent.
   */
  async login(creds?: { email: string; otp: () => Promise<string> }): Promise<Address> {
    await this.page.goto(`${ORIGIN}/agents`, { waitUntil: 'domcontentloaded' })
    const session = await this.page.evaluate(() =>
      (globalThis as unknown as { localStorage: { getItem(key: string): string | null } }).localStorage.getItem(
        'sidequest.session',
      ),
    )
    if (session !== null) {
      // A persisted browser session is accepted only after real authenticated readback.
      try {
        await this.api('/api/agents')
        return await this.operator()
      } catch {
        // The site's normal login handles an expired session.
      }
    }
    const email = this.page.locator('input[type="email"], input[placeholder="your@email.com"]').first()
    const boardSign = this.page.getByRole('button', { name: 'Sign and continue', exact: true }).first()
    // A retained Privy session can open SIWE automatically while disabling Sign in.
    await this.page
      .waitForFunction(
        () => {
          const { document, localStorage } = globalThis as unknown as LoginPageState
          const buttons = Array.from(document.querySelectorAll('button'))
          return (
            buttons.some(
              (button) =>
                (!button.disabled && /^sign in$/i.test(button.textContent?.trim() ?? '')) ||
                /^Sign and continue$/.test(button.textContent?.trim() ?? ''),
            ) ||
            document.querySelector('input[type="email"]') !== null ||
            (localStorage.getItem('sidequest.session') !== null &&
              localStorage.getItem('sidequest.session-owner') !== null)
          )
        },
        undefined,
        { timeout: 30_000 },
      )
      .catch(() => {
        throw new Error('P8_PRIVY_LOGIN_UI_UNAVAILABLE')
      })
    const ready = await this.page.evaluate(() => {
      const { localStorage } = globalThis as unknown as LoginPageState
      return (
        localStorage.getItem('sidequest.session') !== null && localStorage.getItem('sidequest.session-owner') !== null
      )
    })
    if (ready) {
      await this.api('/api/agents')
      return this.operator()
    }
    if (!(await boardSign.isVisible())) {
      if (!(await email.isVisible())) {
        await this.page
          .getByRole('button', { name: /sign in/i })
          .first()
          .click({ timeout: 30_000 })
          .catch(() => {
            throw new Error('P8_PRIVY_LOGIN_OPEN_FAILED')
          })
      }
      await email.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {
        throw new Error('P8_PRIVY_EMAIL_FORM_UNAVAILABLE')
      })
      await email.fill(creds?.email ?? required('PRIVY_TEST_EMAIL'))
      // Privy also offers "Continue with a wallet"; submit only the email form.
      await this.page
        .getByRole('button', { name: 'Submit', exact: true })
        .last()
        .click()
        .catch(() => {
          throw new Error('P8_PRIVY_EMAIL_SUBMIT_FAILED')
        })
      const inputs = this.page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"]')
      await inputs
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(() => {
          throw new Error('P8_PRIVY_OTP_FORM_UNAVAILABLE')
        })
      const otp = creds === undefined ? required('PRIVY_TEST_OTP') : await creds.otp()
      const count = await inputs.count()
      if (count === 1) await inputs.fill(otp)
      else {
        if (count !== otp.length) throw new Error('P8_UNRECOGNIZED_PRIVY_OTP_UI')
        for (let i = 0; i < count; i++) await inputs.nth(i).fill(otp[i]!)
      }
      const verify = this.page.getByRole('button', { name: /^(verify|continue|submit)$/i }).last()
      if (await verify.isVisible()) await verify.click()
    }
    await this.page
      .waitForFunction(
        () => {
          const { document, localStorage } = globalThis as unknown as LoginPageState
          return (
            Array.from(document.querySelectorAll('button')).some((button) =>
              /^Sign and continue$/.test(button.textContent?.trim() ?? ''),
            ) ||
            (localStorage.getItem('sidequest.session') !== null &&
              localStorage.getItem('sidequest.session-owner') !== null)
          )
        },
        undefined,
        { timeout: 90_000 },
      )
      .catch(() => {
        throw new Error('P8_PRIVY_BOARD_SIGN_UNAVAILABLE')
      })
    if (await boardSign.isVisible()) {
      const message = await this.page.locator('#privy-modal-content').innerText()
      if (
        !message.includes(`${new URL(ORIGIN).host} wants you to sign in with your Ethereum account:`) ||
        !message.includes('Chain ID: 10143')
      )
        throw new Error('P8_UNEXPECTED_BOARD_SIGN_MESSAGE')
      await boardSign.click().catch(() => {
        throw new Error('P8_PRIVY_BOARD_SIGN_FAILED')
      })
    }
    await this.page
      .waitForFunction(
        () => {
          const storage = (globalThis as unknown as { localStorage: { getItem(key: string): string | null } })
            .localStorage
          return storage.getItem('sidequest.session') !== null && storage.getItem('sidequest.session-owner') !== null
        },
        undefined,
        { timeout: 90_000 },
      )
      .catch(() => {
        throw new Error('P8_PRIVY_BOARD_SESSION_UNAVAILABLE')
      })
    await this.api('/api/agents')
    return this.operator()
  }

  async api<T = Record<string, unknown>>(path: string, body?: Record<string, unknown>): Promise<T> {
    if (!path.startsWith('/api/') && !path.startsWith('/oauth/')) throw new Error('P8_UNEXPECTED_BROWSER_API')
    const reply = await this.page.evaluate(
      async ({ endpoint, payload }) => {
        const storage = (globalThis as unknown as { localStorage: { getItem(key: string): string | null } })
          .localStorage
        const token = storage.getItem('sidequest.session')
        const response = await fetch(endpoint, {
          method: payload === undefined ? 'GET' : 'POST',
          headers: {
            ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        })
        const json = (await response.json()) as { ok?: boolean; result?: unknown }
        return { status: response.status, ok: json.ok, result: json.result ?? json }
      },
      { endpoint: path, payload: body },
    )
    if (reply.status < 200 || reply.status >= 300 || reply.ok === false)
      throw new Error('P8_HOSTED_BROWSER_API_REFUSED')
    return reply.result as T
  }

  async click(label: string, reservation?: { key: string; gas: bigint }): Promise<void> {
    if (reservation !== undefined) {
      if (this.chain === undefined) throw new Error('P8_BROWSER_SPEND_GUARD_UNAVAILABLE')
      await this.chain.reserve(reservation.key, reservation.gas)
    }
    await this.page.getByRole('button', { name: label, exact: true }).click({ timeout: 30_000 })
  }

  async cachedHashes(): Promise<Hex[]> {
    await this.settle()
    const hashes = new Set<Hex>()
    const visit = (value: unknown, name = ''): void => {
      if (typeof value === 'string' && /tx_hash|txHash|transactionHash/.test(name) && /^0x[0-9a-fA-F]{64}$/.test(value))
        hashes.add(value as Hex)
      else if (Array.isArray(value)) value.forEach((item) => visit(item, name))
      else if (value !== null && typeof value === 'object')
        Object.entries(value).forEach(([key, item]) => visit(item, key))
    }
    this.responses.forEach((response) => visit(response.body))
    const journals = await this.page.evaluate(() => {
      const storage = (globalThis as unknown as { localStorage: Storage }).localStorage
      return Object.keys(storage)
        .filter((key) => key.startsWith('sidequest.op:'))
        .map((key) => JSON.parse(storage.getItem(key) ?? 'null') as { hashes?: unknown[] })
    })
    for (const journal of journals) {
      for (const hash of journal?.hashes ?? []) {
        if (typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash)) hashes.add(hash as Hex)
      }
    }
    return [...hashes]
  }

  async close(): Promise<void> {
    try {
      await this.settle()
    } finally {
      await this.#context?.close()
      this.#context = undefined
      this.#page = undefined
    }
  }
}
