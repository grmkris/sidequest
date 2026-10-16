/** Local browser and real process-restart proof. Uses the repository's pinned Playwright. */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import type { Page } from 'playwright-core'
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

/** Every scheduler step below is driven through a visible UI control. */
async function clickCommand(page: Page, key: string): Promise<void> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (reply) =>
        reply.url().endsWith('/api/command') && reply.request().postDataJSON()?.action === key.split('-').at(-1),
    ),
    page.locator(`[data-key="${key}"]`).click(),
  ])
  assert.equal(response.status(), 200, await response.text())
  // SAFETY: this is the local same-origin command response, whose envelope is checked by the status above.
  const saved = (await response.json()) as Snapshot
  await page.waitForFunction(
    (revision) => document.getElementById('journal-count')?.textContent?.includes(`${revision} saved events`),
    saved.revision,
  )
}

async function advanceTo(page: Page, url: string, minute: number): Promise<void> {
  while (((await state(url)).mission.simulation?.elapsed ?? 0) < minute) await clickCommand(page, '-advance')
}

async function startSimulation(page: Page, mode: 'parallel' | 'sequential'): Promise<void> {
  await clickCommand(page, '-new_run')
  await clickCommand(page, '-approve')
  await page.getByRole('button', { name: mode === 'parallel' ? 'Parallel' : 'Sequential', exact: true }).click()
  await clickCommand(page, mode === 'parallel' ? '-run_parallel' : '-run_sequential')
}

async function finishSimulation(page: Page, url: string, mode: 'parallel' | 'sequential'): Promise<void> {
  // Parallel resumes from the saved power-cut checkpoint; sequential starts at zero.
  if (mode === 'sequential') {
    await advanceTo(page, url, 8)
    assert.equal((await state(url)).mission.tickets[1]?.status, 'waiting')
    await clickCommand(page, '01-accept')
  }
  if (mode === 'parallel') {
    await advanceTo(page, url, 8)
    await clickCommand(page, '01-accept')
    await clickCommand(page, '01-lose_reply')
    await clickCommand(page, '01-reconcile')
  }
  await advanceTo(page, url, mode === 'parallel' ? 12 : 20)
  assert.equal((await state(url)).mission.tickets[2]?.status, 'waiting')
  await clickCommand(page, '02-accept')
  await advanceTo(page, url, mode === 'parallel' ? 22 : 30)
  await clickCommand(page, '03-accept')
  await advanceTo(page, url, mode === 'parallel' ? 28 : 36)
  await clickCommand(page, '04-accept')
  assert.equal((await state(url)).mission.simulation?.status, 'complete')
  for (const ticket of (await state(url)).mission.tickets) {
    if (ticket.payment === 'none') await clickCommand(page, `${ticket.id}-pay`)
  }
}

async function manualWalkthrough(page: Page, url: string, restart: () => Promise<void>): Promise<void> {
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
  await restart()
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
  await deliver(page, 'Check worker and approver needs')
  await page
    .getByRole('article', { name: 'Check worker and approver needs' })
    .getByRole('button', { name: 'Simulate payment', exact: true })
    .click()
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
  assert.equal(completed.simulatedReceipts.length, 4)
  assert.equal(
    completed.simulatedReceipts.reduce((sum, receipt) => sum + receipt.amount, 0),
    300,
  )
}

let child = launch('0')
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  browser = await chromium.launch({ headless: true })
  const url = await address(child)
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await manualWalkthrough(page, url, async () => {
    child.kill('SIGKILL')
    await child.exited
    child = launch(new URL(url).port)
    await address(child)
  })
  await startSimulation(page, 'parallel')
  await page.waitForFunction(() => (document.querySelector('progress')?.value ?? 0) >= 1)
  await page.getByRole('button', { name: 'Pause playback' }).click()
  await advanceTo(page, url, 2)
  await capture(page, 'desktop-parallel')
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal((await state(url)).mission.tickets.filter((t) => t.status === 'running').length, 2)
  await capture(page, 'phone-parallel')
  await clickCommand(page, '-interrupt')
  const interrupted = await state(url)
  assert.equal(interrupted.mission.simulation?.status, 'interrupted')
  child.kill('SIGKILL')
  await child.exited
  child = launch(new URL(url).port)
  await address(child)
  await page.reload()
  const restarted = await state(url)
  assert.notEqual(restarted.boot, interrupted.boot)
  assert.deepEqual(restarted.journal, interrupted.journal)
  await page.getByRole('button', { name: 'Resume saved run' }).click()
  await page.getByRole('button', { name: 'Pause playback' }).click()
  await finishSimulation(page, url, 'parallel')
  const parallel = await state(url)
  assert.equal(parallel.mission.simulation?.elapsed, 28)
  assert.ok(parallel.mission.tickets.every((ticket) => ticket.attempt === 1))
  assert.equal(parallel.simulatedReceipts.length, 8)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await capture(page, 'desktop-parallel-complete')
  await startSimulation(page, 'sequential')
  await page.getByRole('button', { name: 'Pause playback' }).click()
  assert.equal((await state(url)).mission.tickets.filter((t) => t.status === 'running').length, 1)
  await capture(page, 'desktop-sequential')
  await page.setViewportSize({ width: 390, height: 844 })
  await capture(page, 'phone-sequential')
  await finishSimulation(page, url, 'sequential')
  const sequential = await state(url)
  assert.equal(sequential.mission.simulation?.mode, 'sequential')
  assert.equal(sequential.mission.simulation?.elapsed, 36)
  assert.equal(sequential.simulatedReceipts.length, 12)
  assert.equal(new Set(sequential.simulatedReceipts.map((r) => r.operationId)).size, 12)
  assert.equal(
    sequential.simulatedReceipts.reduce((sum, r) => sum + r.amount, 0),
    900,
  )
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: 'Refresh', exact: true }).focus()
  await page.keyboard.press('Tab')
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.activeElement ?? document.body).outlineStyle),
    'solid',
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
        simulatedReceipts: sequential.simulatedReceipts.length,
        simulations: { parallelMinutes: 28, sequentialMinutes: 36 },
        historyRetained: true,
        totalDemoCredits: 900,
        pageErrors: errors,
        journal: sequential.journal,
      },
      null,
      2,
    ),
  )
  console.info(
    `PASS: graph, parallel/sequential simulation, power-cut recovery, 12 receipts / 900 demo credits. Evidence: ${evidence}`,
  )
} finally {
  child.kill()
  await child.exited
  await browser?.close()
  rmSync(directory, { recursive: true })
}
