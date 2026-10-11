import { BoardError, fromDurableObjectSql, type Caller, type DisputeThreadEntry } from '@sidequest/board'
import { fromD1 } from '@sidequest/indexer'
import * as sdk from '@sidequest/sdk'
import {
  Caches,
  MAINNET_MINIMUMS,
  Minimums,
  RolesConfig,
  TESTNET_MINIMUMS,
  Address,
  Subject,
  getDisputeThread,
  migrate,
  sqlLayer,
  toolSpecs,
  errorCode,
  type CommonsError,
  type ToolRunner,
} from '@sidequest/commons'
import { Effect, Layer, ManagedRuntime, Schema } from 'effect'
import type { BoardCall } from '../board.ts'
import { stageProfile } from '../../../../infra/stage.ts'
import { directoryLayer, type DirectoryNamespace } from './directory-live.ts'
import { feedLayer } from './feed-live.ts'
import { participantsLayer, type ParticipantsNamespace } from './participants.ts'
import { stakeLayer } from './stake-live.ts'

export interface CommonsState {
  readonly storage: { readonly sql: { readonly raw: Parameters<typeof fromDurableObjectSql>[0] } }
  readonly raw: { readonly storage: { transactionSync<A>(f: () => A): A } }
}
export interface CommonsBindings {
  readonly Database: Parameters<typeof fromD1>[0]
  readonly Board: DirectoryNamespace & ParticipantsNamespace
  readonly DEPLOY_STAGE?: string
}
export interface CommonsHost {
  run(name: string, caller: Caller, args: Record<string, unknown>): Promise<Record<string, unknown>>
  thread(subject: string): readonly DisputeThreadEntry[]
}

const ObjectOutput = Schema.Record(Schema.String, Schema.Unknown)
const normalized = (addresses: readonly string[]) =>
  addresses.map((address) => Schema.decodeUnknownSync(Address)(address))
const executeSpec = <I, O>(
  spec: { input: Schema.Codec<I, unknown>; output: Schema.Codec<O, unknown>; run: ToolRunner<I, O> },
  caller: Caller,
  args: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const address = caller.address === undefined ? undefined : Schema.decodeUnknownSync(Address)(caller.address)
    const input = yield* Schema.decodeUnknownEffect(spec.input)(args).pipe(
      Effect.mapError(() => new BoardError('invalid', 'Invalid Commons tool input')),
    )
    const output = yield* spec
      .run(address, input)
      .pipe(Effect.mapError((error: CommonsError) => new BoardError(errorCode(error), error.message)))
    const encoded = yield* Schema.encodeEffect(spec.output)(output).pipe(Effect.orDie)
    return Schema.decodeUnknownSync(ObjectOutput)(encoded)
  })

export function commonsHostFactory(input: { state: CommonsState; bindings: CommonsBindings }) {
  const { state, bindings } = input
  const transaction = <A>(f: () => A) => state.raw.storage.transactionSync(f)
  const sql = fromDurableObjectSql(state.storage.sql.raw, transaction)
  let migrated = false
  const hosts = new Map<string, CommonsHost>()
  return (env: BoardCall['env']): CommonsHost => {
    const key = JSON.stringify([env.network, env.rpcUrl, env.uri, bindings.DEPLOY_STAGE])
    const cached = hosts.get(key)
    if (cached !== undefined) return cached
    const roles = stageProfile(bindings.DEPLOY_STAGE)?.roles
    const config = sdk.deployment(env.network)
    const roleConfig = {
      enabled: roles !== undefined,
      moderator: normalized(roles?.moderator ?? []),
      maintainer: normalized(roles?.maintainer ?? []),
      arbiter: normalized([config.arbitrator]),
    }
    if (!migrated) {
      transaction(() => migrate(sql, roleConfig.maintainer[0] ?? config.arbitrator, Math.floor(Date.now() / 1000)))
      migrated = true
    }
    const ctx = sdk.context(env.network, 'main', env.rpcUrl)
    const d1 = fromD1(bindings.Database)
    const base = Layer.mergeAll(
      sqlLayer(sql, transaction),
      Layer.succeed(RolesConfig, roleConfig),
      Layer.succeed(Minimums, env.network === 'monad-mainnet' ? MAINNET_MINIMUMS : TESTNET_MINIMUMS),
    )
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        base,
        Caches.layer,
        stakeLayer(d1, ctx),
        directoryLayer(d1, bindings.Board, ctx, env.uri),
        participantsLayer(d1, bindings.Board, env),
        feedLayer(d1, env.network),
      ),
    )
    const host: CommonsHost = {
      run: async (name, caller, args) => {
        if (!roleConfig.enabled) {
          if (name === 'list_roles')
            return { enabled: false, roles: [], log: [], cursor: null, hasMore: false, viewer: null }
          throw new BoardError('unavailable', 'Commons is disabled in this stage')
        }
        const spec = Object.entries(toolSpecs).find(([tool]) => tool === name)?.[1]
        if (spec === undefined) throw new BoardError('not-found', 'Unknown Commons tool')
        // SAFETY: the registry pairs each input/output codec with the runner accepting exactly that decoded input.
        return runtime.runPromise(
          executeSpec(
            spec as {
              input: Schema.Codec<unknown, unknown>
              output: Schema.Codec<unknown, unknown>
              run: ToolRunner<unknown, unknown>
            },
            caller,
            args,
          ),
        )
      },
      thread: (raw) => {
        const subject = Schema.decodeUnknownSync(Subject)(raw)
        const [kind, boardId, taskId] = subject.split(':')
        if (kind !== 'job' || !roleConfig.enabled) return []
        return runtime.runSync(getDisputeThread(boardId!, taskId!)).map((message) => ({
          id: message.id,
          // SAFETY: persisted authors are validated by the Commons Address input and output codecs.
          author: message.author as `0x${string}`,
          roles: message.badges.map((badge) => badge.kind),
          text: message.body,
          hidden: message.hidden !== null,
          replyTo: message.replyTo,
          at: message.createdAt,
        }))
      },
    }
    hosts.set(key, host)
    return host
  }
}
