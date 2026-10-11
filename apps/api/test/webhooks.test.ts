import { DatabaseSync } from 'node:sqlite'
import { timingSafeEqual } from 'node:crypto'
import { type AsyncSql, fromNodeSqlite, stmt } from '@sidequest/indexer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertPublicCallback,
  deliverWebhooks,
  migrateWebhooks,
  subscribeWebhook,
  terminateGrantSubscriptions,
  terminateSubscriptions,
  unsubscribeWebhook,
  type WebhookFetch,
} from '../src/webhooks.ts'
import { FEED_RETENTION_SECONDS, pruneFeed, writeFeed } from '../src/feed.ts'

const principal = '0x1111111111111111111111111111111111111111',
  stranger = '0x2222222222222222222222222222222222222222'
const now = 2_000_000,
  network = 'monad-testnet'
const secret = `whsec_${btoa('x'.repeat(32))}`,
  callback = 'https://events.example/callback'
const params = (extra: Record<string, unknown> = {}) => ({
  name: 'sidequest.inbox',
  arguments: {},
  delivery: { mode: 'webhook', url: callback, secret },
  cursor: 'v1:0',
  ...extra,
})
const databases: DatabaseSync[] = []
function database() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  return fromNodeSqlite(db)
}
interface Delivery {
  headers: Headers
  body: Uint8Array
  envelope: Record<string, unknown>
  init: RequestInit
}
function fake(
  answer: (delivery: Delivery) => Response | Promise<Response> = () => new Response(null, { status: 204 }),
  dns: { a?: string[]; aaaa?: string[] } = {},
) {
  const deliveries: Delivery[] = []
  const transport: WebhookFetch = async (input, init) => {
    if (String(input).startsWith('https://cloudflare-dns.com/dns-query?')) {
      expect(new Headers(init?.headers).get('accept')).toBe('application/dns-json')
      expect(init?.redirect).toBe('manual')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      const type = new URL(String(input)).searchParams.get('type')
      return Response.json({
        Status: 0,
        Answer: (type === 'A' ? (dns.a ?? ['203.0.113.10']) : (dns.aaaa ?? [])).map((data) => ({
          type: type === 'A' ? 1 : 28,
          data,
        })),
      })
    }
    const body = new Uint8Array(init!.body as Uint8Array)
    const delivery = {
      body,
      headers: new Headers(init?.headers),
      envelope: JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>,
      init: init!,
    }
    deliveries.push(delivery)
    if (delivery.envelope.type === 'verification') return Response.json({ challenge: delivery.envelope.challenge })
    return answer(delivery)
  }
  return { transport, deliveries }
}
async function seed(sql: AsyncSql, count = 3, address = principal, created = now) {
  await writeFeed(
    sql,
    network,
    Array.from({ length: count }, (_, i) => ({
      id: `${address}:${i}`,
      address,
      kind: 'job.submitted',
      taskId: 't1',
      summary: 'Job submitted',
      occurredAt: created,
    })),
    created,
  )
}
async function subscription(sql: AsyncSql, transport: WebhookFetch, extra: Record<string, unknown> = {}) {
  return subscribeWebhook(sql, network, principal, params(extra), now, transport)
}
interface Row {
  id: string
  cursor_seq: number
  status: string
  failures: number
  refresh_before: number
  next_attempt_at: number
  last_error: string | null
  updated_at: number
  secret: string
}
async function row(sql: AsyncSql, id: unknown): Promise<Row> {
  return (await sql.all<Row>('SELECT * FROM event_subscriptions WHERE id = ?', id as string))[0]!
}

