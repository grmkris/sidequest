import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  NO_PREVIEW,
  type PreviewCache,
  type PreviewDeps,
  handedIn,
  parseHead,
  parseManifest,
  previewRoute,
  previewTarget,
  publicUrl,
  readPreview,
} from '../src/deliverable-preview.ts'
import { submittedDeliverable } from '../src/registry.ts'
import { activityFixture } from './activity-fixture.ts'

const HASH = `0x${'ab'.repeat(32)}`
const SITE = 'https://sq-site.example.workers.dev/'

describe('previewTarget', () => {
  it('takes a task id and a 32-byte hash, lower-casing the hash', () => {
    expect(previewTarget(`/data/deliverables/task-1/${HASH.toUpperCase().replace('0X', '0x')}/preview`)).toEqual({
      taskId: 'task-1',
      hash: HASH,
    })
  })

  it('refuses any other shape', () => {
    for (const path of [
      '/data/deliverables/x/preview',
      `/data/deliverables/task-1/${HASH}`,
      `/data/deliverables/../${HASH}/preview`,
      `/data/deliverables/task-1/0x1234/preview`,
      `/data/deliverables/task-1/${HASH}/preview/extra`,
    ])
      expect(previewTarget(path), path).toBeNull()
  })
})

describe('parseManifest', () => {
  it('reads the crew convention, resolving the poster and media against the site', () => {
    const manifest = JSON.stringify({
      type: 'video',
      title: '45-second explainer',
      summary: 'A person hands a task to their agent.',
      media: 'video.mp4',
      poster: '/preview.webp',
    })
    expect(parseManifest(manifest, `${SITE}deliverable.json`)).toEqual({
      source: 'manifest',
      type: 'video',
      title: '45-second explainer',
      summary: 'A person hands a task to their agent.',
      poster: `${SITE}preview.webp`,
      media: `${SITE}video.mp4`,
    })
  })

  it('drops non-https, private and script URLs, unknown types and control characters; caps text', () => {
    const manifest = JSON.stringify({
      type: 'hologram',
      title: `Line\u0007one\n\ttwo ${'x'.repeat(300)}`,
      poster: 'javascript:alert(1)',
      media: 'http://sq-site.example.workers.dev/a.mp4',
      summary: 'ok',
    })
    const p = parseManifest(manifest, SITE)
    expect(p?.type).toBeNull()
    expect(p?.poster).toBeNull()
    expect(p?.media).toBeNull()
    expect(p?.title?.startsWith('Line one two x')).toBe(true)
    expect(p?.title).toHaveLength(140)
    expect(p?.title?.endsWith('…')).toBe(true)
    expect(publicUrl('https://10.0.0.1/x.png', SITE)).toBeNull()
    expect(publicUrl('https://nas.local/x.png', SITE)).toBeNull()
  })

  it('is null for what is not a manifest', () => {
    expect(parseManifest('<!doctype html><html>', SITE)).toBeNull()
    expect(parseManifest('[1, 2]', SITE)).toBeNull()
    expect(parseManifest('{"hello": "world"}', SITE)).toBeNull()
  })
})

describe('parseHead', () => {
  it('reads og tags in any attribute order and quoting, decoding entities and resolving relative images', () => {
    const html = `<html><head>
      <title>Fallback title</title>
      <meta content='Ember &amp; Oak' property="og:title">
      <meta name=description content="Roasts &#38; hours">
      <meta property="og:image" content="/og.png">
    </head><body><meta property="og:image" content="https://late.example/no.png"></body></html>`
    expect(parseHead(html, SITE)).toEqual({
      source: 'page',
      type: null,
      title: 'Ember & Oak',
      summary: 'Roasts & hours',
      poster: `${SITE}og.png`,
      media: null,
    })
  })

  it('falls back to <title> and twitter:image, and says nothing for a bare page', () => {
    const html =
      '<head><title>Memo &#x2014; agents</title><meta name="twitter:image" content="https://cdn.example/t.png"></head>'
    expect(parseHead(html, SITE)).toMatchObject({ title: 'Memo — agents', poster: 'https://cdn.example/t.png' })
    expect(parseHead('<head></head><body>hi</body>', SITE)).toEqual(NO_PREVIEW)
  })
})

