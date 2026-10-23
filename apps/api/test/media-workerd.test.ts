/** ADR-0029 on real workerd D1 and R2: uploads, the library, file serving with ranges and tokens, shares. */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import * as Effect from 'effect/Effect'
import { expect, it } from 'vitest'
import { hostedCallFailure } from '../src/hosted-admission.ts'
import { parseHostedAdmission } from '@sidequest/board'
import MediaProbe, { PULLED } from './media-worker.ts'

const { test, beforeAll, deploy } = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  dev: true,
})
const Stack = Alchemy.Stack(
  'MediaLocalTest',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* MediaProbe
    return { url: worker.url }
  }),
)
const stack = beforeAll(deploy(Stack))

const OPERATOR = '0x1111111111111111111111111111111111111111'
const MEMBER = '0x2222222222222222222222222222222222222222'
const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
// Local D1 and R2 persist across runs: each run uploads its own bytes under its own ids.
const video = crypto.getRandomValues(new Uint8Array(64 * 1024))
const run = crypto.randomUUID().slice(0, 8)
const cut = `probe-cut-${run}`
let n = 0

async function tool(url: string, name: string, args: Record<string, unknown>, wallet?: string) {
  const response = await fetch(`${url}/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: name, wallet, args: { operationKey: `key-${run}-${++n}`, ...args } }),
  })
  // SAFETY: the probe answers runMediaTool's reply.
  return (await response.json()) as { ok: boolean; result?: any; code?: string; message?: string }
}

test(
  'a team member uploads, adds and shares; an operator publishes; files stream with lengths, ranges and tokens',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(async () => {
      const sha256 = hex(video)
      // An upload link for this exact file; the stranger gets none.
      expect(
        (await tool(url!, 'prepare_media_upload', { files: [{ sha256, bytes: video.length, type: 'video/mp4' }] }))
          .code,
      ).toBe('forbidden')
      const prepared = await tool(
        url!,
        'prepare_media_upload',
        { files: [{ sha256, bytes: video.length, type: 'video/mp4' }] },
        MEMBER,
      )
      const upload = new URL(prepared.result.files[0].url)
      const put = (body: Uint8Array, type = 'video/mp4', at = upload) =>
        fetch(`${url}${at.pathname}${at.search}`, { method: 'PUT', headers: { 'content-type': type }, body })
      expect((await put(video, 'image/png')).status).toBe(400)
      const wrong = video.slice()
      wrong[0] = 255
      expect((await put(wrong)).status).toBe(400)
      expect((await fetch(`${url}${upload.pathname}?u=forged.token`, { method: 'PUT', body: video })).status).toBe(403)
      expect((await put(video)).status).toBe(201)
      expect((await put(video)).status).toBe(200)

      const added = await tool(
        url!,
        'add_media',
        { id: cut, title: 'Probe cut', files: [{ name: 'cut.mp4', role: 'main', sha256 }] },
        MEMBER,
      )
      expect(added).toMatchObject({ ok: true, result: { id: cut, level: 'internal' } })
      const pulled = await tool(
        url!,
        'add_media',
        {
          id: `probe-pulled-${run}`,
          title: 'Pulled',
          files: [{ name: 'pulled.mp4', role: 'main', sourceUrl: 'https://renders.example/pulled.mp4' }],
        },
        MEMBER,
      )
      expect(pulled.ok).toBe(true)
      expect(
        (
          await tool(
            url!,
            'add_media',
            {
              title: 'Blocked',
              files: [{ name: 'x.mp4', role: 'main', sourceUrl: 'https://elsewhere.example/x.mp4' }],
            },
            MEMBER,
          )
        ).code,
      ).toBe('forbidden')

      // Internal: not served without a token; the team's preview URL plays with ranges.
      const plain = `${url}/media/f/${cut}/cut.mp4`
      expect((await fetch(plain)).status).toBe(404)
      const listed = await tool(url!, 'get_media', { id: cut }, MEMBER)
      // SAFETY: a team read of an internal asset carries a preview URL for each file.
      const preview = listed.result.asset.files[0].url as string
      expect(preview).toContain('?p=')
      const ranged = await fetch(`${url}${new URL(preview).pathname}${new URL(preview).search}`, {
        headers: { range: 'bytes=0-1023' },
      })
      expect(ranged.status).toBe(206)
      expect(ranged.headers.get('content-length')).toBe('1024')
      expect(ranged.headers.get('content-range')).toBe(`bytes 0-1023/${video.length}`)
      expect(ranged.headers.get('cache-control')).toMatch(/^private, max-age=\d+$/)
      expect(ranged.headers.get('content-security-policy')).toContain('sandbox')
      expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(video.slice(0, 1024))
      const tampered = new URL(preview)
      tampered.searchParams.set('p', `${tampered.searchParams.get('p')!.split('.')[0]}.${'A'.repeat(43)}`)
      expect((await fetch(`${url}${tampered.pathname}${tampered.search}`)).status).toBe(404)
      const pulledFile = (await tool(url!, 'get_media', { id: `probe-pulled-${run}` }, MEMBER)).result.asset.files[0]
      expect([pulledFile.bytes, pulledFile.sha256]).toEqual([PULLED.length, hex(PULLED)])

      // A share hands the internal file out until it is revoked.
      const shared = await tool(url!, 'share_media', { assets: [cut], label: 'probe' }, MEMBER)
      const token = new URL(shared.result.url).pathname.split('/').pop()!
      const share = await tool(url!, 'get_media_share', { token })
      const shareUrl = new URL(share.result.assets[0].files[0].url)
      expect((await fetch(`${url}${shareUrl.pathname}${shareUrl.search}`)).status).toBe(200)
      expect((await tool(url!, 'revoke_media_share', { id: shared.result.id }, MEMBER)).ok).toBe(true)
      expect((await fetch(`${url}${shareUrl.pathname}${shareUrl.search}`)).status).toBe(404)

      // Publishing is an operator's; a public file is served whole, by HEAD, by suffix and as a download.
      expect((await tool(url!, 'publish_media', { id: cut, public: true }, MEMBER)).code).toBe('forbidden')
      expect((await tool(url!, 'publish_media', { id: cut, public: true }, OPERATOR)).ok).toBe(true)
      const versioned = `${plain}?v=${sha256.slice(0, 8)}`
      const whole = await fetch(versioned)
      expect([whole.status, whole.headers.get('content-length'), whole.headers.get('cache-control')]).toEqual([
        200,
        String(video.length),
        'public, max-age=31536000, immutable',
      ])
      expect(new Uint8Array(await whole.arrayBuffer())).toEqual(video)
      const head = await fetch(plain, { method: 'HEAD' })
      expect([head.status, head.headers.get('content-length')]).toEqual([200, String(video.length)])
      const suffix = await fetch(plain, { headers: { range: 'bytes=-10' } })
      expect([suffix.status, suffix.headers.get('content-range')]).toEqual([
        206,
        `bytes ${video.length - 10}-${video.length - 1}/${video.length}`,
      ])
      expect((await fetch(plain, { headers: { range: `bytes=${video.length + 5}-` } })).status).toBe(416)
      const etag = whole.headers.get('etag')!
      expect((await fetch(plain, { headers: { 'if-none-match': etag } })).status).toBe(304)
      expect((await fetch(`${plain}?dl=1`)).headers.get('content-disposition')).toBe('attachment; filename="cut.mp4"')
      expect((await tool(url!, 'list_media', {})).result.assets.map((asset: { id: string }) => asset.id)).toContain(cut)

      // Unpublished: gone at once.
      expect((await tool(url!, 'publish_media', { id: cut, public: false }, OPERATOR)).ok).toBe(true)
      expect((await fetch(versioned)).status).toBe(404)
    })
  }),
)

test(
  'a stale revision on D1 rolls the batch back: the CASE WHEN changes() guard holds on workerd',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(async () => {
      const sha256 = hex(video)
      const added = await tool(
        url!,
        'add_media',
        { id: `probe-guard-${run}`, title: 'Guard', files: [{ name: 'g.mp4', role: 'main', sha256 }] },
        MEMBER,
      )
      expect(added.ok).toBe(true)
      expect(
        (await tool(url!, 'update_media', { id: `probe-guard-${run}`, revision: 1, title: 'Two' }, MEMBER)).ok,
      ).toBe(true)
      expect(
        (await tool(url!, 'update_media', { id: `probe-guard-${run}`, revision: 1, title: 'Lost' }, MEMBER)).code,
      ).toBe('conflict')
      expect((await tool(url!, 'get_media', { id: `probe-guard-${run}` }, MEMBER)).result.asset).toMatchObject({
        title: 'Two',
        revision: 2,
      })
    })
  }),
)

it('production admission refuses a media tool it was not told about, so the Worker runs media before it', () => {
  expect(
    hostedCallFailure(parseHostedAdmission('0'), 'monad-mainnet', 'public', 'add_media', {}, undefined, 'prod'),
  ).toBeDefined()
  const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
  const media = worker.indexOf('if (isMediaTool(tool) && oauthCaller === undefined)')
  expect(media).toBeGreaterThan(0)
  expect(media).toBeLessThan(worker.indexOf('const denied = hostedCallFailure('))
})
