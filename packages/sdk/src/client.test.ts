import { expect, it } from 'vitest'
import { context } from './client.ts'

it('batches same-tick reads into multicall3 only when asked', () => {
  // The board asks: a task summary is several concurrent reads and a listing summarises many tasks at once.
  expect(context('monad-testnet', 'main', 'http://127.0.0.1:1', { batch: true }).publicClient.batch).toEqual({
    multicall: true,
  })
  expect(context('monad-testnet', 'main', 'http://127.0.0.1:1').publicClient.batch).toBeUndefined()
  expect(context('monad-testnet', 'main', 'http://127.0.0.1:1').publicClient.chain?.contracts?.multicall3).toBeDefined()
})