// Purrable webhook.ts oracle: same raw-secret decoding, byte concatenation, signature selection and timestamp window.
async function verifyWebhook(sharedSecret: string, headers: Headers, body: Uint8Array, at: number): Promise<void> {
  if (body.byteLength > 262_144) throw new Error('event body too large')
  const timestamp = headers.get('webhook-timestamp')!
  if (!Number.isSafeInteger(Number(timestamp)) || Math.abs(at - Number(timestamp) * 1000) > 5 * 60 * 1000)
    throw new Error('event timestamp')
  if (!sharedSecret.startsWith('whsec_')) throw new Error('event secret prefix')
  const bytes = Uint8Array.from(atob(sharedSecret.slice(6)), (c) => c.codePointAt(0) ?? 0)
  if (bytes.byteLength < 24 || bytes.byteLength > 64) throw new Error('event secret encoding')
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const expected = `v1,${btoa(String.fromCodePoint(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array([...new TextEncoder().encode(`${headers.get('webhook-id')}.${timestamp}.`), ...body])))))}`
  const signatures = headers
    .get('webhook-signature')!
    .split(' ')
    .map((part) => part.split(',', 2))
    .filter(([version, value]) => version === 'v1' && value !== undefined)
  if (
    !signatures.some(([, value]) => {
      const candidate = new TextEncoder().encode(`v1,${value}`),
        target = new TextEncoder().encode(expected)
      return candidate.length === target.length && timingSafeEqual(candidate, target)
    })
  )
    throw new Error('event signature')
}
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
})

describe('public callback validation', () => {
  it.each([
    'http://events.example/cb',
    'https://events.example:444/cb',
    'https://user:pass@events.example/cb',
    'https://events.example/cb#fragment',
    'https://events.example/cb#',
    'https://localhost/cb',
    'https://a.local/cb',
    'https://a.internal/cb',
    'https://a.home.arpa/cb',
    'https://a.localhost/cb',
    'https://LOCALHOST./cb',
    'https://127.0.0.1/cb',
    'https://127.1/cb',
    'https://2130706433/cb',
    'https://10.1.2.3/cb',
    'https://172.31.1.1/cb',
    'https://192.168.0.1/cb',
    'https://169.254.169.254/cb',
    'https://100.64.0.1/cb',
    'https://100.127.255.255/cb',
    'https://0.0.0.0/cb',
    'https://224.0.0.1/cb',
    'https://[::1]/cb',
    'https://[::]/cb',
    'https://[fc00::1]/cb',
    'https://[fd01::1]/cb',
    'https://[fe80::1]/cb',
    'https://[ff02::1]/cb',
    'https://[::ffff:127.0.0.1]/cb',
    'https://[::ffff:192.168.1.1]/cb',
    'https://[::ffff:100.64.0.1]/cb',
    'not a URL',
  ])('refuses SSRF target %s', async (url) => {
    const f = fake()
    await expect(assertPublicCallback(url, f.transport)).rejects.toMatchObject({ code: -32602 })
    expect(f.deliveries).toHaveLength(0)
  })
  it.each([
    { a: ['127.0.0.1'] },
    { a: ['203.0.113.10', '10.0.0.1'] },
    { aaaa: ['fd00::1'] },
    { aaaa: ['::ffff:100.64.0.1'] },
  ])('refuses private DoH answers %j', async (dns) => {
    await expect(assertPublicCallback(callback, fake(undefined, dns).transport)).rejects.toMatchObject({ code: -32602 })
  })
  it('allows public IPv4, IPv6 and default or explicit 443', async () => {
    const transport = fake(undefined, { aaaa: ['2606:4700:4700::1111'] }).transport
    for (const url of [
      callback,
      'https://events.example:443/cb',
      'https://8.8.8.8/cb',
      'https://[2606:4700:4700::1111]/cb',
    ])
      expect((await assertPublicCallback(url, transport)).protocol).toBe('https:')
  })
  it('fails closed on DNS errors, redirects and empty answers', async () => {
    for (const transport of [
      async () => new Response(null, { status: 302 }),
      async () => Response.json({ Status: 3 }),
      fake(undefined, { a: [], aaaa: [] }).transport,
    ])
      await expect(assertPublicCallback(callback, transport)).rejects.toMatchObject({ code: -32602 })
  })
})

