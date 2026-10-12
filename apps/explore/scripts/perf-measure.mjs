/** Anonymous sequential cold/warm reloads. Run `bun run --cwd apps/explore perf --help`. */
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { installMetrics, pageMetrics, readiness, trackReads } from './perf-browser.mjs'

const { values } = parseArgs({
  options: {
    origin: { type: 'string', default: 'https://dev.sidequest.exchange' },
    out: { type: 'string', default: '/tmp/sidequest-perf.json' },
    sha: { type: 'string' },
    ci: { type: 'string' },
    browser: { type: 'string' },
    samples: { type: 'string', default: '10' },
    routes: { type: 'string', default: '/jobs,/job/84,/agent/2036,/services' },
    help: { type: 'boolean' },
  },
})
if (values.help) {
  console.log(
    'perf --sha <deployed SHA> --ci <CI URL> --browser <Chromium path> --out <JSON> [--origin URL] [--samples 10] [--routes /jobs,/job/84,/agent/2036,/services]',
  )
  process.exit(0)
}
if (!values.sha || !values.ci)
  throw new Error('Supply the deployed --sha and --ci evidence URL; release.json has no SHA.')
const samples = Number(values.samples)
if (!Number.isInteger(samples) || samples < 1 || samples > 30) throw new Error('samples must be 1..30')
const origin = new URL(values.origin).origin
const routes = values.routes.split(',')
if (routes.some((route) => !/^\/[a-z\d/-]*$/.test(route)))
  throw new Error('Use public route paths without query strings')
const timeoutMs = 20_000
const browser = await chromium.launch({ headless: true, ...(values.browser ? { executablePath: values.browser } : {}) })
const report = {
  schema: 'sidequest.browser-performance.v2',
  startedAt: new Date().toISOString(),
  origin,
  sha: values.sha,
  ci: values.ci,
  browser: browser.version(),
  samples,
  conditions: {
    viewport: '390x844',
    reducedMotion: true,
    cpuThrottle: null,
    networkThrottle: null,
    anonymous: true,
    timeoutMs,
    readiness:
      'Required successful route reads, no pending app/RPC reads, visible h1, no visible skeleton/error, 500ms quiet. Minimum 5s observation; 20s cap.',
    warm: 'Same-context reload; resource cache reused, React Query memory recreated. No edge/RPC cache reset.',
  },
  runs: [],
}
await mkdir(dirname(values.out), { recursive: true })
const save = () => writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`)

async function measure(page, route, kind, sample) {
  const tracker = trackReads(page, origin)
  let pageErrors = 0
  const onError = () => {
    pageErrors++
  }
  page.on('pageerror', onError)
  try {
    const response =
      kind === 'cold'
        ? await page.goto(origin + route, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
        : await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
    const ready = await readiness(page, tracker, route, timeoutMs)
    const metrics = await page.evaluate(pageMetrics)
    const requests = [...tracker.rows.values()]
    return {
      sample,
      route,
      kind,
      status: response?.status(),
      ...ready,
      ...metrics,
      pageErrors,
      requests,
      pending: requests.filter((r) => r.doneMs === undefined).length,
      httpErrors: requests.filter((r) => r.status >= 400 || r.failed).length,
    }
  } catch (error) {
    return {
      sample,
      route,
      kind,
      readyMs: null,
      timedOut: true,
      failure: error.name,
      requests: [...tracker.rows.values()],
    }
  } finally {
    page.off('pageerror', onError)
    tracker.stop()
  }
}

async function measurePair(route, sample) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
  await context.addInitScript(installMetrics)
  const page = await context.newPage()
  try {
    for (const kind of ['cold', 'warm']) {
      const run = await measure(page, route, kind, sample)
      report.runs.push(run)
      await save()
      console.log(
        JSON.stringify({
          sample,
          route,
          kind,
          readyMs: run.readyMs,
          cls: run.cls,
          reads: run.requests.length,
          pending: run.pending,
          errors: run.httpErrors,
        }),
      )
    }
  } finally {
    await context.close()
  }
}

try {
  for (let sample = 0; sample < samples; sample++) {
    for (const route of routes) await measurePair(route, sample)
  }
} finally {
  await browser.close()
  report.finishedAt = new Date().toISOString()
  await save()
}
