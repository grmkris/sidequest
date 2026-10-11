import { keccak256, stringToHex } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  type CheckDeps,
  DeliverableError,
  canonicalJson,
  checkDeliverable,
  commitApi,
  deliverableHash,
  fetchable,
  parseDeliverable,
  publicHost,
  readCapped,
  specOf,
  validateSpec,
} from './index.ts'

const SHA = 'a'.repeat(40)
const bytes = new TextEncoder().encode('hello deliverable')
const digest = async (b: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('')

const deps = (routes: Record<string, Response | (() => Response)>, chain?: CheckDeps['chain']): CheckDeps => ({
  now: () => 1,
  chain: chain ?? (() => undefined),
  fetch: (async (input: string | URL | Request) => {
    const url = String(input)
    const r = routes[url]
    if (r === undefined) return new Response('nope', { status: 404 })
    return typeof r === 'function' ? r() : r.clone()
  }) as typeof fetch,
})

const chain: CheckDeps['chain'] = (id) =>
  id === 10143
    ? {
        getTransactionReceipt: async () => ({ status: 'success' as const }),
        getCode: async ({ address }) => (address.endsWith('00') ? '0x' : '0x6080'),
      }
    : undefined

const artifact = (url: string) => ({
  kind: 'artifact',
  url,
  sha256: 'a'.repeat(64),
  mediaType: 'text/plain',
  name: 'a.txt',
})

describe('descriptors', () => {
  it('hashes a git deliverable exactly like the legacy {repo, branch, sha} triple', () => {
    const legacy = keccak256(stringToHex(canonicalJson({ repo: 'https://github.com/o/r', branch: 'main', sha: SHA })))
    expect(
      deliverableHash(parseDeliverable({ kind: 'git', url: 'https://github.com/o/r', ref: 'main', sha: SHA })),
    ).toBe(legacy)
  })

  it('hashes other kinds by their canonical descriptor, ignoring unknown fields and key order', () => {
    const a = parseDeliverable({ kind: 'url', url: 'https://x.example', extra: 1 })
    const b = parseDeliverable({ url: 'https://x.example', kind: 'url' })
    expect(deliverableHash(a)).toBe(deliverableHash(b))
    expect(deliverableHash(a)).toBe(keccak256(stringToHex('{"kind":"url","url":"https://x.example"}')))
  })

  it('refuses malformed descriptors', () => {
    expect(() => parseDeliverable({ kind: 'git', url: 'x', ref: 'main', sha: 'abc' })).toThrow(DeliverableError)
    expect(() =>
      parseDeliverable({ kind: 'artifact', url: 'ftp://x', sha256: 'a'.repeat(64), mediaType: 'a', name: 'b' }),
    ).toThrow(DeliverableError)
    expect(() =>
      parseDeliverable({ kind: 'url', url: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' }),
    ).toThrow(DeliverableError)
    expect(() => parseDeliverable({ kind: 'onchain', chainId: 10143 })).toThrow(DeliverableError)
    expect(() => parseDeliverable({ kind: 'zip' })).toThrow(DeliverableError)
  })

  it('accepts only public https and ipfs:// URLs, since the board fetches them at submit', () => {
    for (const url of [
      'http://site.example/',
      'https://localhost/',
      'https://api.localhost/',
      'https://127.0.0.1/',
      'https://10.0.0.5/a',
      'https://169.254.169.254/latest',
      'https://[::1]/',
      'https://0x7f000001/',
      'https://intranet/',
      'https://nas.local/f',
      'https://db.internal/x',
      'https://router.lan/',
      'https://user:pass@site.example/',
    ]) {
      expect(() => parseDeliverable({ kind: 'url', url }), url).toThrow(DeliverableError)
      expect(() => parseDeliverable(artifact(url)), url).toThrow(DeliverableError)
    }
    expect(parseDeliverable({ kind: 'url', url: 'https://site.example/' })).toEqual({
      kind: 'url',
      url: 'https://site.example/',
    })
    expect(
      parseDeliverable(artifact('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')),
    ).toMatchObject({ kind: 'artifact' })
  })

  it('lowercases on-chain identifiers so the hash does not depend on checksum casing', () => {
    const a = parseDeliverable({ kind: 'onchain', chainId: 10143, address: `0x${'AB'.repeat(20)}` })
    const b = parseDeliverable({ kind: 'onchain', chainId: 10143, address: `0x${'ab'.repeat(20)}` })
    expect(deliverableHash(a)).toBe(deliverableHash(b))
  })
})

describe('specs', () => {
  it('defaults to git only', () => {
    expect(specOf({})).toEqual({ accepts: ['git'] })
  })
  it('rejects empty, unknown and repeated kinds', () => {
    expect(validateSpec({ accepts: [] })).toBeDefined()
    expect(validateSpec({ accepts: ['zip' as 'git'] })).toBeDefined()
    expect(validateSpec({ accepts: ['git', 'git'] })).toBeDefined()
    expect(validateSpec({ accepts: ['git', 'artifact'], target: 'PR-able' })).toBeUndefined()
  })
})

describe('commitApi', () => {
  it('maps the public hosts and leaves the rest unverified', () => {
    expect(commitApi('https://github.com/o/r.git', SHA)?.api).toBe(`https://api.github.com/repos/o/r/commits/${SHA}`)
    expect(commitApi('https://gitlab.com/g/sub/r', SHA)?.api).toBe(
      `https://gitlab.com/api/v4/projects/g%2Fsub%2Fr/repository/commits/${SHA}`,
    )
    expect(commitApi('https://codeberg.org/o/r', SHA)?.api).toBe(
      `https://codeberg.org/api/v1/repos/o/r/git/commits/${SHA}`,
    )
    expect(commitApi('https://git.example.org/o/r', SHA)).toBeUndefined()
  })
})

describe('the submission check', () => {
  it('git: found, missing, unknown host', async () => {
    const d = parseDeliverable({ kind: 'git', url: 'https://github.com/o/r', ref: 'main', sha: SHA })
    const api = `https://api.github.com/repos/o/r/commits/${SHA}`
    expect((await checkDeliverable(d, deps({ [api]: new Response('{}') }))).ok).toBe(true)
    expect((await checkDeliverable(d, deps({}))).ok).toBe(false)
    const other = parseDeliverable({ kind: 'git', url: 'https://git.example.org/o/r', ref: 'main', sha: SHA })
    expect((await checkDeliverable(other, deps({}))).ok).toBeNull()
  })

  it('git: authenticates to GitHub when the board has a token, and says when GitHub rate-limits it', async () => {
    const d = parseDeliverable({ kind: 'git', url: 'https://github.com/o/r', ref: 'main', sha: SHA })
    const seen: Array<string | null> = []
    const recording =
      (status: number, remaining: string): CheckDeps['fetch'] =>
      async (_input: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('authorization'))
        return new Response('{}', { status, headers: { 'x-ratelimit-remaining': remaining } })
      }
    const withToken = { ...deps({}), fetch: recording(200, '4999'), githubToken: async () => 'ghs_installation' }
    expect((await checkDeliverable(d, withToken)).ok).toBe(true)
    const limited = await checkDeliverable(d, { ...deps({}), fetch: recording(403, '0') })
    expect(limited).toMatchObject({ ok: null, detail: 'github.com answered 403 (rate limited)' })
    const failing = { ...deps({}), fetch: recording(200, '59'), githubToken: () => Promise.reject(new Error('no app')) }
    expect((await checkDeliverable(d, failing)).ok).toBe(true)
    expect(seen).toEqual(['Bearer ghs_installation', null, null])
  })

  it('artifact: matching hash, tampered file, ipfs through the gateway', async () => {
    const sha256 = await digest(bytes)
    const good = parseDeliverable({
      kind: 'artifact',
      url: 'https://f.example/a.txt',
      sha256,
      mediaType: 'text/plain',
      name: 'a.txt',
    })
    expect((await checkDeliverable(good, deps({ 'https://f.example/a.txt': new Response(bytes) }))).ok).toBe(true)
    const tampered = await checkDeliverable(good, deps({ 'https://f.example/a.txt': new Response('something else') }))
    expect(tampered.ok).toBe(false)
    expect(tampered.detail).toMatch(/mismatch/)
    const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
    const pinned = parseDeliverable({
      kind: 'artifact',
      url: `ipfs://${cid}`,
      sha256,
      mediaType: 'text/plain',
      name: 'a.txt',
    })
    expect((await checkDeliverable(pinned, deps({ [`https://ipfs.io/ipfs/${cid}`]: new Response(bytes) }))).ok).toBe(
      true,
    )
  })

  it('artifact: does not hash past 25 MB', async () => {
    const big = new Response('x', { headers: { 'content-length': String(26 * 1024 * 1024) } })
    const d = parseDeliverable({
      kind: 'artifact',
      url: 'https://f.example/big',
      sha256: 'a'.repeat(64),
      mediaType: 'video/mp4',
      name: 'b.mp4',
    })
    expect((await checkDeliverable(d, deps({ 'https://f.example/big': big }))).ok).toBeNull()
  })

  it('url: live or not', async () => {
    const d = parseDeliverable({ kind: 'url', url: 'https://site.example/' })
    expect((await checkDeliverable(d, deps({ 'https://site.example/': new Response('<html>') }))).ok).toBe(true)
    expect((await checkDeliverable(d, deps({}))).ok).toBe(false)
  })

  it('onchain: receipt and code on a chain the board reads; unknown chain is unverified', async () => {
    const good = parseDeliverable({
      kind: 'onchain',
      chainId: 10143,
      txHash: `0x${'1'.repeat(64)}`,
      address: `0x${'2'.repeat(40)}`,
    })
    expect((await checkDeliverable(good, deps({}, chain))).ok).toBe(true)
    const noCode = parseDeliverable({ kind: 'onchain', chainId: 10143, address: `0x${'2'.repeat(38)}00` })
    expect((await checkDeliverable(noCode, deps({}, chain))).ok).toBe(false)
    const elsewhere = parseDeliverable({ kind: 'onchain', chainId: 1, address: `0x${'2'.repeat(40)}` })
    expect((await checkDeliverable(elsewhere, deps({}, chain))).ok).toBeNull()
  })

  it('never throws on a network failure, and names only the error class', async () => {
    const d = parseDeliverable({ kind: 'url', url: 'https://down.example/' })
    const failing = {
      ...deps({}),
      fetch: (async () => {
        throw Object.assign(new Error('connect ECONNREFUSED https://rpc.example/v2/SECRETKEY'), { name: 'TypeError' })
      }) as typeof fetch,
    }
    const r = await checkDeliverable(d, failing)
    expect(r.ok).toBeNull()
    expect(r.detail).toBe('could not check (TypeError)')
  })
})

/** A body that arrives in the given chunks, the way a network stream does. */
const chunked = (parts: string[], headers: Record<string, string> = {}) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of parts) controller.enqueue(new TextEncoder().encode(p))
        controller.close()
      },
    }),
    { headers },
  )
