/** Local-only cache probe. Also works when copied into the unmodified base's test/ directory. */
import type { Browser, Page } from 'playwright-core'
import { approvalBrowser } from './approval-browser.ts'
import { backend, connectBackend } from './approval-fixture.ts'

const fixture: {
  browser: Browser
  origin?: string
  serve?: (page: Page) => Promise<void>
  close?: () => Promise<void>
} = await approvalBrowser()
const routed = process.argv.includes('--routed')
try {
  console.info(JSON.stringify({ browser: fixture.browser.version(), routed }))
  for (let run = 1; run <= 3; run++) {
    const page = await fixture.browser.newPage()
    await fixture.serve?.(page)
    await connectBackend(page, backend())
    // Control arm: even an unused API route disables caching for every asset.
    if (routed) await page.route('**/api/**', (route) => route.continue())
    const session = await page.context().newCDPSession(page)
    await session.send('Network.enable')
    let cached = new Set<string>()
    let assets = new Set<string>()
    let bytes = 0
    session.on('Network.requestServedFromCache', ({ requestId }) => cached.add(requestId))
    session.on('Network.responseReceived', ({ requestId, type, response }) => {
      if (type !== 'Script' && type !== 'Stylesheet') return
      assets.add(requestId)
      if (response.fromDiskCache) cached.add(requestId)
    })
    session.on('Network.loadingFinished', ({ requestId, encodedDataLength }) => {
      if (assets.has(requestId)) bytes += encodedDataLength
    })
    for (let navigation = 1; navigation <= 3; navigation++) {
      cached = new Set()
      assets = new Set()
      bytes = 0
      const started = performance.now()
      await page.goto(`${fixture.origin ?? 'http://approval.test'}/?approval=v${(navigation % 2) + 1}`)
      await page.getByText('karl-v1', { exact: true }).waitFor()
      console.info(
        JSON.stringify({
          run,
          navigation,
          ms: +(performance.now() - started).toFixed(1),
          assets: assets.size,
          cachedAssets: [...assets].filter((id) => cached.has(id)).length,
          encodedAssetBytes: bytes,
        }),
      )
    }
    await page.close()
  }
} finally {
  if (fixture.close) await fixture.close()
  else await fixture.browser.close()
}
