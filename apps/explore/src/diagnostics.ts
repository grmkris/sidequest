/** Opt-in, tab-local timing only. No transport, response bodies, query arguments or raw URLs are recorded. */
import type { QueryClient } from '@tanstack/react-query'

const FAMILIES = [
  'boards',
  'directory-first',
  'chain-jobs',
  'task_index',
  'get_task',
  'job',
  'data-agents',
  'data-agent',
  'data-profiles',
  'data-services',
  'data-directory',
  'directory-agent',
  'directory-listing',
  'delivery-preview',
  'activity-feed',
  'managed-agents',
  'managed-agent-status',
  'managed-approvals',
  'agent-connections',
  'proposal',
  'oauth-request',
  'list_quote_requests',
  'list_quotes',
  'my-events',
  'backing',
  'indexed-backing',
  'delegations',
  'agent-backing',
  'commons',
  'readContract',
  'readContracts',
  'balance',
  'market-price',
  'market-quote',
  'data-stats',
  'bond-policy',
  'bond-funding',
  'bond-horizon',
]

/** The allowed values are labels, never user-controlled path segments. */
function routeFamily(pathname: string): string {
  const path = pathname.replace(/^\/b\/[^/]+/, '')
  if (path === '' || path === '/') return 'home'
  const first = path.split('/')[1] ?? ''
  return [
    'jobs',
    'job',
    'services',
    'agent',
    'agents',
    'wallet',
    'request',
    'boards',
    'commons',
    'account',
    'connect',
    'welcome',
    'admin',
    'sponsorship',
    'embed',
  ].includes(first)
    ? first
    : 'other'
}

function resourceFamily(raw: string, origin: string, rpcOrigins: readonly string[]): string {
  try {
    const url = new URL(raw, origin)
    if (rpcOrigins.includes(url.origin)) return 'rpc'
    if (url.origin !== origin) return 'external'
    const path = url.pathname.replace(/^\/b\/[^/]+/, '')
    if (path.startsWith('/data/')) {
      const entity = path.split('/')[2] ?? ''
      return [
        'boards',
        'stats',
        'jobs',
        'agents',
        'profiles',
        'services',
        'directory',
        'activity',
        'backing',
        'delegations',
        'deliverables',
      ].includes(entity)
        ? `data/${entity}`
        : 'data/other'
    }
    if (path.startsWith('/api/')) return 'api'
    if (path === '/mcp') return 'mcp'
    if (path.startsWith('/assets/')) return 'asset'
    return 'same-origin/other'
  } catch {
    return 'other'
  }
}

interface Timing {
  kind: 'query' | 'resource'
  family: string
  route: string
  startMs: number
  durationMs: number
  outcome?: 'success' | 'error' | 'cancelled'
  apiMs?: number
}

type ResourceTiming = Pick<PerformanceResourceTiming, 'name' | 'startTime' | 'duration' | 'serverTiming'>
const ms = (value: number) => Math.round(Math.max(0, Number.isFinite(value) ? value : 0) * 10) / 10

export function createDiagnostics(
  client: QueryClient,
  options: {
    origin: string
    rpcOrigins: readonly string[]
    pathname: () => string
    now?: () => number
  },
) {
  const now = options.now ?? (() => performance.now())
  const entries: Timing[] = []
  let active = true
  let dropped = 0
  const record = (entry: Timing) => {
    if (!active) return
    if (entries.length === 200) {
      entries.shift()
      dropped++
    }
    entries.push(entry)
  }
  // The query object is a weak identity; its key/hash and data never enter an exported record.
  const pending = new WeakMap<object, { startMs: number; route: string }>()
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated') return
    const query = event.query
    if (event.action.type === 'fetch') {
      pending.set(query, { startMs: now(), route: routeFamily(options.pathname()) })
    } else if (query.state.fetchStatus === 'idle') {
      const started = pending.get(query)
      if (started === undefined) return
      pending.delete(query)
      const family = query.queryKey[0]
      record({
        kind: 'query',
        family: FAMILIES.find((allowed) => allowed === family) ?? 'other',
        route: started.route,
        startMs: ms(started.startMs),
        durationMs: ms(now() - started.startMs),
        outcome: event.action.type === 'success' ? 'success' : query.state.status === 'error' ? 'error' : 'cancelled',
      })
    }
  })
  return {
    resource(entry: ResourceTiming) {
      const api = entry.serverTiming?.find((timing) => timing.name === 'api')
      record({
        kind: 'resource',
        family: resourceFamily(entry.name, options.origin, options.rpcOrigins),
        // Resource timing arrives after completion; route is the page at observation time.
        route: routeFamily(options.pathname()),
        startMs: ms(entry.startTime),
        durationMs: ms(entry.duration),
        ...(api === undefined ? {} : { apiMs: ms(api.duration) }),
      })
    },
    snapshot: () => ({ active, dropped, entries: entries.map((entry) => ({ ...entry })) }),
    clear() {
      entries.length = 0
      dropped = 0
    },
    stop() {
      active = false
      unsubscribe()
    },
  }
}

export function installDiagnostics(client: QueryClient, rpcUrls: readonly string[]) {
  const diagnostics = createDiagnostics(client, {
    origin: location.origin,
    rpcOrigins: rpcUrls.map((url) => new URL(url).origin),
    pathname: () => location.pathname,
  })
  let observer: PerformanceObserver | undefined
  if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('resource')) {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry instanceof PerformanceResourceTiming) diagnostics.resource(entry)
      }
    })
    observer.observe({ type: 'resource', buffered: true })
  }
  const api = {
    snapshot: diagnostics.snapshot,
    clear: () => diagnostics.clear(),
    stop() {
      observer?.disconnect()
      diagnostics.stop()
      try {
        sessionStorage.removeItem('sidequest:diagnostics')
      } catch {
        /* Tab storage can be disabled. */
      }
    },
  }
  Object.assign(window, { sidequestDiagnostics: api })
}
