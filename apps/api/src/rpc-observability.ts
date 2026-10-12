/** Cached SDK clients look up the current invocation, never the request that originally constructed the client. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { RpcTrace } from '@sidequest/sdk'
import * as Effect from 'effect/Effect'

const current = new AsyncLocalStorage<RpcTrace>()

export const traceRpc: RpcTrace = (phase, attempt, action) => {
  const trace = current.getStore()
  return trace === undefined ? action() : trace(phase, attempt, action)
}

export const withRpcTracing = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>()
    const run = Effect.runPromiseWith(context)
    const trace: RpcTrace = (phase, attempt, action) =>
      run(Effect.promise(action).pipe(Effect.withSpan(phase, { attributes: { 'rpc.attempt': attempt } })))
    const result = yield* Effect.promise(() => current.run(trace, () => Effect.runPromiseExitWith(context)(effect)))
    return yield* result
  })