describe('handedIn', () => {
  const result = {
    deliverables: [
      {
        deliverable_hash: HASH,
        descriptor: { kind: 'url', url: SITE },
        check: { ok: true, detail: 'HTTP 200', checkedAt: 5 },
      },
      { deliverable_hash: `0x${'cd'.repeat(32)}`, descriptor: { kind: 'bogus' } },
    ],
  }

  it('finds the deliverable with that hash and its check', () => {
    expect(handedIn(result, HASH)).toEqual({
      descriptor: { kind: 'url', url: SITE },
      check: { ok: true, detail: 'HTTP 200', checkedAt: 5 },
    })
  })

  it('is null for a hash the task never recorded, or an unreadable descriptor', () => {
    expect(handedIn(result, `0x${'ef'.repeat(32)}`)).toBeNull()
    expect(handedIn(result, `0x${'cd'.repeat(32)}`)).toBeNull()
    expect(handedIn(null, HASH)).toBeNull()
  })
})

/** A fetch double answering from a table of responses; anything else is a 404. */
function routes(table: Record<string, Response>) {
  const seen: string[] = []
  // SAFETY: the double takes the only argument shapes these tests pass (a URL string, URL or Request) and returns a Response.
  const fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString()
    seen.push(url)
    return table[url]?.clone() ?? new Response('nope', { status: 404 })
  }) as typeof globalThis.fetch
  return { fetch, seen }
}

const hop = (n: number) => `https://hop${n}.example/`
const unbuilt = async (): Promise<boolean> => {
  throw new Error('D1_ERROR: no such table: jobs')
}

const manifestBody = JSON.stringify({ type: 'site', title: 'Ember & Oak', poster: 'preview.webp' })
const html = (head: string) =>
  new Response(`<html><head>${head}</head></html>`, { headers: { 'content-type': 'text/html' } })

describe('readPreview', () => {
  it('prefers the manifest, then the page head', async () => {
    const withManifest = routes({ [`${SITE}deliverable.json`]: new Response(manifestBody) })
    expect(await readPreview(SITE, { fetch: withManifest.fetch, selfHosts: [] })).toMatchObject({
      source: 'manifest',
      poster: `${SITE}preview.webp`,
    })
    const pageOnly = routes({ [SITE]: html('<meta property="og:image" content="https://cdn.example/a.png">') })
    expect(await readPreview(SITE, { fetch: pageOnly.fetch, selfHosts: [] })).toMatchObject({
      source: 'page',
      poster: 'https://cdn.example/a.png',
    })
  })

  it('ignores an oversized manifest and reads the page instead', async () => {
    const big = routes({
      [`${SITE}deliverable.json`]: new Response('x', { headers: { 'content-length': String(65 * 1024) } }),
      [SITE]: html('<title>Page</title>'),
    })
    expect(await readPreview(SITE, { fetch: big.fetch, selfHosts: [] })).toMatchObject({
      source: 'page',
      title: 'Page',
    })
  })

  it('follows redirects only to public https hosts, and never to its own hosts', async () => {
    const toPrivate = routes({
      [`${SITE}deliverable.json`]: new Response(null, {
        status: 302,
        headers: { location: 'https://10.0.0.5/m.json' },
      }),
      [SITE]: new Response(null, { status: 301, headers: { location: 'https://dev.sidequest.exchange/' } }),
    })
    expect(await readPreview(SITE, { fetch: toPrivate.fetch, selfHosts: ['dev.sidequest.exchange'] })).toEqual(
      NO_PREVIEW,
    )
    expect(toPrivate.seen).toEqual([`${SITE}deliverable.json`, SITE])
  })

  it('gives up after three redirects', async () => {
    const loop = routes(
      Object.fromEntries(
        [0, 1, 2, 3, 4].map((n) => [hop(n), new Response(null, { status: 302, headers: { location: hop(n + 1) } })]),
      ),
    )
    expect(await readPreview(hop(0), { fetch: loop.fetch, selfHosts: [] })).toEqual(NO_PREVIEW)
    expect(loop.seen).toEqual([`${hop(0)}deliverable.json`, hop(0), hop(1), hop(2), hop(3)])
  })
})

