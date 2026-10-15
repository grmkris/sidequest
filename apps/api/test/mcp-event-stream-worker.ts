/** Local-only entrypoint: real API/management code with SQLite grant seeding before OAuth resolution. */
import { AgentStore, fromDurableObjectSql, migrateAgentSchema, type Sql } from '@sidequest/board'
import { fromD1, migrate } from '@sidequest/indexer'
import { writeFeed } from '@sidequest/indexer/feed'
import { deployment } from '@sidequest/sdk'
import * as Cloudflare from 'alchemy/Cloudflare'
import type { DurableObjectExport } from 'alchemy/Cloudflare/Workers'
import * as Effect from 'effect/Effect'
import type Board from '../src/board.ts'
import Api from '../src/worker.ts'
import { tokenHash } from '../src/oauth-validation.ts'

export const STREAM_TOKEN = 'local-event-stream-fixture'
export const APPEND_TOKEN = `${STREAM_TOKEN}:append`
const STREAM_WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const FAMILY = 'local-event-stream-family'

async function seed(sql: Sql, resource: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const network = deployment('monad-testnet')
  migrateAgentSchema(sql)
  const agents = new AgentStore(sql, () => now)
  agents.create({
    id: FAMILY,
    operator: STREAM_WALLET,
    privyUserId: 'local-fixture',
    name: 'Stream fixture',
    registry: network.identity,
    chainId: network.chainId,
  })
  agents.bindWallet(FAMILY, 'local-fixture-wallet', STREAM_WALLET)
  if (agents.get(FAMILY).state !== 'active') {
    // SAFETY: these are the ordered AgentState transitions for a freshly bound fixture wallet.
    for (const state of ['upgraded', 'grants-live', 'registered', 'active'] as const) agents.advance(FAMILY, state)
  }
  sql.run(
    'INSERT OR REPLACE INTO agent_oauth_families (id,client_id,agent_id,board_id,scopes_json,resource,created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    FAMILY,
    'local-stream-client',
    FAMILY,
    'public',
    '["sidequest:read"]',
    resource,
    now,
  )
  for (const token of [STREAM_TOKEN, APPEND_TOKEN])
    sql.run(
      "INSERT OR REPLACE INTO agent_oauth_tokens (hash,family_id,kind,expires_at) VALUES (?,?,'access',?)",
      await tokenHash(token),
      FAMILY,
      now + 3600,
    )
}

export default Effect.gen(function* () {
  const api = yield* Api
  // Only this test's resource uses the fixture entrypoint; the production stack imports Api directly.
  api.Props = { ...api.Props, main: import.meta.url }
  // SAFETY: Alchemy's Platform merges its runtime context into the returned Worker resource.
  const runtime = api as typeof api & Effect.Success<typeof Cloudflare.Worker>
  const exports = yield* runtime.exports
  // SAFETY: the real API registers Board as its management Durable Object export.
  const board = exports.Board as DurableObjectExport
  yield* runtime.export('Board', {
    ...board,
    constructor: Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState
      const bindings = yield* Cloudflare.WorkerEnvironment
      const original = yield* board.constructor
      let seeded = false
      return original.pipe(
        Effect.map((shape) => {
          // SAFETY: this is the constructor exported by the production Board class.
          const instance = shape as Board
          return {
            ...shape,
            oauthResolve: (request: Parameters<Board['oauthResolve']>[0]) =>
              Effect.gen(function* () {
                if (request.bearer === STREAM_TOKEN || request.bearer === APPEND_TOKEN) {
                  if (!seeded) {
                    const local = fromDurableObjectSql(state.storage.sql.raw, (write) =>
                      state.raw.storage.transactionSync(write),
                    )
                    yield* Effect.promise(() => seed(local, request.resource))
                    seeded = true
                  }
                  if (request.bearer === APPEND_TOKEN)
                    yield* Effect.promise(async () => {
                      // SAFETY: the API binds its real local D1 database here.
                      const sql = fromD1(bindings.Database as never)
                      await migrate(sql)
                      const now = Math.floor(Date.now() / 1000)
                      await writeFeed(
                        sql,
                        'monad-testnet',
                        [
                          {
                            id: crypto.randomUUID(),
                            address: STREAM_WALLET,
                            kind: 'job.overdue',
                            summary: 'Local stream integration',
                            occurredAt: now,
                          },
                        ],
                        now,
                      )
                    })
                }
                return yield* instance.oauthResolve(request)
              }),
          }
        }),
      )
    }),
  })
  return api
})
