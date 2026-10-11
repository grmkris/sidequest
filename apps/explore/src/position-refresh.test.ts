import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { refreshAfterPosition, snapshotsReached } from './position-refresh.ts'

/** A client whose one delegation snapshot reports the index's block, advancing by one per read. */
function indexAt(start: bigint) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let block = start
  const reads = { count: 0 }
  const queryFn = async () => {
    reads.count++
    return { blockNumber: block++ }
  }
  return { queryClient, reads, prime: () => queryClient.query({ queryKey: ['delegations', 'v', 'w'], queryFn }) }
}

describe('snapshotsReached', () => {
  it('holds back only on a snapshot below the block', async () => {
    const index = indexAt(5n)
    expect(snapshotsReached(index.queryClient, 9n)).toBe(true)
    await index.prime()
    expect(snapshotsReached(index.queryClient, 5n)).toBe(true)
    expect(snapshotsReached(index.queryClient, 6n)).toBe(false)
  })
})

describe('refreshAfterPosition', () => {
  it('refetches the snapshot until the index reaches the action block', async () => {
    const index = indexAt(10n)
    await index.prime()
    await refreshAfterPosition(index.queryClient, 13n, { waitMs: 0 })
    expect(snapshotsReached(index.queryClient, 13n)).toBe(true)
    expect(index.reads.count).toBe(4)
  })

  it('stops after its tries when the index never catches up', async () => {
    const index = indexAt(1n)
    await index.prime()
    await refreshAfterPosition(index.queryClient, 1_000n, { tries: 3, waitMs: 0 })
    expect(index.reads.count).toBe(4)
    expect(snapshotsReached(index.queryClient, 1_000n)).toBe(false)
  })

  it('invalidates the plain reads the action changed', async () => {
    const index = indexAt(1n)
    index.queryClient.setQueryData(['agent-backing', '0xabc'], { assets: '0' })
    index.queryClient.setQueryData(['balance', { address: '0xabc' }], 0n)
    await refreshAfterPosition(index.queryClient, 0n, { waitMs: 0 })
    expect(index.queryClient.getQueryState(['agent-backing', '0xabc'])?.isInvalidated).toBe(true)
    expect(index.queryClient.getQueryState(['balance', { address: '0xabc' }])?.isInvalidated).toBe(true)
  })
})
