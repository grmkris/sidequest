import { expect, it } from 'vitest'
import * as Effect from 'effect/Effect'
import * as Tracer from 'effect/Tracer'
import * as Option from 'effect/Option'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { observedQueue, observeRequest } from '../src/observability.ts'

it('keeps queued calls FIFO, releases failures and retains each request parent', async () => {
  const queue = observedQueue('call')
  const base = Effect.runSync(Effect.tracer)
  const parents: string[] = []
  const tracer = Tracer.make({
    context: base.context,
    span: (options) => {
      const parent = Option.getOrUndefined(options.parent)
      if (options.name === 'board.queue.execute') parents.push(parent?._tag === 'Span' ? parent.name : '')
      return base.span(options)
    },
  })
  const { promise: gate, resolve: release } = Promise.withResolvers<void>()
  const order: string[] = []
  const first = Effect.runPromise(
    queue(async () => {
      order.push('first')
      await gate
      throw new Error('test failure')
    }).pipe(Effect.withSpan('request-one'), Effect.withTracer(tracer), Effect.exit),
  )
  const second = Effect.runPromise(
    queue(async () => {
      order.push('second')
      return 2
    }).pipe(Effect.withSpan('request-two'), Effect.withTracer(tracer)),
  )
  await Promise.resolve()
  expect(order).not.toContain('second')
  release()
  await first
  expect(await second).toBe(2)
  expect(order).toEqual(['first', 'second'])
  expect(parents).toEqual(['request-one', 'request-two'])
})

const read = () =>
  Effect.runPromise(
    observeRequest(
      Effect.succeed(
        HttpServerResponse.text('ready', {
          status: 202,
          headers: { 'cache-control': 'no-store' },
        }),
      ),
    ),
  )
it('adds independent request IDs and a bounded timing value without altering the response', async () => {
  const [a, b] = await Promise.all([read(), read()])
  expect(a.status).toBe(202)
  expect(a.headers['cache-control']).toBe('no-store')
  expect(a.headers['server-timing']).toMatch(/^api;dur=\d+\.\d$/)
  expect(a.headers['x-request-id']).toMatch(/^[a-f\d-]{36}$/)
  expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id'])
})
