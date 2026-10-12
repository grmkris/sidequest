import { expect, it, vi } from 'vitest'
import { context, throttledFetch, type RpcTrace } from './client.ts'

it('batches same-tick reads into multicall3 only when asked', () => {
  // The board asks: a task summary is several concurrent reads and a listing summarises many tasks at once.
  expect(context('monad-testnet', 'main', 'http://127.0.0.1:1', { batch: true }).publicClient.batch).toEqual({
    multicall: true,
  })
  expect(context('monad-testnet', 'main', 'http://127.0.0.1:1').publicClient.batch).toBeUndefined()
  expect(context('monad-testnet', 'main', 'http://127.0.0.1:1').publicClient.chain?.contracts?.multicall3).toBeDefined()
})

it('times rate-limit retries without exposing the request to the observer', async () => {
  vi.useFakeTimers()
  const phases: Array<[string, number]> = []
  const trace: RpcTrace = (phase, attempt, run) => {
    phases.push([phase, attempt])
    return run()
  }
  let calls = 0
  vi.stubGlobal('fetch', async () => new Response(calls++ === 0 ? '{"code":-32011}' : '{"result":"ok"}'))
  try {
    const request = throttledFetch(8, 1)(
      'https://rpc.example/private-key',
      { body: 'private-body', method: 'POST' },
      trace,
    )
    await vi.runAllTimersAsync()
    expect(await (await request).text()).toBe('{"result":"ok"}')
    expect(phases).toEqual([
      ['rpc.attempt', 1],
      ['rpc.backoff', 1],
      ['rpc.attempt', 2],
    ])
    expect(calls).toBe(2)
  } finally {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
})

it('keeps one limiter shared across calls while reporting each caller queue wait', async () => {
  vi.useFakeTimers()
  const times: number[] = []
  const phases: string[] = []
  const trace: RpcTrace = (phase, _attempt, run) => {
    phases.push(phase)
    return run()
  }
  vi.stubGlobal('fetch', async () => {
    times.push(Date.now())
    return Response.json({ result: 'ok' })
  })
  try {
    const read = throttledFetch(8, 0)
    const first = read('https://rpc.example', undefined, trace)
    const second = read('https://rpc.example', undefined, trace)
    await vi.runAllTimersAsync()
    await Promise.all([first, second])
    expect(times[1]! - times[0]!).toBe(125)
    expect(phases.filter((phase) => phase === 'rpc.queue')).toHaveLength(1)
  } finally {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
})
