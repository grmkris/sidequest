/** Local R2 seeding and stage probe; uses the production HTTP boundary without chain doubles. */
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import * as sdk from '@sidequest/sdk'
import { Manifests } from '../src/manifests.ts'
import { miningRoute, type MiningBucket } from '../src/mining-prices.ts'

export default class MiningPricesProbe extends Cloudflare.Worker<MiningPricesProbe>()(
  'MiningPricesProbe',
  { main: import.meta.url, compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] } },
  Effect.gen(function* () {
    const storage = yield* Cloudflare.R2.ReadWriteBucket(Manifests)
    const env = yield* Cloudflare.WorkerEnvironment
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.originalUrl)
        if (url.pathname === '/runtime') return HttpServerResponse.text(navigator.userAgent)
        if (url.pathname.startsWith('/seed/')) {
          yield* storage.put(`mining/${url.pathname.slice('/seed/'.length)}`, yield* request.text)
          return HttpServerResponse.empty({ status: 204 })
        }
        const webRequest = yield* HttpServerRequest.toWeb(request)
        // SAFETY: Manifests is this local Worker's real R2 binding, with get/put and object byte reads.
        const bucket = (env as Record<string, unknown>).Manifests as MiningBucket
        return yield* Effect.promise(() =>
          miningRoute(webRequest, url.pathname, {
            stage: request.headers['x-probe-stage'] ?? 'dev',
            deployment: sdk.deployment('monad-testnet'),
            bucket,
          }),
        )
      }).pipe(Effect.orDie),
    }
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
) {}