describe('verification and subscription leases', () => {
  it('refuses to subscribe a revoked principal before any network call (VV2-030)', async () => {
    const sql = database()
    await seed(sql)
    await terminateSubscriptions(sql, principal, now)
    const f = fake()
    await expect(subscription(sql, f.transport)).rejects.toMatchObject({ code: -32003 })
    expect(f.deliveries).toHaveLength(0)
  })

  it('a subscribe in flight when access stops does not land after the termination (VV2-030)', async () => {
    const sql = database()
    await seed(sql)
    const existing = await subscription(sql, fake().transport, { arguments: { kinds: ['job.submitted'] } })
    let raced = false
    const f = fake()
    const racing: WebhookFetch = async (input, init) => {
      if (!raced && !String(input).startsWith('https://cloudflare-dns.com/')) {
        raced = true
        await terminateSubscriptions(sql, principal, now)
      }
      return f.transport(input, init)
    }
    await expect(subscription(sql, racing)).rejects.toMatchObject({ code: -32003 })
    expect(await sql.all("SELECT id FROM event_subscriptions WHERE status <> 'terminated'")).toEqual([])
    expect((await row(sql, existing.id)).status).toBe('terminated')
  })

  it('shortens a lease longer than six hours instead of refusing it', async () => {
    const sql = database()
    await seed(sql)
    const sub = await subscription(sql, fake().transport, { ttlMs: 86_400_000 })
    expect(Date.parse(sub.refreshBefore as string)).toBe((now + 21_600) * 1000)
    expect((await row(sql, sub.id)).refresh_before).toBe(now + 21_600)
    await expect(subscription(sql, fake().transport, { ttlMs: 0 })).rejects.toMatchObject({ code: -32602 })
  })

  it('verifies with the final id before persisting, then refreshes the same canonical selector and rotates secrets', async () => {
    const sql = database()
    await seed(sql)
    const f = fake()
    const first = await subscription(sql, f.transport, { arguments: { kinds: ['job.submitted', 'job.published'] } })
    const verification = f.deliveries[0]!
    expect(verification.headers.get('x-mcp-subscription-id')).toBe(first.id)
    expect(verification.headers.get('webhook-id')).toMatch(/^msg_verification_/)
    expect(verification.init.redirect).toBe('manual')
    await verifyWebhook(secret, verification.headers, verification.body, now * 1000)
    expect(first).toMatchObject({ cursor: 'v1:0', truncated: false, deliveryStatus: { active: true } })
    expect(Date.parse(first.refreshBefore as string)).toBe((now + 21_600) * 1000)
    const rotated = `whsec_${btoa('y'.repeat(32))}`
    const second = await subscribeWebhook(
      sql,
      network,
      principal.toUpperCase(),
      params({
        arguments: { kinds: ['job.published', 'job.submitted', 'job.submitted'] },
        delivery: { mode: 'webhook', url: callback, secret: rotated },
      }),
      now + 10,
      f.transport,
    )
    expect(second.id).toBe(first.id)
    expect(Date.parse(second.refreshBefore as string)).toBe((now + 10 + 21_600) * 1000)
    expect((await row(sql, first.id)).secret).toBe(rotated)
    await verifyWebhook(rotated, f.deliveries[1]!.headers, f.deliveries[1]!.body, (now + 10) * 1000)
    expect(await sql.all('SELECT id FROM event_subscriptions')).toHaveLength(1)
  })
  it.each(['wrong challenge', 'extra field', '204', '503', 'redirect', 'invalid JSON'])(
    'fails verification with -32015 for %s and saves no subscription',
    async (mode) => {
      const sql = database()
      await seed(sql)
      const dns = fake()
      const transport: WebhookFetch = async (input, init) => {
        if (String(input).includes('dns-query')) return dns.transport(input, init)
        const challenge = (JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as { challenge: string })
          .challenge
        return mode === 'wrong challenge'
          ? Response.json({ challenge: 'wrong' })
          : mode === 'extra field'
            ? Response.json({ challenge, extra: true })
            : mode === 'invalid JSON'
              ? new Response('not JSON')
              : new Response(null, {
                  status: mode === 'redirect' ? 302 : Number(mode),
                  headers: mode === 'redirect' ? { location: 'https://127.0.0.1/' } : {},
                })
      }
      await expect(subscription(sql, transport)).rejects.toMatchObject({
        code: -32015,
        message: 'Webhook verification failed',
      })
      expect(await sql.all('SELECT id FROM event_subscriptions')).toHaveLength(0)
    },
  )
  it('limits verification to 5 seconds and aborts even an uncooperative fetch', async () => {
    vi.useFakeTimers()
    const sql = database()
    await seed(sql)
    let entered!: () => void, signal: AbortSignal | null | undefined
    const callbackEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const dns = fake()
    const transport: WebhookFetch = async (input, init) => {
      if (String(input).includes('dns-query')) return dns.transport(input, init)
      signal = init?.signal
      entered()
      return new Promise<Response>(() => {})
    }
    const rejected = expect(subscription(sql, transport)).rejects.toMatchObject({ code: -32015 })
    await callbackEntered
    await vi.advanceTimersByTimeAsync(5001)
    await rejected
    expect(signal?.aborted).toBe(true)
  })
  it.each(['bad', 'whsec_!!!', `whsec_${btoa('x'.repeat(23))}`, `whsec_${btoa('x'.repeat(65))}`])(
    'rejects invalid secret %s before any POST',
    async (bad) => {
      const f = fake()
      await expect(
        subscription(database(), f.transport, { delivery: { mode: 'webhook', url: callback, secret: bad } }),
      ).rejects.toMatchObject({ code: -32602 })
      expect(f.deliveries).toHaveLength(0)
    },
  )
  it('retains the no-cursor backlog within maxAgeMs instead of consuming it on subscribe', async () => {
    const sql = database()
    await seed(sql, 2)
    const f = fake()
    const sub = await subscription(sql, f.transport, { cursor: undefined, maxAgeMs: 1000 })
    expect(sub.cursor).toBe('v1:0')
    await deliverWebhooks(sql, network, now, { fetch: f.transport })
    expect(f.deliveries.filter((d) => d.envelope.eventId)).toHaveLength(2)
  })
  // goblin S1: an explicit null cursor (SEP-3415) starts from now, so a new routine never fires on yesterday's news.
  it('starts an explicit null cursor at the head, delivers only newer rows and never rewinds on renewal', async () => {
    const sql = database()
    await seed(sql, 2)
    const f = fake()
    const sub = await subscription(sql, f.transport, { cursor: null })
    expect(sub.cursor).toBe('v1:2')
    await deliverWebhooks(sql, network, now, { fetch: f.transport })
    expect(f.deliveries.filter((d) => d.envelope.eventId)).toHaveLength(0)
    await writeFeed(
      sql,
      network,
      [
        {
          id: 'later',
          address: principal,
          kind: 'job.submitted',
          taskId: 't1',
          summary: 'Later',
          occurredAt: now + 61,
        },
      ],
      now + 61,
    )
    // An empty round schedules the next one a minute later.
    await deliverWebhooks(sql, network, now + 61, { fetch: f.transport })
    expect(f.deliveries.filter((d) => d.envelope.eventId).map((d) => d.envelope.data)).toMatchObject([{ id: 'later' }])
    expect((await subscription(sql, f.transport, { cursor: null })).cursor).toBe('v1:3')
  })
  it('scopes ids and unsubscription to the principal and chain, and accepts Purrable selectors', async () => {
    const sql = database()
    await seed(sql)
    const f = fake()
    const sub = await subscription(sql, f.transport)
    await unsubscribeWebhook(sql, network, stranger, { id: sub.id }, now)
    await unsubscribeWebhook(sql, 'monad-mainnet', principal, { id: sub.id }, now)
    expect((await row(sql, sub.id)).status).toBe('active')
    await unsubscribeWebhook(
      sql,
      network,
      principal,
      { name: 'sidequest.inbox', arguments: {}, delivery: { mode: 'webhook', url: callback } },
      now,
    )
    expect((await row(sql, sub.id)).status).toBe('terminated')
    const other = await subscribeWebhook(sql, network, stranger, params(), now, f.transport)
    expect(other.id).not.toBe(sub.id)
  })

  // goblin S11 and S6: two connections of one account subscribe to the same event with their own URLs and secrets.
  it('keeps one subscription per connection and callback URL; neither replaces nor removes the other', async () => {
    const sql = database()
    await seed(sql)
    const f = fake()
    const hirerUrl = 'https://events.example/hirer'
    const workerUrl = 'https://events.example/worker'
    const subscribe = (url: string, family: string) =>
      subscribeWebhook(
        sql,
        network,
        principal,
        params({ delivery: { mode: 'webhook', url, secret } }),
        now,
        f.transport,
        family,
      )
    const hirer = await subscribe(hirerUrl, 'family-hirer')
    const worker = await subscribe(workerUrl, 'family-worker')
    expect(worker.id).not.toBe(hirer.id)
    // A lease renewal on the same connection keeps its id, even after its OAuth refresh rotated the token.
    expect((await subscribe(hirerUrl, 'family-hirer')).id).toBe(hirer.id)
    await unsubscribeWebhook(
      sql,
      network,
      principal,
      { name: 'sidequest.inbox', arguments: {}, delivery: { mode: 'webhook', url: hirerUrl } },
      now,
      'family-hirer',
    )
    expect((await row(sql, String(hirer.id))).status).toBe('terminated')
    expect(await row(sql, String(worker.id))).toMatchObject({ status: 'active', url: workerUrl })
  })
})

