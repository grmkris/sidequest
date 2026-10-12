import { withRpcTracing } from './rpc-observability.ts'
/** Request-local diagnostics. No URLs, arguments, headers or wallet identities enter application spans. */
import * as Effect from 'effect/Effect'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'

/** Correlates a browser response with its Worker span; the duration ends when response headers are ready. */
export const observeRequest = <E, R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const started = performance.now()
    const requestId = crypto.randomUUID()
    yield* Effect.annotateCurrentSpan('request.id', requestId)
    const response = yield* effect.pipe(withRpcTracing)
    yield* Effect.annotateCurrentSpan('http.response.status_code', response.status)
    return response.pipe(
      HttpServerResponse.setHeader('x-request-id', requestId),
      HttpServerResponse.setHeader('server-timing', `api;dur=${(performance.now() - started).toFixed(1)}`),
    )
  }).pipe(Effect.withSpan('api.request'))

/** A FIFO stores only its tail. Each submission captures its own Effect context, including its parent span. */
export function observedQueue(name: 'call' | 'management' | 'relay') {
  let tail: Promise<void> = Promise.resolve()
  return <A>(action: () => Promise<A>): Effect.Effect<A> =>
    Effect.gen(function* () {
      const run = Effect.runPromiseWith(yield* Effect.context())
      return yield* Effect.promise(() => {
        const previous = tail
        const result = run(
          Effect.promise(() => previous).pipe(
            Effect.withSpan('board.queue.wait', { attributes: { queue: name } }),
            Effect.flatMap(() =>
              Effect.promise(action).pipe(
                withRpcTracing,
                Effect.withSpan('board.queue.execute', { attributes: { queue: name } }),
              ),
            ),
          ),
        )
        // A failed item must release the next one, just as the original Promise queue did.
        tail = result.then(
          () => undefined,
          () => undefined,
        )
        return result
      })
    })
}
