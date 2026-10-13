import { describe, expect, it, vi } from 'vitest'
import {
  LOCK_WAIT_NOTICE_MS,
  guardedSnapshot,
  reconcileSend,
  retryAction,
  walletRefused,
  walletStepRequest,
  withWalletStepLock,
  withWalletAccountLock,
  type StepLocks,
} from './txOperation.ts'

const hash = `0x${'1'.repeat(64)}` as const

describe('wallet step retry reconciliation', () => {
  it('coordinates different operations for the same account before snapshotting and passes the captured nonce to the wallet', async () => {
    const queues = new Map<string, Promise<void>>()
    const locks: StepLocks = {
      request: async (name, fn) => {
        const previous = queues.get(name) ?? Promise.resolve()
        let release!: () => void
        queues.set(
          name,
          new Promise<void>((resolve) => {
            release = resolve
          }),
        )
        await previous
        try {
          return await fn()
        } finally {
          release()
        }
      },
    }
    const owner = '0xa111111111111111111111111111111111111111'
    let nextNonce = 7
    const requests: number[] = []
    const reads = { nonce: async () => nextNonce, blockNumber: async () => 100n }
    const tab = (key: string, account: `0x${string}`) =>
      withWalletStepLock(locks, key, () =>
        withWalletAccountLock(locks, 10143, account, async () => {
          const snapshot = await guardedSnapshot(reads)
          const request = walletStepRequest(
            { description: 'Fund', chainId: 10143, to: owner, data: '0x', value: '500' },
            account,
            10143,
            snapshot.nonce,
          )
          await Promise.resolve()
          requests.push(request.nonce!)
          nextNonce++
        }),
      )
    await Promise.all([tab('first-job', owner), tab('second-job', `0x${owner.slice(2).toUpperCase()}`)])
    expect(requests).toEqual([7, 8])
  })
  it('serializes stale tabs and rereads the shared pending/hash journal before a second prompt', async () => {
    let queue = Promise.resolve()
    const locks: StepLocks = {
      request: async (_name, fn) => {
        const previous = queue
        let release!: () => void
        queue = new Promise<void>((resolve) => {
          release = resolve
        })
        await previous
        try {
          return await fn()
        } finally {
          release()
        }
      },
    }
    let journal: 'idle' | 'pending' | 'sent' = 'idle'
    let prompts = 0
    const staleTab = () =>
      withWalletStepLock(locks, 'same-operation', async () => {
        // The read happens inside the lock, not at component mount.
        if (journal !== 'idle') return
        journal = 'pending'
        prompts++
        await Promise.resolve()
        journal = 'sent'
      })
    await Promise.all([staleTab(), staleTab()])
    expect(prompts).toBe(1)
    expect(journal).toBe('sent')
    await expect(withWalletStepLock(undefined, 'same-operation', staleTab)).rejects.toThrow(/Web Locks/)
    expect(prompts).toBe(1)
  })
  it('says so once another tab has held the step for a while, and stays quiet when the lock is free', async () => {
    vi.useFakeTimers()
    try {
      let release!: () => void
      const other = new Promise<void>((resolve) => {
        release = resolve
      })
      let held: Promise<void> = Promise.resolve()
      const locks: StepLocks = {
        request: async (_name, fn) => {
          await held
          return fn()
        },
      }
      const waits: string[] = []
      expect(
        await withWalletStepLock(
          locks,
          'free',
          async () => 'ran',
          () => waits.push('free'),
        ),
      ).toBe('ran')
      // An older tab still has the step: a wallet prompt left open, or a hidden tab's throttled receipt wait.
      held = other
      const blocked = withWalletStepLock(
        locks,
        'held',
        async () => 'ran',
        () => waits.push('held'),
      )
      await vi.advanceTimersByTimeAsync(LOCK_WAIT_NOTICE_MS)
      expect(waits).toEqual(['held'])
      release()
      expect(await blocked).toBe('ran')
      await vi.advanceTimersByTimeAsync(LOCK_WAIT_NOTICE_MS)
      expect(waits).toEqual(['held'])
    } finally {
      vi.useRealTimers()
    }
  })
  it('refuses unsent approval steps after expiry, including expiry during chain reads', async () => {
    let now = 99
    let readCount = 0
    const guard = () => (now >= 100 ? 'The operation expired.' : null)
    const reads = {
      nonce: async () => {
        readCount++
        return 5
      },
      blockNumber: async () => 10n,
    }
    expect(await guardedSnapshot(reads, guard)).toEqual({ nonce: 5, block: '10' })
    now = 100
    await expect(guardedSnapshot(reads, guard)).rejects.toThrow(/expired/)
    expect(readCount).toBe(1)
    now = 99
    await expect(
      guardedSnapshot(
        {
          ...reads,
          blockNumber: async () => {
            now = 100
            return 10n
          },
        },
        guard,
      ),
    ).rejects.toThrow(/expired/)
    // Reconciliation does not depend on approval freshness.
    expect(retryAction({ at: 'failed', error: 'Expired after broadcast', hash })).toBe('receipt')
  })
  it('never resends a transaction after a receipt timeout', () => {
    expect(retryAction({ at: 'failed', error: 'RPC unavailable', hash })).toBe('receipt')
  })
  it('only records a confirmed transaction when the board report failed', () => {
    expect(retryAction({ at: 'confirmed', hash, reportError: 'Board unavailable' })).toBe('report')
  })
  it('permits a new send only without a hash or after a proved revert', () => {
    expect(retryAction({ at: 'idle' })).toBe('send')
    expect(retryAction({ at: 'failed', error: 'Wallet declined' })).toBe('send')
    expect(retryAction({ at: 'failed', error: 'Reverted', hash, reverted: true })).toBe('send')
    expect(retryAction({ at: 'failed', error: 'Proved no requested effect', hash, noEffect: true })).toBe('send')
  })
  it('does not act on pending or completed steps', () => {
    expect(retryAction({ at: 'signing' })).toBe('wait')
    expect(retryAction({ at: 'sent', hash })).toBe('wait')
    expect(retryAction({ at: 'confirmed', hash })).toBe('wait')
    expect(retryAction({ at: 'recorded', hash })).toBe('wait')
    expect(retryAction({ at: 'uncertain', error: 'Transport failed after broadcast' })).toBe('wait')
  })
  it('only clears uncertainty after a definitive wallet refusal', () => {
    expect(walletRefused({ cause: { code: 4001 } })).toBe(true)
    expect(walletRefused({ code: 'ACTION_REJECTED' })).toBe(true)
    expect(walletRefused(new Error('Transport failed after broadcast'))).toBe(false)
    expect(walletRefused(new Error('Request cancelled after submission'))).toBe(false)
    expect(walletRefused({ cause: new Error('The user rejected the request') })).toBe(true)
    expect(walletRefused(new Error('The user rejected the request after it was sent'))).toBe(false)
  })
})

