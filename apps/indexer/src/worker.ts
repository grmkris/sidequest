import { contractsOf, fromD1, hyperSync, migrate, releaseLease, rpcHead, runOnce } from '@sidequest/indexer'
import * as sdk from '@sidequest/sdk'
import { stageProfile } from '../../../infra/stage.ts'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { Database } from '@sidequest/indexer/database'
import { rpcUrlForNetwork } from '@sidequest/indexer/network'
import { runtimeSecret } from '@sidequest/board/runtime'
import { queueTelegramNotifications } from '@sidequest/indexer/telegram-notifications'
import {
  configurePublicSite,
  publicOrigin,
  drainTelegramOutbox,
  migrateTelegram,
  telegramTransport,
} from '@sidequest/indexer/telegram'
import { reportRelayWatchFailure, watchRelay } from '@sidequest/indexer/relay-watch'
import { gasWatches, reportGasWatchFailure, watchGas } from '@sidequest/indexer/gas-watch'
import { feedFromChain, feedFromDeadlines, pruneFeed, reportFeedFailure } from '@sidequest/indexer/feed'
import { deliverWebhooks, reportWebhookFailure } from '@sidequest/indexer/webhooks'
import { recordIndexerRun, type IndexerRunOutcome } from './run-record.ts'

/** A poked run waits until the checkpoint is older than one cron period and a little. */
const STALE_SECONDS = 50

const secret = (name: string) =>
  Config.Redacted(name).pipe(Effect.map((v) => (Redacted.value(v) === 'unset' ? '' : Redacted.value(v))))

/** The remaining relay monitor is testnet-only; every stage watches its actual gas funders. */
async function watchStageGas(
  sql: Parameters<typeof watchRelay>[0],
  deployment: sdk.Deployment,
  client: ReturnType<typeof sdk.context>['publicClient'],
  now: number,
): Promise<void> {
  const network = deployment.network
  if (network === 'monad-testnet')
    await watchRelay(sql, {
      network,
      now,
      relay: deployment.relay,
      balance: () => client.getBalance({ address: deployment.relay }),
    }).catch(reportRelayWatchFailure)
  for (const watch of gasWatches(deployment, client))
    await watchGas(sql, { network, now, watch }).catch(reportGasWatchFailure)
}

/**
 * The chain-facts indexer (spec §5 `apps/indexer`, plan S4): every minute, under the lease in D1, index finalized
 * logs of the core, Holdings and evaluators from HyperSync into D1. The only D1 writer; Explore reads.
 * `GET /status` reports the checkpoint.
 */
