import { fileURLToPath } from 'node:url'
import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import { Stage } from 'alchemy/Stage'
import { defaultProviderMode } from 'alchemy/ProviderMode'
import * as Effect from 'effect/Effect'
import { Database } from './apps/api/src/database.ts'
import { Manifests } from './apps/api/src/manifests.ts'
import { Media } from './apps/api/src/media-bucket.ts'
import Api from './apps/api/src/worker.ts'
import Indexer from './apps/indexer/src/worker.ts'
import { assertDeployConfig } from './apps/api/src/deploy-preflight.ts'
import { assertLiveRelease, stateMode } from './scripts/sidequest/state.ts'
import { stageProfile } from './infra/stage.ts'

const selectedState = stateMode(process.env)

/**
 * Sidequest's own stack and state namespace. Local workerd uses the local stage;
 * the guarded development release owns dev.sidequest.exchange. Production remains separate.
 */
export default Alchemy.Stack(
  'Sidequest',
  {
    providers: Cloudflare.providers(),
    // Staging recovery is deliberately explicit. A stray remote-state variable must
    // never redirect an update to the duplicate/unknown backend.
    state: selectedState === 'remote' ? Cloudflare.state() : Alchemy.localState(),
  },
  Effect.gen(function* () {
    const stage = yield* Stage
    const mode = yield* defaultProviderMode
    // Alchemy gives local test stacks a generated stage name (for example
    // `test_kristjan`). Treat those as local; live mode still rejects every
    // stage except the explicitly configured dev/prod profiles.
    const profile = stage === 'dev' || stage === 'prod' ? stageProfile(stage) : undefined
    if (mode === 'live') assertLiveRelease(stage, selectedState, process.env)
    yield* Effect.promise(() => assertDeployConfig(profile?.stage ?? 'local', profile))
    const database = yield* Database
    const manifests = yield* Manifests
    const media = yield* Media
    const api = yield* Api
    const indexer = yield* Indexer
    // Explore (spec §6): the SPA's assets, with the board API proxied same-origin through a service binding.
    // The local stack test leaves it out (SIDEQUEST_WITHOUT_EXPLORE): its Vite child needs a remote session.
    if (process.env.SIDEQUEST_WITHOUT_EXPLORE === '1') {
      return {
        apiUrl: api.url,
        indexerUrl: indexer.url,
        databaseName: database.databaseName,
        manifestsBucket: manifests.bucketName,
        mediaBucket: media.bucketName,
      }
    }
    // Each stage owns only its canonical hostname. The development stack never claims the apex.
    const explore = yield* Cloudflare.Website.Vite('Explore', {
      ...(profile ? { name: profile.resources.Explore } : {}),
      rootDir: fileURLToPath(new URL('./apps/explore/', import.meta.url)),
      main: 'worker.ts',
      memo: {
        workspaces: [
          { cwd: '../docs' },
          { cwd: '../../skill' },
          { cwd: '../../packages/sdk' },
          { cwd: '../../packages/react' },
          { cwd: '../../contracts/config' },
          { cwd: '../../infra' },
        ],
      },
      ...(profile ? { domain: { name: new URL(profile.origin).hostname } } : {}),
      observability: {
        enabled: true,
        // Setting observability replaces Alchemy's default, so its logs block is spelled out beside the traces.
        logs: { enabled: true, invocationLogs: true },
        traces: { enabled: true, headSamplingRate: 1, persist: true },
      },
      env: { API: api },
      assets: {
        notFoundHandling: 'single-page-application',
        // The Worker proxies the API and adds the page security headers.
        runWorkerFirst: true,
      },
    })
    return {
      exploreUrl: explore.url,
      apiUrl: api.url,
      indexerUrl: indexer.url,
      databaseName: database.databaseName,
      manifestsBucket: manifests.bucketName,
      mediaBucket: media.bucketName,
    }
  }),
)
