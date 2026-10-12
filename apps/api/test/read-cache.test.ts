import { expect, it } from 'vitest'
import * as Effect from 'effect/Effect'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { responseCacheControl, withReadCachePolicy } from '../src/read-cache.ts'
import { observeRequest } from '../src/observability.ts'

const ok = HttpServerResponse.jsonUnsafe({ ok: true })
const read = (path: string, headers: Record<string, string> = {}, method = 'GET', response = ok) =>
  responseCacheControl({ method, url: `https://api.example${path}`, headers }, response)

it('gives bounded freshness only to allowlisted public discovery replies, including tenant lists', () => {
  expect(read('/data/boards')).toBe('public, max-age=0, s-maxage=60')
  expect(read('/b/team/data/jobs?cursor=50')).toBe('public, max-age=0, s-maxage=10')
  expect(read('/data/directory?after=50')).toContain('s-maxage=30')
})

it('bypasses credentials, personalized data, errors, mutations and live economic reads', () => {
  for (const headers of [
    { authorization: 'Bearer private' },
    { cookie: 'session=private' },
    { 'mcp-session-id': 'private' },
    { 'x-privy-token': 'private' },
  ])
    expect(read('/data/boards', headers)).toBe('no-store')
  for (const path of [
    '/data/backing/0xabc',
    '/data/delegations',
    '/data/jobs/7',
    '/data/agents/9',
    '/api/agents',
    '/data/agents?wallet=0xabc',
  ])
    expect(read(path)).toBe('no-store')
  expect(read('/data/boards', {}, 'POST')).toBe('no-store')
  expect(read('/data/boards', {}, 'GET', HttpServerResponse.empty({ status: 503 }))).toBe('no-store')
  expect(
    read('/data/boards', {}, 'GET', HttpServerResponse.empty({ headers: { 'set-cookie': 'session=private' } })),
  ).toBe('no-store')
  expect(read('/data/boards', {}, 'GET', ok.pipe(HttpServerResponse.setCookieUnsafe('session', 'private')))).toBe(
    'no-store',
  )
})

it('preserves conditional metadata caching without making arbitrary 304 replies public', () => {
  const unchanged = HttpServerResponse.empty({ status: 304, headers: { 'cache-control': 'public, max-age=3600' } })
  expect(read('/mcp/server-card', {}, 'GET', unchanged)).toBe('public, max-age=3600')
  expect(read('/b/team/.well-known/ai-catalog.json', {}, 'HEAD', unchanged)).toBe('public, max-age=3600')
  expect(read('/api/agents', {}, 'GET', unchanged)).toBe('no-store')
  expect(read('/mcp/server-card', { cookie: 'session=private' }, 'GET', unchanged)).toBe('no-store')
})

it('composes timing with the cache policy and varies on every bypass credential without duplicate origins', async () => {
  const response = await Effect.runPromise(
    Effect.succeed(ok.pipe(HttpServerResponse.setHeader('vary', 'Origin, accept-encoding'))).pipe(
      withReadCachePolicy,
      observeRequest,
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request('https://api.example/data/jobs')),
      ),
    ),
  )
  expect(response.headers['cache-control']).toBe('public, max-age=0, s-maxage=10')
  expect(response.headers.vary).toBe('origin, accept-encoding, authorization, cookie, mcp-session-id, x-privy-token')
  expect(response.headers['x-request-id']).toMatch(/^[a-f\d-]{36}$/)
  expect(response.headers['server-timing']).toMatch(/^api;dur=/)
})

it('preserves content-addressed asset policies only for anonymous successful reads', () => {
  const immutable = HttpServerResponse.text('asset', {
    headers: { 'cache-control': 'public, max-age=31536000, immutable' },
  })
  expect(read('/offers/0x123.json', {}, 'GET', immutable)).toContain('immutable')
  expect(read('/offers/0x123.json', { authorization: 'Bearer private' }, 'GET', immutable)).toBe('no-store')
  expect(read('/api/agents', {}, 'GET', immutable)).toBe('no-store')
})
