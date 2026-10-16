/** Local browser and real process-restart proof. Reuses Explore's installed Playwright. */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '../../apps/explore/node_modules/playwright-core'
import type { Page } from '../../apps/explore/node_modules/playwright-core'
import type { Snapshot, SimulatedReceipt } from './store.ts'

const directory = mkdtempSync(join(tmpdir(), 'commons-browser-'))
const evidence = process.env.COMMONS_PREVIEW_EVIDENCE ?? join(import.meta.dir, 'evidence')
mkdirSync(evidence, { recursive: true })

function launch(port: string) {
  return Bun.spawn(['bun', join(import.meta.dir, 'server.ts')], {
    env: { ...process.env, COMMONS_PREVIEW_DATA: directory, COMMONS_PREVIEW_PORT: port },
    stdout: 'pipe',
    stderr: 'inherit',
  })
}

async function address(child: ReturnType<typeof launch>): Promise<string> {
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let output = ''
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) throw new Error('Preview server exited before listening.')
      output += decoder.decode(next.value)
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0]
      if (url) return url
    }
  } finally {
    reader.releaseLock()
  }
}

async function state(url: string): Promise<Snapshot & { simulatedReceipts: SimulatedReceipt[]; boot: string }> {
  // SAFETY: the response is exclusively from this test's local preview server.
  return (await (await fetch(`${url}api/state`)).json()) as Snapshot & {
    simulatedReceipts: SimulatedReceipt[]
    boot: string
  }
}

async function capture(page: Page, name: string): Promise<void> {
  const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
  assert.ok(geometry.scroll <= geometry.width, `${name}: no horizontal overflow`)
  const targets = await page.locator('button').evaluateAll((buttons) =>
    buttons.map((b) => ({
      label: b.textContent,
      height: b.getBoundingClientRect().height,
    })),
  )
  assert.ok(
    targets.every((target) => target.height >= 44),
    `${name}: 44px button targets`,
  )
  await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true })
}

async function deliver(page: Page, title: string): Promise<void> {
  const ticket = page.getByRole('article', { name: title })
  await ticket.getByRole('button', { name: 'Start simulated work' }).click()
  await ticket.getByRole('button', { name: 'Submit example delivery' }).click()
  await ticket.getByRole('button', { name: 'Accept delivery' }).click()
}

let child = launch('0')
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  browser = await chromium.launch({ headless: true })
  const url = await address(child)
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(url)
  await page.getByRole('button', { name: 'Approve plan · 300 demo credits' }).waitFor()
  await capture(page, 'desktop-plan')
  await page.setViewportSize({ width: 390, height: 844 })
  await capture(page, 'phone-plan')
  await page.getByRole('button', { name: 'Approve plan · 300 demo credits' }).click()
  const first = page.getByRole('article', { name: 'Map the onboarding gaps' })
  await first.getByRole('button', { name: 'Start simulated work' }).click()
  await first.getByRole('button', { name: 'Submit example delivery' }).click()
  await first.getByRole('button', { name: 'Request changes' }).click()
  assert.equal(await page.getByRole('article', { name: 'Write the first-hire guide' }).getByRole('button').count(), 0)
  await first.getByRole('button', { name: 'Retry simulated work' }).click()
  await first.getByRole('button', { name: 'Submit example delivery' }).click()
  await first.getByRole('button', { name: 'Accept delivery' }).click()
  await first.getByRole('button', { name: 'Pay & lose reply' }).click()
  await first.getByRole('button', { name: 'Reconcile payment' }).waitFor()
  await capture(page, 'phone-pending')
  const pending = await state(url)
  assert.equal(pending.simulatedReceipts.length, 1)
  assert.equal(pending.mission.tickets[0]?.payment, 'pending')
  child.kill('SIGKILL')
  await child.exited
  child = launch(new URL(url).port)
  await address(child)
  await page.reload()
  await first.getByRole('button', { name: 'Reconcile payment' }).waitFor()
  const restarted = await state(url)
  assert.notEqual(restarted.boot, pending.boot)
  assert.deepEqual(restarted.journal, pending.journal)
  assert.deepEqual(restarted.simulatedReceipts, pending.simulatedReceipts)
  await page.getByRole('button', { name: 'Reload from disk' }).click()
  await page.getByRole('status').filter({ hasText: 'Reopened' }).waitFor()
  await first.getByRole('button', { name: 'Reconcile payment' }).click()
  await first.getByText('Paid · simulated', { exact: true }).waitFor()
  const recovered = await state(url)
  assert.deepEqual(recovered.simulatedReceipts, pending.simulatedReceipts)
  await deliver(page, 'Write the first-hire guide')
  await page
    .getByRole('article', { name: 'Write the first-hire guide' })
    .getByRole('button', { name: 'Simulate payment', exact: true })
    .click()
  await deliver(page, 'Check the guide end to end')
  await page
    .getByRole('article', { name: 'Check the guide end to end' })
    .getByRole('button', { name: 'Simulate payment', exact: true })
    .click()
  await page.getByText('300 demo credits', { exact: true }).last().waitFor()
  await capture(page, 'phone-complete')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await capture(page, 'desktop-complete')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: 'Refresh', exact: true }).focus()
  await page.keyboard.press('Tab')
  const focus = await page.evaluate(() => getComputedStyle(document.activeElement ?? document.body).outlineStyle)
  assert.equal(focus, 'solid')
  const completed = await state(url)
  assert.ok(completed.mission.tickets.every((ticket) => ticket.payment === 'confirmed'))
  assert.equal(completed.simulatedReceipts.length, 3)
  assert.equal(
    completed.simulatedReceipts.reduce((sum, receipt) => sum + receipt.amount, 0),
    300,
  )
  assert.deepEqual(errors, [])
  await Bun.write(
    join(evidence, 'browser-result.json'),
    JSON.stringify(
      {
        result: 'pass',
        viewports: [1440, 390],
        processRestart: 'SIGKILL and fresh process',
        duplicatePayments: 0,
        simulatedReceipts: completed.simulatedReceipts.length,
        totalDemoCredits: 300,
        pageErrors: errors,
        journal: completed.journal,
      },
      null,
      2,
    ),
  )
  console.info(
    `PASS: desktop + 390px phone, rework, SIGKILL recovery, reconciliation, 3 receipts / 300 demo credits. Evidence: ${evidence}`,
  )
} finally {
  child.kill()
  await child.exited
  await browser?.close()
  rmSync(directory, { recursive: true })
}
