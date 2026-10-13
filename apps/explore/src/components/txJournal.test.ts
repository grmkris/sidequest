import { describe, expect, it, vi } from 'vitest'
import {
  emptyJournal,
  initializeTxJournalDurable,
  journalAttempted,
  readTxJournal,
  readTxJournalDurable,
  txJournalKey,
  writeTxJournal,
  writeTxJournalDurable,
  type JournalStorage,
} from './txJournal.ts'
import type { VaultIntentCheckpoint } from '../vault-lock.ts'

const tx = {
  description: 'Top up',
  to: '0x1111111111111111111111111111111111111111' as const,
  data: '0x1234' as const,
  value: '0' as const,
  chainId: 10143,
}
const fixture = () => {
  const values = new Map<string, string>()
  const storage: JournalStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
  return { values, storage }
}
describe('durable wallet transaction journal', () => {
  it('rereads pending and hash checkpoints despite a second renderer retaining a valid empty journal', async () => {
    const first = fixture(),
      second = fixture(),
      key = txJournalKey('delegation:shared', [tx])
    const values = new Map<string, string | null>()
    const checkpoint: VaultIntentCheckpoint = {
      read: async (storeKey) => values.get(storeKey),
      write: async (storeKey, raw) => {
        values.set(storeKey, raw)
      },
    }
    writeTxJournal(second.storage, key, emptyJournal())
    const pending = { ...emptyJournal(), pending: 0, snapshot: { nonce: 7, block: '100' }, from: tx.to }
    await writeTxJournalDurable(first.storage, key, pending, checkpoint)
    expect(readTxJournal(second.storage, key, true)).toEqual(emptyJournal())
    expect(await readTxJournalDurable(second.storage, key, true, checkpoint)).toEqual(pending)
    const sent = { ...pending, pending: null, snapshot: null, hashes: [`0x${'ab'.repeat(32)}` as const] }
    await writeTxJournalDurable(first.storage, key, sent, checkpoint)
    expect(readTxJournal(second.storage, key, true)).toEqual(emptyJournal())
    expect(await readTxJournalDurable(second.storage, key, true, checkpoint)).toEqual(sent)
    expect(readTxJournal(second.storage, key, true)).toEqual(emptyJournal())
  })
  it('a rejected pending write exposes nothing; a rejected hash write retains pending for the stale renderer', async () => {
    const first = fixture(),
      stale = fixture(),
      key = txJournalKey('delegation:shared', [tx])
    writeTxJournal(first.storage, key, emptyJournal())
    writeTxJournal(stale.storage, key, emptyJournal())
    const values = new Map<string, string | null>()
    let rejectWrite = true
    const checkpoint: VaultIntentCheckpoint = {
      read: async (storeKey) => values.get(storeKey),
      write: async (storeKey, raw) => {
        if (rejectWrite) throw new Error('checkpoint aborted')
        values.set(storeKey, raw)
      },
    }
    const pending = { ...emptyJournal(), pending: 0, snapshot: { nonce: 7, block: '100' }, from: tx.to }
    await expect(writeTxJournalDurable(first.storage, key, pending, checkpoint)).rejects.toThrow('checkpoint aborted')
    expect(readTxJournal(first.storage, key, true)).toEqual(emptyJournal())
    rejectWrite = false
    await writeTxJournalDurable(first.storage, key, pending, checkpoint)
    rejectWrite = true
    await expect(
      writeTxJournalDurable(
        first.storage,
        key,
        { ...pending, pending: null, hashes: [`0x${'ab'.repeat(32)}`] },
        checkpoint,
      ),
    ).rejects.toThrow('checkpoint aborted')
    expect(await readTxJournalDurable(stale.storage, key, true, checkpoint)).toEqual(pending)
  })
  it('treats a local journal without its checkpoint, or a committed missing one, as unknown rather than idle', async () => {
    const { storage } = fixture(),
      key = txJournalKey('delegation:1', [tx])
    const values = new Map<string, string | null>()
    const checkpoint: VaultIntentCheckpoint = {
      read: async (storeKey) => values.get(storeKey),
      write: async (storeKey, raw) => {
        values.set(storeKey, raw)
      },
    }
    expect(await readTxJournalDurable(storage, key, false, checkpoint)).toBeNull()
    writeTxJournal(storage, key, { ...emptyJournal(), hashes: [`0x${'ab'.repeat(32)}` as const] })
    await expect(readTxJournalDurable(storage, key, false, checkpoint)).rejects.toThrow(/no durable record.*unknown/)
    expect(values.size).toBe(0)
    await writeTxJournalDurable(storage, key, null, checkpoint)
    writeTxJournal(storage, key, emptyJournal())
    await expect(readTxJournalDurable(storage, key, true, checkpoint)).rejects.toThrow(/missing.*unknown/)
  })
  it('refuses the wallet call when the pending record cannot be durably written', () => {
    const { storage } = fixture(),
      send = vi.fn()
    const key = txJournalKey('approval:1', [tx])
    writeTxJournal(storage, key, emptyJournal())
    const full = {
      ...storage,
      setItem: () => {
        throw new Error('quota exceeded')
      },
    }
    const sendAfterPersistence = () => {
      writeTxJournal(full, key, { ...emptyJournal(), pending: 0 })
      send()
    }
    expect(sendAfterPersistence).toThrow(/could not be saved/)
    expect(send).not.toHaveBeenCalled()
    expect(readTxJournal(storage, key, true)?.pending).toBeNull()
    expect(() => writeTxJournal({ ...storage, setItem: () => {} }, key, { ...emptyJournal(), pending: 0 })).toThrow(
      /could not be saved/,
    )
  })
  it('treats a missing, unreadable or corrupt saved journal as unknown rather than idle', () => {
    const { storage, values } = fixture(),
      key = txJournalKey('approval:1', [tx])
    expect(readTxJournal(storage, key)).toBeNull()
    expect(() => readTxJournal(storage, key, true)).toThrow(/missing.*unknown/)
    expect(() =>
      readTxJournal(
        {
          ...storage,
          getItem: () => {
            throw new Error('unavailable')
          },
        },
        key,
      ),
    ).toThrow(/unreadable.*unknown/)
    // A pending step is always saved with the snapshot and sender it is reconciled against.
    for (const raw of [
      '{',
      'null',
      '{}',
      JSON.stringify({ ...emptyJournal(), hashes: ['not-a-hash'] }),
      JSON.stringify({ ...emptyJournal(), pending: 0 }),
      JSON.stringify({ ...emptyJournal(), pending: 0, snapshot: { nonce: 7, block: '100' } }),
    ]) {
      values.set(key, raw)
      expect(() => readTxJournal(storage, key, true)).toThrow(/corrupt.*unknown/)
    }
  })
  it('never replaces a pending or broadcast journal while initializing an outer approval', async () => {
    const { storage } = fixture(),
      key = txJournalKey('approval:1', [tx])
    const values = new Map<string, string | null>()
    const checkpoint: VaultIntentCheckpoint = {
      read: async (storeKey) => values.get(storeKey),
      write: async (storeKey, raw) => {
        values.set(storeKey, raw)
      },
    }
    const pending = { ...emptyJournal(), pending: 0, snapshot: { nonce: 7, block: '100' }, from: tx.to }
    await writeTxJournalDurable(storage, key, pending, checkpoint)
    await initializeTxJournalDurable(storage, 'approval:1', [tx], checkpoint)
    expect(await readTxJournalDurable(storage, key, true, checkpoint)).toEqual(pending)
  })
  it('retains no-effect receipts across reload and refuses corrupt failure history', () => {
    const { storage, values } = fixture(),
      key = txJournalKey('delegation:1', [tx])
    const hash = `0x${'ab'.repeat(32)}` as const
    const record = {
      ...emptyJournal(),
      hashes: [null],
      recorded: [false],
      effectFailures: [{ index: 0, hash, error: 'Not delegated' }],
    }
    writeTxJournal(storage, key, record)
    expect(readTxJournal(storage, key, true)).toEqual(record)
    for (const failure of [
      null,
      { index: -1, hash, error: 'Not delegated' },
      { index: 0, hash: 'invalid', error: 'Not delegated' },
      { index: 0, hash },
    ]) {
      values.set(key, JSON.stringify({ ...record, effectFailures: [failure] }))
      expect(() => readTxJournal(storage, key, true)).toThrow(/corrupt.*unknown/)
    }
  })
})

describe('a journal saved before its first prompt', () => {
  it('counts as untried until anything is attempted under it, so a fresh trade still opens the wallet at once', () => {
    // A SIDE trade saves its journal before the wallet opens: Buy, then Privy, not Buy, Confirm, then Privy.
    expect(journalAttempted(emptyJournal())).toBe(false)
    expect(journalAttempted({ ...emptyJournal(), attempts: [7] })).toBe(true)
    expect(journalAttempted({ ...emptyJournal(), pending: 0 })).toBe(true)
    expect(journalAttempted({ ...emptyJournal(), hashes: [`0x${'1'.repeat(64)}`] })).toBe(true)
    expect(journalAttempted({ ...emptyJournal(), hashes: [null], reverted: [`0x${'2'.repeat(64)}`] })).toBe(true)
    expect(journalAttempted({ ...emptyJournal(), sponsored: true })).toBe(true)
  })
})