const text = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b))

describe('readCapped', () => {
  it('reads a body under the cap whole', async () => {
    expect(text((await readCapped(chunked(['ab', 'cd']), 4)).bytes)).toBe('abcd')
  })

  it('truncates at exactly the cap, across chunks', async () => {
    const r = await readCapped(chunked(['abc', 'def', 'ghi']), 5, 'truncate')
    expect(text(r.bytes)).toBe('abcde')
    expect(r.tooLarge).toBe(false)
  })

  it('fails past the cap, and on a declared length over it before reading', async () => {
    expect(await readCapped(chunked(['abc', 'def']), 5)).toEqual({ bytes: null, tooLarge: true })
    expect(await readCapped(chunked(['a'], { 'content-length': '99' }), 5)).toEqual({ bytes: null, tooLarge: true })
    expect(text((await readCapped(chunked(['abcdef'], { 'content-length': '99' }), 3, 'truncate')).bytes)).toBe('abc')
  })

  it('has no bytes for an empty response', async () => {
    expect(await readCapped(new Response(null), 5)).toEqual({ bytes: null, tooLarge: false })
  })
})

describe('the fetch guard', () => {
  it('names public DNS hosts only', () => {
    expect(publicHost('sq-site.example.workers.dev')).toBe(true)
    for (const host of ['localhost', 'printer', '10.0.0.1', '[::1]', '0x7f000001', 'nas.local', 'db.internal'])
      expect(publicHost(host), host).toBe(false)
  })

  it('takes public https and ipfs:// only, without credentials', () => {
    expect(fetchable('https://site.example/deliverable.json')).toBe(true)
    expect(fetchable(`ipfs://${'b'.repeat(46)}`)).toBe(true)
    for (const url of ['http://site.example/', 'https://user:pw@site.example/', 'https://127.0.0.1/', 'javascript:1'])
      expect(fetchable(url), url).toBe(false)
  })
})