describe('ambiguous send reconciliation', () => {
  const owner = '0x1111111111111111111111111111111111111111'
  const call = { to: '0x2222222222222222222222222222222222222222', data: '0xabcdef' as const }
  const tx = (n: number, input: `0x${string}`, from = owner, to = call.to) => ({
    hash: `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`,
    from,
    to,
    input,
    nonce: n,
  })
  /** A chain whose block 100 + k holds the listed transactions; reads fail when `down`. */
  const chain = (opts: {
    mined: number
    pending?: number
    blocks?: Record<number, ReturnType<typeof tx>[]>
    head?: number
    down?: boolean
  }) => {
    const reads = { blocks: 0 }
    return {
      reads,
      chain: {
        nonce: async (tag: 'latest' | 'pending') => {
          if (opts.down === true) throw new Error('RPC unavailable')
          return tag === 'latest' ? opts.mined : (opts.pending ?? opts.mined)
        },
        blockNumber: async () => BigInt(opts.head ?? 110),
        block: async (n: bigint) => {
          reads.blocks++
          return { transactions: opts.blocks?.[Number(n)] ?? [] }
        },
      },
    }
  }
  const snapshot = { nonce: 5, block: '100' }

  it('says nothing went out when the nonce has not moved and nothing is pending', async () => {
    const { chain: c, reads } = chain({ mined: 5 })
    expect(await reconcileSend(c, snapshot, owner, call)).toEqual({ at: 'not-sent' })
    expect(reads.blocks).toBe(0)
  })
  it('waits while the account has a transaction in the mempool', async () => {
    expect(await reconcileSend(chain({ mined: 5, pending: 6 }).chain, snapshot, owner, call)).toEqual({ at: 'pending' })
  })
  it('finds the mined transaction that carries this exact call', async () => {
    const { chain: c, reads } = chain({
      mined: 6,
      blocks: { 102: [tx(9, '0xabcdef', '0x3333333333333333333333333333333333333333'), tx(5, '0xABCDEF')] },
    })
    expect(await reconcileSend(c, snapshot, owner, call)).toEqual({ at: 'found', hash: tx(5, '0x').hash })
    expect(reads.blocks).toBe(3)
  })
  it('does not recover another operation with identical calldata at a different nonce', async () => {
    const other = chain({ mined: 7, blocks: { 101: [tx(5, '0x1234'), tx(6, call.data)] } })
    expect(await reconcileSend(other.chain, snapshot, owner, { ...call, nonce: 5 })).toEqual({ at: 'not-sent' })
    const original = chain({ mined: 7, blocks: { 101: [tx(5, call.data), tx(6, call.data)] } })
    expect(await reconcileSend(original.chain, snapshot, owner, { ...call, nonce: 5 })).toEqual({
      at: 'found',
      hash: tx(5, '0x').hash,
    })
  })
  it('distinguishes two native transfers to the same recipient by their reviewed amount', async () => {
    const native = { ...call, data: '0x' as const, value: 500n }
    const wrong = { ...tx(5, '0x'), value: 499n },
      right = { ...tx(6, '0x'), value: 500n }
    expect(await reconcileSend(chain({ mined: 6, blocks: { 101: [wrong] } }).chain, snapshot, owner, native)).toEqual({
      at: 'not-sent',
    })
    expect(
      await reconcileSend(chain({ mined: 7, blocks: { 101: [wrong], 102: [right] } }).chain, snapshot, owner, native),
    ).toEqual({ at: 'found', hash: right.hash })
    const request = {
      description: 'Fund worker',
      chainId: 10143,
      to: call.to as `0x${string}`,
      data: '0x' as const,
      value: '500',
    }
    expect(walletStepRequest(request, owner, 10143)).toMatchObject({ value: 500n })
    expect(() => walletStepRequest(request, owner, 143)).toThrow(/network/)
  })
  it('allows a resend when the nonce moved for another call of this account', async () => {
    const { chain: c, reads } = chain({ mined: 6, blocks: { 101: [tx(5, '0x1234')] } })
    expect(await reconcileSend(c, snapshot, owner, call)).toEqual({ at: 'not-sent' })
    expect(reads.blocks).toBe(2)
  })
  it('finds a send confirmed long after the snapshot by bisecting the nonce, reading a handful of blocks', async () => {
    // 13 Oct: the buy was confirmed a minute after its snapshot, hundreds of Monad blocks later.
    const landed = 100 + 900
    const { chain: c, reads } = chain({ mined: 6, head: 1_200, blocks: { [landed]: [tx(5, call.data)] } })
    let nonceReads = 0
    const bisected = {
      ...c,
      nonceAt: async (block: bigint) => {
        nonceReads++
        return block >= BigInt(landed) ? 6 : 5
      },
    }
    expect(await reconcileSend(bisected, snapshot, owner, call)).toEqual({ at: 'found', hash: tx(5, '0x').hash })
    expect(nonceReads).toBeLessThanOrEqual(11)
    expect(reads.blocks).toBeLessThanOrEqual(4)
    // Without the bisection read, the same send is past the block limit and stays unknown.
    expect(await reconcileSend(c, snapshot, owner, call)).toEqual({ at: 'unknown' })
  })
  it('does not guess when the chain cannot answer or the blocks run past the limit', async () => {
    expect(await reconcileSend(chain({ mined: 5, down: true }).chain, snapshot, owner, call)).toEqual({ at: 'unknown' })
    expect(await reconcileSend(chain({ mined: 6, head: 400 }).chain, snapshot, owner, call, 50)).toEqual({
      at: 'unknown',
    })
  })
})