/** An in-memory stand-in for the edge cache. */
function memoryCache(): PreviewCache & { keys: () => string[]; stored: (key: string) => Response | undefined } {
  const store = new Map<string, Response>()
  return {
    match: async (key) => store.get(key)?.clone(),
    put: async (key, response) => {
      store.set(key, response.clone())
    },
    keys: () => [...store.keys()],
    stored: (key) => store.get(key),
  }
}

function deps(overrides: Partial<PreviewDeps> = {}): PreviewDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    submitted: async () => {
      calls.push('submitted')
      return true
    },
    task: async () => {
      calls.push('task')
      return {
        ok: true,
        result: { deliverables: [{ deliverable_hash: HASH, descriptor: { kind: 'url', url: SITE } }] },
      }
    },
    fetch: routes({ [`${SITE}deliverable.json`]: new Response(manifestBody) }).fetch,
    selfHosts: [],
    cache: memoryCache(),
    ...overrides,
  }
}

const CORS = { 'access-control-allow-origin': 'https://dev.sidequest.exchange' }
const request = {
  taskId: 'task-1',
  hash: HASH,
  key: 'https://api.test/data/deliverables/task-1/x/preview?v=1',
  cors: CORS,
}

async function answer(d: PreviewDeps) {
  const res = HttpServerResponse.toWeb(await previewRoute(request, d))
  // SAFETY: previewRoute always answers a JSON object body.
  return { res, body: (await res.json()) as Record<string, unknown> }
}