export default class Indexer extends Cloudflare.Worker<Indexer>()(
  'Indexer',
  {
    main: import.meta.url,
    ...(stageProfile() ? { name: stageProfile()!.resources.Indexer } : {}),
    compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
    // Cloudflare.Telemetry enables the trace channel in the Layer below, including
    // cron and D1 spans. Setting observability replaces Alchemy's whole default, so its logs block is spelled out.
    observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
    dev: { port: 8789 },
    env: {
      NETWORK: stageProfile()?.network ?? process.env.SIDEQUEST_NETWORK ?? 'monad-testnet',
      PUBLIC_ORIGIN: stageProfile()?.origin ?? 'http://localhost:5173',
      // Mainnet keeps prod-testnet's binding name with the zero relay: the guarded release refuses binding deletion.
      RELAY_ADDRESS:
        stageProfile()?.relay ??
        sdk.deployment((stageProfile()?.network ?? process.env.SIDEQUEST_NETWORK ?? 'monad-testnet') as sdk.Network)
          .relay,
      TELEGRAM_BOT_USERNAME: stageProfile()?.telegram.botUsername ?? '',
      HYPERSYNC_URL:
        process.env.HYPERSYNC_URL ??
        ((stageProfile()?.network ?? process.env.SIDEQUEST_NETWORK) === 'monad-mainnet'
          ? 'https://monad.hypersync.xyz'
          : 'https://monad-testnet.hypersync.xyz'),
      MONAD_RPC_URL: Redacted.make(rpcUrlForNetwork() || 'unset'),
      HYPERSYNC_API_TOKEN: Redacted.make(runtimeSecret('HYPERSYNC_API_TOKEN') || 'unset'),
      TELEGRAM_BOT_TOKEN: Redacted.make(runtimeSecret('TELEGRAM_BOT_TOKEN') || 'unset'),
    },
  },
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.QueryDatabase(Database)

    /** The last cron outcome, kept in D1 for `GET /` (Workers logs need a permission the deploy token lacks). */
    const record = (outcome: IndexerRunOutcome) =>
      Effect.gen(function* () {
        const raw = yield* db.raw
        const sql = fromD1(raw as never)
        yield* Effect.promise(() => recordIndexerRun(sql, outcome, Math.floor(Date.now() / 1000)))
      })

    const run = Effect.gen(function* () {
      const runRequest = Effect.runPromiseWith(yield* Effect.context())
      const phase = <A>(name: string, action: () => Promise<A>) =>
        runRequest(Effect.promise(action).pipe(Effect.withSpan(name)))
      const network = (yield* Config.String('NETWORK')) as sdk.Network
      const relayAddress = yield* Config.withDefault(Config.String('RELAY_ADDRESS'), '')
      // SAFETY: the testnet-only binding is the validated stage or SDK relay address.
      if (relayAddress !== '') sdk.setRelayOverride(relayAddress as `0x${string}`)
      configurePublicSite(yield* Config.String('PUBLIC_ORIGIN'), yield* Config.String('TELEGRAM_BOT_USERNAME'))
      const token = yield* secret('HYPERSYNC_API_TOKEN')
      const rpcUrl = yield* secret('MONAD_RPC_URL')
      const telegramToken = yield* secret('TELEGRAM_BOT_TOKEN')
      const raw = yield* db.raw
      const sql = fromD1(raw as never)
      yield* Effect.promise(() => migrateTelegram(sql))
      if (token === '' || rpcUrl === '') {
        if (telegramToken !== '')
          yield* Effect.promise(() =>
            drainTelegramOutbox(sql, telegramTransport(telegramToken), Math.floor(Date.now() / 1000)),
          )
        return { skipped: 'HYPERSYNC_API_TOKEN or MONAD_RPC_URL unset' }
      }
      const hyper = yield* Config.String('HYPERSYNC_URL')
      return yield* Effect.promise(async () => {
        await phase('indexer.migrate', () => migrate(sql))
        let allowSilence = false
        const indexer = {
          contracts: contractsOf(network),
          deployBlock: Number(sdk.deployment(network).deployBlock),
          source: hyperSync(hyper, token),
          head: rpcHead(rpcUrl),
          runner: `cron:${crypto.randomUUID()}`,
          maxPages: 5,
          offers: { boards: sdk.deployment(network).boards ?? [], origin: publicOrigin() },
        }
        try {
          const result = await phase('indexer.ingest', () => runOnce(sql, indexer))
          // Judged against the head this run indexed to. A second head lookup here raced a chain that finalizes
          // several blocks a second, so it almost never passed and the feed and notifications stood still.
          const caughtUp = result.caughtUp
          // The inbox feed (V1.1 WS4) follows finalized transitions whether or not Telegram is configured.
          const fedAt = Math.floor(Date.now() / 1000)
          // 100 events is about 300 D1 statements, so a catch-up run leaves room for the Telegram queue below.
          await phase('indexer.feed', () => feedFromChain(sql, network, fedAt, { caughtUp, limit: 100 })).catch(
            reportFeedFailure,
          )
          await phase('indexer.deadlines', () => feedFromDeadlines(sql, network, fedAt)).catch(reportFeedFailure)
          if (fedAt % 3600 < 60) await pruneFeed(sql, fedAt).catch(reportFeedFailure)
          // Webhooks send what the feed holds; board and approval events arrive whether or not the chain index is caught up.
          await phase('indexer.webhooks', () => deliverWebhooks(sql, network, fedAt)).catch(reportWebhookFailure)
          if (telegramToken !== '') {
            const now = Math.floor(Date.now() / 1000)
            const deployment = sdk.deployment(network)
            const client = sdk.context(network, 'main', rpcUrl).publicClient
            const notifications = await phase('indexer.notifications', () =>
              queueTelegramNotifications(sql, network, now, { caughtUp }),
            )
            allowSilence = !notifications.stale
            await watchStageGas(sql, deployment, client, now)
          }
          return result
        } finally {
          // The next minute's run indexes at once instead of being refused while this lease runs out. A failed
          // release only means waiting for expiry, as before.
          await phase('indexer.release-lease', () => releaseLease(sql, indexer)).catch(() => undefined)
          if (telegramToken !== '')
            await phase('indexer.deliver-notifications', () =>
              drainTelegramOutbox(
                sql,
                telegramTransport(telegramToken),
                Math.floor(Date.now() / 1000),
                20,
                allowSilence,
              ),
            )
        }
      })
    })

    const recordedRun = run.pipe(
      Effect.withSpan('indexer.run'),
      Effect.flatMap((r) => record({ ok: true, result: r }).pipe(Effect.as(true))),
      Effect.catchCause((c) => record({ ok: false, cause: c }).pipe(Effect.ignore, Effect.as(false))),
    )
    yield* Cloudflare.Workers.cron('* * * * *', () => recordedRun)

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const raw = yield* db.raw
        const sql = fromD1(raw as never)
        // While Cloudflare's cron activation fails (incident of 13 Oct), an outside poke runs the same pass. It runs
        // only when this chain's checkpoint is stale, and the ingest lease keeps it from overlapping a cron run.
        if (request.method === 'POST' && new URL(request.originalUrl, 'http://indexer').pathname === '/run') {
          // SAFETY: NETWORK is bound at deploy from the stage profile's network, always one of the SDK's networks.
          const chainId = sdk.deployment((yield* Config.String('NETWORK')) as sdk.Network).chainId
          const stale = yield* Effect.promise(async () => {
            await migrate(sql)
            const [row] = await sql.all<{ updated_at: number }>(
              'SELECT updated_at FROM checkpoint WHERE chain_id=?',
              chainId,
            )
            return row === undefined || Math.floor(Date.now() / 1000) - row.updated_at > STALE_SECONDS
          })
          if (!stale) return HttpServerResponse.jsonUnsafe({ ok: true, ran: false })
          const ok = yield* recordedRun
          return HttpServerResponse.jsonUnsafe({ ok, ran: true }, { status: ok ? 200 : 503 })
        }
        const rows = yield* Effect.promise(async () => {
          await migrate(sql)
          return {
            checkpoint: await sql.all(
              'SELECT chain_id, next_block, core_address, deployment_block, updated_at FROM checkpoint',
            ),
            jobs: await sql.all<{ n: number }>('SELECT count(*) AS n FROM jobs'),
            lastRun: await sql.all('SELECT at, ok, detail FROM indexer_runs').catch(() => []),
          }
        })
        return HttpServerResponse.jsonUnsafe({ ok: true, ...rows })
      }).pipe(Effect.orDie),
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.Workers.CronEventSourceLive,
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.Telemetry({ headSamplingRate: 1, persist: true }),
      ),
    ),
  ),
) {}