describe('cron webhook delivery', () => {
  it('never posts for a revoked principal and terminates a row that slipped in (VV2-030)', async () => {
    const sql = database()
    await seed(sql)
    const f = fake()
    const sub = await subscription(sql, f.transport)
    await sql.batch([
      stmt('INSERT INTO event_revoked_principals (principal, revoked_at) VALUES (?, ?)', principal, now),
    ])
    const posts = f.deliveries.length
    expect(await deliverWebhooks(sql, network, now, { fetch: f.transport })).toEqual({ posts: 0, subscriptions: 0 })
    expect(f.deliveries).toHaveLength(posts)
    expect(await row(sql, sub.id)).toMatchObject({ status: 'terminated', last_error: 'Agent access stopped' })
  })

  it('delivers signed occurrences in order and advances only through acknowledged 2xx rows', async () => {
    const sql = database()
    await seed(sql)
    await seed(sql, 1, stranger)
    let received = 0
    const f = fake(() => new Response(null, { status: ++received === 2 ? 503 : 204 }))
    const sub = await subscription(sql, f.transport)
    expect(await deliverWebhooks(sql, network, now, { fetch: f.transport })).toEqual({ posts: 2, subscriptions: 1 })
    expect(await row(sql, sub.id)).toMatchObject({
      cursor_seq: 1,
      status: 'failing',
      failures: 1,
      next_attempt_at: now + 60,
      last_error: 'HTTP 503',
    })
    for (const d of f.deliveries) {
      expect(d.init.redirect).toBe('manual')
      expect(d.init.signal).toBeInstanceOf(AbortSignal)
      await verifyWebhook(secret, d.headers, d.body, now * 1000)
      if (d.envelope.eventId) expect(d.envelope.eventId).toBe(d.headers.get('webhook-id'))
    }
    await deliverWebhooks(sql, network, now + 60, { fetch: f.transport })
    const deliveries = f.deliveries.filter((d) => d.envelope.eventId)
    expect(deliveries.map((d) => d.envelope.cursor)).toEqual(['v1:1', 'v1:2', 'v1:2', 'v1:3'])
    expect(await row(sql, sub.id)).toMatchObject({ cursor_seq: 3, status: 'active', failures: 0, last_error: null })
    // The oracle also detects body tampering.
    await expect(
      verifyWebhook(secret, deliveries[0]!.headers, new TextEncoder().encode('{}'), now * 1000),
    ).rejects.toThrow('event signature')
  })
  it.each([200, 201, 204, 299])('advances on HTTP %s', async (status) => {
    const sql = database()
    await seed(sql, 1)
    const f = fake(() => new Response(status === 204 ? null : '{}', { status }))
    const sub = await subscription(sql, f.transport)
    await deliverWebhooks(sql, network, now, { fetch: f.transport })
    expect((await row(sql, sub.id)).cursor_seq).toBe(1)
  })
  it.each([302, 400, 500, 503])('keeps the cursor and never forwards the response body on HTTP %s', async (status) => {
    const sql = database()
    await seed(sql, 1)
    const f = fake(
      () => new Response('PRIVATE RESPONSE SECRET', { status, headers: { location: 'https://127.0.0.1/' } }),
    )
    const sub = await subscription(sql, f.transport)
    await deliverWebhooks(sql, network, now, { fetch: f.transport })
    expect(await row(sql, sub.id)).toMatchObject({
      cursor_seq: 0,
      status: 'failing',
      failures: 1,
      last_error: `HTTP ${status}`,
    })
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('PRIVATE RESPONSE SECRET')
  })
  it('backs off 1m, 2m, 5m, 15m, 1h, then hourly while retaining the failure start', async () => {
    const sql = database()
    await seed(sql, 1)
    const f = fake(() => new Response(null, { status: 503 }))
    const sub = await subscription(sql, f.transport)
    let at = now
    for (const [i, delay] of [60, 120, 300, 900, 3600, 3600].entries()) {
      await deliverWebhooks(sql, network, at, { fetch: f.transport })
      expect(await row(sql, sub.id)).toMatchObject({
        status: 'failing',
        failures: i + 1,
        next_attempt_at: at + delay,
        updated_at: now,
      })
      at += delay
    }
    expect((await row(sql, sub.id)).status).toBe('failing')
  })
  it('retains continuous failure across lease refresh, and terminates after 24 hours with a control id', async () => {
    const sql = database()
    await seed(sql, 1)
    const f = fake(() => new Response(null, { status: 503 }))
    const sub = await subscription(sql, f.transport)
    await deliverWebhooks(sql, network, now, { fetch: f.transport })
    await subscribeWebhook(sql, network, principal, params(), now + 86_390, f.transport)
    expect(await row(sql, sub.id)).toMatchObject({ status: 'failing', updated_at: now, failures: 1 })
    await deliverWebhooks(sql, network, now + 86_401, { fetch: f.transport })
    expect((await row(sql, sub.id)).status).toBe('terminated')
    const message = f.deliveries.find((d) => d.envelope.type === 'terminated')!
    expect(message.headers.get('webhook-id')).toMatch(/^msg_terminated_/)
    expect(message.envelope).toMatchObject({ type: 'terminated', error: { code: -32015 } })
    await verifyWebhook(secret, message.headers, message.body, (now + 86_401) * 1000)
    const length = f.deliveries.length
    await deliverWebhooks(sql, network, now + 86_501, { fetch: f.transport })
    expect(f.deliveries).toHaveLength(length)
  })
  it('terminates immediately on HTTP 410 without advancing or retrying', async () => {
    const sql = database()
    await seed(sql)
    const f = fake(() => new Response(null, { status: 410 }))
    const sub = await subscription(sql, f.transport)
    await deliverWebhooks(sql, network, now, { fetch: f.transport })
    expect(await row(sql, sub.id)).toMatchObject({ status: 'terminated', cursor_seq: 0 })
    await deliverWebhooks(sql, network, now + 60, { fetch: f.transport })
    expect(f.deliveries.filter((d) => d.envelope.eventId)).toHaveLength(1)
  })
  it('terminates immediately on HTTP 413 without retrying', async () => {
    const sql = database()
    await seed(sql)
    const f = fake(() => new Response(null, { status: 413 }))
    const sub = await subscription(sql, f.transport)
    await deliverWebhooks(sql, network, now, { fetch: f.transport })
    expect(await row(sql, sub.id)).toMatchObject({ status: 'terminated', cursor_seq: 0, last_error: 'HTTP 413' })
    await deliverWebhooks(sql, network, now + 60, { fetch: f.transport })
    expect(f.deliveries.filter((d) => d.envelope.type !== 'verification')).toHaveLength(1)
  })
  it('sends an acknowledged gap control before retained rows and does not repeat it', async () => {
    const sql = database()
    await seed(sql, 3, principal, now - FEED_RETENTION_SECONDS - 1)
    await writeFeed(
      sql,
      network,
      [{ id: 'retained', address: principal, kind: 'job.completed', summary: 'done', occurredAt: now }],
      now,
    )
    await pruneFeed(sql, now)
    const f = fake()
    const sub = await subscription(sql, f.transport)
    await deliverWebhooks(sql, network, now, { fetch: f.transport })
    const gap = f.deliveries[1]!
    expect(gap.envelope).toEqual({ type: 'gap', cursor: 'v1:4' })
    expect(gap.headers.get('webhook-id')).toMatch(/^msg_gap_/)
    await verifyWebhook(secret, gap.headers, gap.body, now * 1000)
    expect(f.deliveries[2]!.envelope.cursor).toBe('v1:4')
    expect((await row(sql, sub.id)).cursor_seq).toBe(4)
    await deliverWebhooks(sql, network, now + 60, { fetch: f.transport })
    expect(f.deliveries.filter((d) => d.envelope.type === 'gap')).toHaveLength(1)
  })
  it('does not deliver rows when a gap control fails or tombstones the subscription', async () => {
    for (const status of [503, 410]) {
      const sql = database()
      await seed(sql, 2)
      await sql.batch([stmt('DELETE FROM feed_events WHERE seq = 1')])
      const f = fake(() => new Response(null, { status }))
      const sub = await subscription(sql, f.transport)
      await deliverWebhooks(sql, network, now, { fetch: f.transport })
      expect(f.deliveries.filter((d) => d.envelope.eventId)).toHaveLength(0)
      expect(await row(sql, sub.id)).toMatchObject({ cursor_seq: 0, status: status === 410 ? 'terminated' : 'failing' })
    }
  })
  it('counts a gap control against the POST budget and resumes from the retained row', async () => {
    const sql = database()
    await seed(sql, 3)
    await sql.batch([stmt('DELETE FROM feed_events WHERE seq <= 2')])
    const f = fake()
    const sub = await subscription(sql, f.transport)
    expect((await deliverWebhooks(sql, network, now, { fetch: f.transport, budget: 1 })).posts).toBe(1)
    expect((await row(sql, sub.id)).cursor_seq).toBe(2)
    expect(f.deliveries.at(-1)!.envelope).toEqual({ type: 'gap', cursor: 'v1:3' })
    await deliverWebhooks(sql, network, now, { fetch: f.transport, budget: 1 })
    expect(f.deliveries.at(-1)!.envelope.cursor).toBe('v1:3')
    expect((await row(sql, sub.id)).cursor_seq).toBe(3)
  })
  it('aborts deliveries at 8 seconds, counts the timed-out POST and retains its cursor', async () => {
    vi.useFakeTimers()
    const sql = database()
    await seed(sql, 1)
    let entered!: () => void, signal: AbortSignal | null | undefined
    const callbackEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const f = fake((delivery) => {
      signal = delivery.init.signal
      entered()
      return new Promise<Response>(() => {})
    })
    const sub = await subscription(sql, f.transport)
    const pending = deliverWebhooks(sql, network, now, { fetch: f.transport })
    await callbackEntered
    await vi.advanceTimersByTimeAsync(8001)
    expect(await pending).toEqual({ posts: 1, subscriptions: 1 })
    expect(signal?.aborted).toBe(true)
    expect(await row(sql, sub.id)).toMatchObject({ cursor_seq: 0, failures: 1, next_attempt_at: now + 60 })
  })
  it('caps each stream at 20 rows, POSTs at 100 and parallel subscriptions at 6', async () => {
    const sql = database()
    await seed(sql, 30)
    let active = 0,
      peak = 0
    const f = fake(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active--
      return new Response(null, { status: 204 })
    })
    const ids: unknown[] = []
    for (let i = 0; i < 8; i++)
      ids.push(
        (
          await subscription(sql, f.transport, {
            delivery: { mode: 'webhook', url: `https://events.example/${i}`, secret },
          })
        ).id,
      )
    const result = await deliverWebhooks(sql, network, now, { fetch: f.transport, budget: 1000 })
    expect(result.posts).toBe(100)
    expect(peak).toBeLessThanOrEqual(6)
    expect(peak).toBeGreaterThan(1)
    for (const id of ids) expect((await row(sql, id)).cursor_seq).toBeLessThanOrEqual(20)
    expect(f.deliveries.filter((d) => d.envelope.eventId)).toHaveLength(100)
  })
  it('counts failed POSTs, controls and a smaller injected budget', async () => {
    const sql = database()
    await seed(sql, 3)
    const f = fake(() => new Response(null, { status: 503 }))
    for (let i = 0; i < 6; i++)
      await subscription(sql, f.transport, {
        delivery: { mode: 'webhook', url: `https://events.example/${i}`, secret },
      })
    expect((await deliverWebhooks(sql, network, now, { fetch: f.transport, budget: 2 })).posts).toBe(2)
    expect(f.deliveries.filter((d) => d.envelope.eventId)).toHaveLength(2)
  })
  it('skips expired and other-chain leases, and deletes expired leases only after seven days', async () => {
    const sql = database()
    await seed(sql)
    const f = fake()
    const sub = await subscription(sql, f.transport, { ttlMs: 1000 })
    await deliverWebhooks(sql, network, now + 1, { fetch: f.transport })
    expect(f.deliveries).toHaveLength(1)
    expect(await sql.all('SELECT id FROM event_subscriptions')).toHaveLength(1)
    await deliverWebhooks(sql, network, now + 7 * 86_400, { fetch: f.transport })
    expect(await sql.all('SELECT id FROM event_subscriptions')).toHaveLength(1)
    await deliverWebhooks(sql, network, now + 7 * 86_400 + 1, { fetch: f.transport })
    expect(await sql.all('SELECT id FROM event_subscriptions')).toHaveLength(0)
    const activeSub = await subscription(sql, f.transport)
    await deliverWebhooks(sql, 'monad-mainnet', now, { fetch: f.transport })
    expect((await row(sql, activeSub.id)).cursor_seq).toBe(0)
    expect(sub.id).toBe(activeSub.id)
  })
  it('revocation terminates all of a principal’s streams while preserving other principals', async () => {
    const sql = database()
    await seed(sql)
    const f = fake()
    const own = await subscription(sql, f.transport)
    const other = await subscribeWebhook(sql, network, stranger, params(), now, f.transport)
    await terminateSubscriptions(sql, principal.toUpperCase())
    expect((await row(sql, own.id)).status).toBe('terminated')
    expect((await row(sql, other.id)).status).toBe('active')
  })
  it('revoking one OAuth family terminates only that family and its in-flight subscriptions', async () => {
    const sql = database()
    await seed(sql)
    const first = await subscribeWebhook(
      sql,
      network,
      principal,
      params({ arguments: { kinds: ['job.submitted'] } }),
      now,
      fake().transport,
      'family-a',
    )
    const second = await subscribeWebhook(
      sql,
      network,
      principal,
      params({ arguments: { kinds: ['job.published'] } }),
      now,
      fake().transport,
      'family-b',
    )
    await terminateGrantSubscriptions(sql, principal, 'family-a', now + 1)
    expect((await row(sql, first.id)).status).toBe('terminated')
    expect((await row(sql, second.id)).status).toBe('active')
    await expect(
      subscribeWebhook(
        sql,
        network,
        principal,
        params({ arguments: { kinds: ['job.submitted'] } }),
        now + 2,
        fake().transport,
        'family-a',
      ),
    ).rejects.toMatchObject({ code: -32003 })
  })
  it('rechecks DNS on delivery and refuses a now-private callback without leaking thrown details', async () => {
    const sql = database()
    await seed(sql)
    const f = fake()
    const sub = await subscription(sql, f.transport)
    const privateDns = fake(undefined, { a: ['127.0.0.1'] })
    await deliverWebhooks(sql, network, now, { fetch: privateDns.transport })
    expect(privateDns.deliveries).toHaveLength(0)
    expect(await row(sql, sub.id)).toMatchObject({
      cursor_seq: 0,
      status: 'failing',
      last_error: 'Webhook delivery failed',
    })
  })
  it('bounds occurrence bodies to 256 KiB before posting', async () => {
    const sql = database()
    await writeFeed(
      sql,
      network,
      [{ id: 'huge', address: principal, kind: 'job.submitted', summary: 'x'.repeat(262_144), occurredAt: now }],
      now,
    )
    const f = fake()
    const sub = await subscription(sql, f.transport)
    await deliverWebhooks(sql, network, now, { fetch: f.transport })
    expect(f.deliveries.filter((d) => d.envelope.eventId)).toHaveLength(0)
    expect((await row(sql, sub.id)).cursor_seq).toBe(0)
  })
  it('creates only additive runtime DDL', async () => {
    const sql = database()
    await migrateWebhooks(sql)
    await migrateWebhooks(sql)
    expect(
      await sql.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_subscriptions'"),
    ).toHaveLength(1)
  })
})