describe('previewRoute', () => {
  it('answers the deliverable and its preview, cached an hour without the CORS header', async () => {
    const cache = memoryCache()
    const { res, body } = await answer(deps({ cache }))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(res.headers.get('access-control-allow-origin')).toBe(CORS['access-control-allow-origin'])
    expect(res.headers.get('x-sidequest-preview')).toBe('miss')
    expect(body).toMatchObject({
      ok: true,
      deliverable: { descriptor: { kind: 'url', url: SITE }, check: null },
      preview: { source: 'manifest', type: 'site', title: 'Ember & Oak' },
    })
    expect(cache.stored(request.key)?.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('serves a cached answer without touching the chain, the board or the site', async () => {
    const cache = memoryCache()
    await answer(deps({ cache }))
    const second = deps({ cache })
    const { res, body } = await answer(second)
    expect(res.headers.get('x-sidequest-preview')).toBe('hit')
    expect(res.headers.get('access-control-allow-origin')).toBe(CORS['access-control-allow-origin'])
    expect(body).toMatchObject({ ok: true, preview: { source: 'manifest' } })
    expect(second.calls).toEqual([])
  })

  it("keeps the route's own lifetime on a hit, whatever the edge rewrote the stored copy's cache-control to", async () => {
    const cache = memoryCache()
    await answer(deps({ cache }))
    // Cloudflare rewrites a stored copy's cache-control to the zone's browser TTL.
    cache.stored(request.key)?.headers.set('cache-control', 'public, max-age=14400')
    const { res } = await answer(deps({ cache }))
    expect(res.headers.get('x-sidequest-preview')).toBe('hit')
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600')
    // A copy stored before the route kept its lifetime gets the short one.
    cache.stored(request.key)?.headers.delete('x-sidequest-max-age')
    const legacy = await answer(deps({ cache }))
    expect(legacy.res.headers.get('cache-control')).toBe('public, max-age=30')
  })

  it('is not found for a hash the chain never recorded, without asking the board', async () => {
    const d = deps({ submitted: async () => false })
    const { res, body } = await answer(d)
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('public, max-age=30')
    expect(body).toMatchObject({ ok: false, code: 'not-found' })
    expect(d.calls).toEqual([])
  })

  it('is not found when the task does not hold that deliverable', async () => {
    const { res } = await answer(deps({ task: async () => ({ ok: true, result: { deliverables: [] } }) }))
    expect(res.status).toBe(404)
  })

  it('does not cache an unavailable board', async () => {
    const cache = memoryCache()
    const { res } = await answer(deps({ cache, task: async () => ({ ok: false, code: 'unavailable' }) }))
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(cache.keys()).toEqual([])
  })

  it('is unavailable, and not cached, while the index is not built', async () => {
    const cache = memoryCache()
    const { res, body } = await answer(deps({ cache, submitted: unbuilt }))
    expect(res.status).toBe(503)
    expect(body).toMatchObject({ ok: false, code: 'unavailable' })
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(cache.keys()).toEqual([])
  })

  it('reads nothing remote for a non-site deliverable', async () => {
    const site = routes({})
    const git = { kind: 'git', url: 'https://github.com/o/r', ref: 'main', sha: 'a'.repeat(40) }
    const { body, res } = await answer(
      deps({
        fetch: site.fetch,
        task: async () => ({ ok: true, result: { deliverables: [{ deliverable_hash: HASH, descriptor: git }] } }),
      }),
    )
    expect(body).toMatchObject({ ok: true, deliverable: { descriptor: git }, preview: NO_PREVIEW })
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(site.seen).toEqual([])
  })

  it('caches a site that says nothing, or fails, for five minutes', async () => {
    // SAFETY: a fetch that always rejects, as a network failure does.
    const throwing = (async () => {
      throw new TypeError('network down')
    }) as typeof globalThis.fetch
    const { res, body } = await answer(deps({ fetch: throwing }))
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ preview: NO_PREVIEW })
    expect(res.headers.get('cache-control')).toBe('public, max-age=300')
  })
})

describe('submittedDeliverable against the production fold', () => {
  let fixture: Awaited<ReturnType<typeof activityFixture>>
  beforeAll(async () => {
    fixture = await activityFixture()
    const submitted = (jobId: string, block: number) =>
      fixture.event(jobId, 'JobSubmitted', block, 0, { deliverable: HASH, provider: fixture.deployment.admin })
    await fixture.addJob([fixture.published('1', 10), submitted('1', 11)], 'public')
    await fixture.addJob([fixture.published('2', 20)], 'public')
  })
  afterAll(() => fixture.db.close())

  it("is true only for the board's task whose job recorded that hash", async () => {
    const ask = (boardId: string, taskId: string, hash = HASH) =>
      submittedDeliverable(fixture.sql, fixture.deployment, { boardId, taskId, hash })
    expect(await ask('public', 'task-1')).toBe(true)
    expect(await ask('public', 'task-1', HASH.toUpperCase().replace('0X', '0x'))).toBe(true)
    expect(await ask('my-team', 'task-1')).toBe(false)
    expect(await ask('public', 'task-2')).toBe(false)
    expect(await ask('public', 'task-1', `0x${'cd'.repeat(32)}`)).toBe(false)
  })
})

const live = process.env.SIDEQUEST_LIVE_PREVIEW === '1'

describe.skipIf(!live)('readPreview against the live crew deliveries', () => {
  const real = { fetch: globalThis.fetch.bind(globalThis), selfHosts: [] }

  it('reads a video delivery from its deliverable.json', async () => {
    const site = 'https://sq-explainer-sidequest.kristjan-grm11775.workers.dev/'
    expect(await readPreview(site, real)).toMatchObject({
      source: 'manifest',
      type: 'video',
      poster: `${site}preview.webp`,
      media: `${site}video.mp4`,
    })
  })

  it('reads a site delivery from its deliverable.json', async () => {
    expect(await readPreview('https://sq-ember-oak.kristjan-grm11775.workers.dev/', real)).toMatchObject({
      source: 'manifest',
      type: 'site',
    })
  })
})
