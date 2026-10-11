import { expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { CloudflareManifests } from './publish-lib.ts'

const token = 'fixture-secret-token'
const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: token }
const reply = (result: unknown, result_info?: unknown) =>
  new Response(JSON.stringify({ success: true, result, result_info }))
const requestOf = (respond: (url: URL) => Response | Promise<Response>): typeof fetch => {
  return async (input: string | URL | Request) => respond(new URL(input instanceof Request ? input.url : input))
}

test('R2 object listing follows encoded cursors and preserves the prefix on every page', async () => {
  const calls: URL[] = []
  const store = new CloudflareManifests(
    env,
    requestOf((url) => {
      calls.push(url)
      expect(url.pathname).toEndWith('/r2/buckets/fixture/objects')
      expect(url.searchParams.get('prefix')).toBe('mining/')
      expect(url.searchParams.get('per_page')).toBe('1000')
      return calls.length === 1
        ? reply({ objects: [{ key: 'mining/prices-9.json' }], truncated: true, cursor: 'next +/&' })
        : reply({ objects: [{ key: 'mining/prices-10.json' }], truncated: false, cursor: 'ignored' })
    }),
  )
  expect(await store.list('fixture', 'mining/')).toEqual(['mining/prices-9.json', 'mining/prices-10.json'])
  expect(calls[0]?.searchParams.has('cursor')).toBe(false)
  expect(calls[1]?.searchParams.get('cursor')).toBe('next +/&')
})

test('R2 listing also follows result_info cursors and refuses malformed or stalled pages', async () => {
  let page = 0
  const store = new CloudflareManifests(
    env,
    requestOf(() => (++page === 1 ? reply([{ key: 'mining/prices-1.json' }], { cursor: 'next' }) : reply([]))),
  )
  expect(await store.list('fixture', 'mining/')).toEqual(['mining/prices-1.json'])
  for (const result of [null, { objects: [{}] }, { objects: [], truncated: true }, { objects: [], cursor: 'loop' }]) {
    const bad = new CloudflareManifests(
      env,
      requestOf(() => reply(result)),
    )
    await rejects(bad.list('fixture', 'mining/'), /cloudflare-unavailable/)
  }
})

test('find treats only 404 as absent; get, list and put still refuse it', async () => {
  const store = new CloudflareManifests(
    env,
    requestOf(() => new Response(token, { status: 404 })),
  )
  expect(await store.find('fixture', 'mining/absent.json')).toBeNull()
  await rejects(store.get('fixture', 'mining/absent.json'), /cloudflare-unavailable/)
  await rejects(store.list('fixture', 'mining/'), /cloudflare-unavailable/)
  await rejects(store.put('fixture', 'mining/a.json', new Uint8Array()), /cloudflare-unavailable/)
})

test('find returns exact bytes and refuses 500 or fetch exceptions without exposing the token', async () => {
  const bytes = new Uint8Array([0, 255, 10])
  const store = new CloudflareManifests(
    env,
    requestOf(() => new Response(bytes)),
  )
  expect(await store.find('fixture', 'mining/a.json')).toEqual(bytes)
  for (const respond of [
    () => new Response(token, { status: 500 }),
    () => {
      throw new Error(token)
    },
  ]) {
    const bad = new CloudflareManifests(env, requestOf(respond))
    for (const operation of [bad.find('fixture', 'mining/a.json'), bad.list('fixture', 'mining/')]) {
      const error = await operation.catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toBe('Error: cloudflare-unavailable')
      expect(String(error)).not.toContain(token)
    }
  }
})
