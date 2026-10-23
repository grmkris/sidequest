/** Test-only probe: the media routes and tools on real workerd D1 and R2; only the pulled file's origin is local. */
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { fromD1 } from '@sidequest/indexer'
import { migrateMedia } from '@sidequest/indexer/media-schema'
import type { StageMedia } from '../../../infra/stage.ts'
import { walletActor } from '../src/media/access.ts'
import { type MediaBucket, receiveMediaUpload, serveMediaFile } from '../src/media/serve.ts'
import { runMediaTool } from '../src/media/tools.ts'

const Database = Cloudflare.D1.Database('MediaProbeDatabase')
const Media = Cloudflare.R2.Bucket('MediaProbeFiles')

const PROBE_KEY = 'media-probe-signing-key-0123456789abcdef'
const PROBE_TEAM: StageMedia = {
  team: [
    { wallet: '0x1111111111111111111111111111111111111111', role: 'operator' },
    { wallet: '0x2222222222222222222222222222222222222222', role: 'member' },
  ],
  timezone: 'Europe/Ljubljana',
  pullHosts: ['renders.example'],
}
/** The one file `renders.example` serves to the pull path: 300 KB of a repeating pattern. */
export const PULLED = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7) % 251)

const pullSource = async (input: string | URL | Request) =>
  new URL(input instanceof Request ? input.url : input).hostname === 'renders.example'
    ? new Response(PULLED, { headers: { 'content-type': 'video/mp4', 'content-length': String(PULLED.length) } })
    : new Response('not found', { status: 404 })

export default class MediaProbe extends Cloudflare.Worker<MediaProbe>()(
  'MediaProbe',
  {
    main: import.meta.url,
    compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
  },
  Effect.gen(function* () {
    const database = yield* Cloudflare.D1.QueryDatabase(Database)
    yield* Cloudflare.R2.ReadWriteBucket(Media)
    const env = yield* Cloudflare.WorkerEnvironment
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.originalUrl)
        const sql = fromD1(yield* database.raw)
        // SAFETY: MediaProbeFiles is this probe's R2 binding.
        const bucket = (env as Record<string, unknown>).MediaProbeFiles as MediaBucket
        const now = Math.floor(Date.now() / 1000)
        const webRequest = request.source
        if (!(webRequest instanceof Request)) return HttpServerResponse.text('unavailable', { status: 503 })
        const response = yield* Effect.promise(async () => {
          await migrateMedia(sql)
          const deps = { sql, bucket, signingKey: PROBE_KEY, now }
          if (url.pathname.startsWith('/media/f/')) return serveMediaFile(deps, webRequest, url)
          if (url.pathname.startsWith('/media/upload/')) return receiveMediaUpload(deps, webRequest, url)
          // SAFETY: only this suite posts to the probe, always with this shape.
          const body = (await webRequest.json()) as { tool: string; wallet?: string; args: Record<string, unknown> }
          const reply = await runMediaTool(
            {
              sql,
              bucket,
              media: PROBE_TEAM,
              signingKey: PROBE_KEY,
              origin: url.origin,
              now: () => now,
              fetch: pullSource,
            },
            walletActor(PROBE_TEAM, body.wallet),
            body.tool,
            body.args,
          )
          return Response.json(reply)
        })
        return HttpServerResponse.raw(response, { status: response.status })
      }),
    }
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding), Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
) {}
