/** Installed before each document; CLS uses the maximum session window. */
export function installMetrics() {
  window.__perf = { lcp: 0, cls: 0, blockingMs: 0 }
  let first = 0
  let last = 0
  let sum = 0
  for (const type of ['largest-contentful-paint', 'layout-shift', 'longtask']) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (type === 'largest-contentful-paint') window.__perf.lcp = entry.startTime
        if (type === 'longtask') window.__perf.blockingMs += Math.max(0, entry.duration - 50)
        if (type !== 'layout-shift' || entry.hadRecentInput) continue
        if (entry.startTime - last > 1000 || entry.startTime - first > 5000) {
          first = entry.startTime
          sum = 0
        }
        last = entry.startTime
        sum += entry.value
        window.__perf.cls = Math.max(window.__perf.cls, sum)
      }
    }).observe({ type, buffered: true })
  }
}

function pageState() {
  const main = document.querySelector('main') ?? document
  const headings = [...main.querySelectorAll('h1')]
    .filter((element) => element.getBoundingClientRect().height > 0)
    .map((h) => h.textContent.trim())
  return {
    headings,
    skeletons: [...main.querySelectorAll('[data-slot="skeleton"]')].filter(
      (element) => element.getBoundingClientRect().height > 0,
    ).length,
    errorState: /not indexed yet|not an? (?:Agent|Job) ID|not found|unavailable right now|couldn.t load/i.test(
      main.textContent,
    ),
  }
}

export function pageMetrics() {
  const resources = performance.getEntriesByType('resource')
  const scripts = resources.filter((r) => new URL(r.name).pathname.endsWith('.js'))
  return {
    ...window.__perf,
    title: document.title,
    scripts: scripts.length,
    scriptTransferBytes: scripts.reduce((n, r) => n + r.transferSize, 0),
    scriptDecodedBytes: scripts.reduce((n, r) => n + r.decodedBodySize, 0),
    assetFingerprint: scripts.map((r) => new URL(r.name).pathname).toSorted(),
    overflow: document.documentElement.scrollWidth > innerWidth,
    observedMs: performance.now(),
  }
}

/** No query strings, request bodies, response bodies, auth headers, or RPC URL paths in receipts. */
function requestInfo(request, origin) {
  const url = new URL(request.url())
  let calls = []
  try {
    const body = request.postDataJSON()
    calls = (Array.isArray(body) ? body : [body]).flatMap((call) =>
      /^eth_|^net_|^web3_/.test(call?.method) ? [call.method] : [],
    )
  } catch {
    /* GETs and non-JSON requests have no RPC methods. */
  }
  const app = url.origin === origin && /^\/(?:data|api)\//.test(url.pathname)
  if (!app && calls.length === 0) return null
  return {
    kind: app ? 'app' : 'rpc',
    path: app
      ? url.pathname
          .replace(/0x[a-f\d]{40,}/gi, ':address')
          .replace(/\/deliverables\/[^/]+\/[^/]+/g, '/deliverables/:task/:hash')
      : '[rpc]',
    rpcMethods: calls,
  }
}

export function trackReads(page, origin) {
  const rows = new Map()
  const start = performance.now()
  const elapsed = () => performance.now() - start
  const onRequest = (request) => {
    const info = requestInfo(request, origin)
    if (info !== null) rows.set(request, { ...info, startMs: elapsed() })
  }
  const onResponse = (response) => {
    const row = rows.get(response.request())
    if (row === undefined) return
    const headers = response.headers()
    Object.assign(row, {
      status: response.status(),
      requestId: headers['x-request-id'] ?? null,
      serverTiming: headers['server-timing'] ?? null,
    })
  }
  const onFinished = (request) => {
    const row = rows.get(request)
    if (row !== undefined) row.doneMs = elapsed()
  }
  const onFailed = (request) => {
    const row = rows.get(request)
    if (row !== undefined) Object.assign(row, { failed: true, doneMs: elapsed() })
  }
  page.on('request', onRequest)
  page.on('response', onResponse)
  page.on('requestfinished', onFinished)
  page.on('requestfailed', onFailed)
  return {
    rows,
    elapsed,
    stop() {
      page.off('request', onRequest)
      page.off('response', onResponse)
      page.off('requestfinished', onFinished)
      page.off('requestfailed', onFailed)
    },
  }
}

const requiredReads = {
  '/jobs': ['/data/jobs', '/api/task_index', '/api/list_quote_requests', '/data/activity'],
  '/job/84': ['/data/jobs/84', '/api/get_task'],
  '/agent/2036': ['/data/agents/2036', '/data/backing/'],
  '/services': ['/data/directory'],
}

/** Readiness requires successful route reads, a heading, no placeholders and 500 ms of read quiet. */
export async function readiness(page, tracker, route, timeoutMs) {
  let readyMs = null
  let state = null
  while (tracker.elapsed() < timeoutMs) {
    state = await page.evaluate(pageState)
    const reads = [...tracker.rows.values()]
    const complete = reads.length > 0 && reads.every((r) => r.doneMs !== undefined && !r.failed && r.status < 400)
    const required = (requiredReads[route] ?? []).every((path) =>
      reads.some((r) => r.path.startsWith(path) && r.status === 200 && r.doneMs !== undefined),
    )
    const quiet = tracker.elapsed() - Math.max(0, ...reads.map((r) => r.doneMs ?? tracker.elapsed())) >= 500
    if (complete && required && quiet && state.headings.length > 0 && state.skeletons === 0 && !state.errorState) {
      readyMs ??= tracker.elapsed()
      if (tracker.elapsed() >= 5000) break
    } else {
      readyMs = null
    }
    await page.waitForTimeout(100)
  }
  return { readyMs, timedOut: readyMs === null, ...state }
}
