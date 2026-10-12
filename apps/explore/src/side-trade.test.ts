import * as sdk from '@sidequest/sdk'
import { describe, expect, it } from 'vitest'
import { emptyJournal, readTxJournalDurable, txJournalKey, writeTxJournalDurable } from './components/txJournal.ts'
import {
  type SideTradeIntent,
  clearSideTrade,
  loadSideTrade,
  saveSideTrade,
  sideTradeKey,
  sideTradeTaskId,
  sideTradeUnstarted,
} from './side-trade.ts'
import type { VaultIntentCheckpoint } from './vault-lock.ts'

const d = sdk.deployment('monad-testnet')
const l = d.launcher!
const owner = '0x1111111111111111111111111111111111111111' as const
const key = sideTradeKey(d.chainId, l.router, owner)
const hash = `0x${'22'.repeat(32)}` as const

// A MON buy is one router call carrying the MON; a sale (sent as a USDC-paid user operation) is approve, then sell.
const buy: SideTradeIntent = {
  id: 'buy-1',
  trade: 'buy',
  owner,
  txs: [{ description: 'Buy SIDE', chainId: d.chainId, to: l.router, data: '0x12345678', value: '10', gas: '900000' }],
  out: '14843',
  deadline: 2_000_000_000,
}
const sell: SideTradeIntent = {
  id: 'sell-1',
  trade: 'sell',
  owner,
  txs: [
    { description: 'Allow', chainId: d.chainId, to: l.side, data: '0x095ea7b3', value: '0', gas: '80000' },
    { description: 'Sell SIDE', chainId: d.chainId, to: l.router, data: '0x87654321', value: '0', gas: '850000' },
  ],
  out: '64',
  deadline: 2_000_000_000,
}
const journalOf = (trade: SideTradeIntent) => txJournalKey(sideTradeTaskId(trade.id), trade.txs)

function store() {
  const local = new Map<string, string>()
  const durable = new Map<string, string | null>()
  return {
    local,
    durable,
    storage: {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, value: string) => {
        local.set(k, value)
      },
      removeItem: (k: string) => {
        local.delete(k)
      },
    },
    checkpoint: {
      read: async (k) => durable.get(k),
      write: async (k, value) => {
        durable.set(k, value)
      },
    } satisfies VaultIntentCheckpoint,
  }
}

describe('a SIDE trade from the sheet survives a reload', () => {
  it('saves a MON buy before its prompt and finds it after a reload, on the same send journal', async () => {
    const s = store()
    await saveSideTrade(s.storage, key, buy, s.checkpoint)
    expect(await readTxJournalDurable(s.storage, journalOf(buy), true, s.checkpoint)).toMatchObject({ pending: null })
    s.local.clear()
    expect(await loadSideTrade(s.storage, key, s.checkpoint)).toEqual(buy)
  })

  it('blocks a second trade after an uncertain MON send, and never lets it be discarded', async () => {
    const s = store()
    await saveSideTrade(s.storage, key, buy, s.checkpoint)
    // The wallet signed and the answer was lost: the journal holds the pending send.
    const uncertain = { ...emptyJournal(), pending: 0, snapshot: { nonce: 3, block: '100' }, from: owner }
    await writeTxJournalDurable(s.storage, journalOf(buy), uncertain, s.checkpoint)
    const reloaded = (await loadSideTrade(s.storage, key, s.checkpoint))!
    expect(reloaded.id).toBe(buy.id)
    expect(await sideTradeUnstarted(s.storage, reloaded, s.checkpoint)).toBe(false)
    await expect(saveSideTrade(s.storage, key, sell, s.checkpoint)).rejects.toThrow('unfinished')
    expect(await clearSideTrade(s.storage, key, sell.id, s.checkpoint)).toBe(false)
    expect((await loadSideTrade(s.storage, key, s.checkpoint))?.id).toBe(buy.id)
  })

  it('counts a USDC sale with a built user operation as sent', async () => {
    const s = store()
    await saveSideTrade(s.storage, key, sell, s.checkpoint)
    const quantity = '0x1' as const
    const built = {
      op: {
        sender: owner,
        nonce: quantity,
        callData: '0xabcd',
        callGasLimit: quantity,
        verificationGasLimit: quantity,
        preVerificationGas: quantity,
        maxFeePerGas: quantity,
        maxPriorityFeePerGas: quantity,
        signature: '0x1234',
      },
      entryPoint: owner,
      chainId: d.chainId,
      maxCost: '4739',
      userOpHash: hash,
    } as const
    await writeTxJournalDurable(
      s.storage,
      journalOf(sell),
      { ...emptyJournal(), aa: { actionId: 'sell-1', built, submittedAt: 1 } },
      s.checkpoint,
    )
    expect(await sideTradeUnstarted(s.storage, sell, s.checkpoint)).toBe(false)
    await expect(saveSideTrade(s.storage, key, buy, s.checkpoint)).rejects.toThrow('unfinished')
  })

  it('clears only its own trade once terminal, leaves a tombstone, then allows the next', async () => {
    const s = store()
    await saveSideTrade(s.storage, key, buy, s.checkpoint)
    expect(await sideTradeUnstarted(s.storage, buy, s.checkpoint)).toBe(true)
    expect(await clearSideTrade(s.storage, key, buy.id, s.checkpoint)).toBe(true)
    expect(s.durable.get(key)).toBeNull()
    expect(await loadSideTrade(s.storage, key, s.checkpoint)).toBeNull()
    await saveSideTrade(s.storage, key, sell, s.checkpoint)
    expect((await loadSideTrade(s.storage, key, s.checkpoint))?.id).toBe(sell.id)
  })

  it('refuses a local copy without its durable record, and an unreadable one', async () => {
    const s = store()
    s.local.set(key, JSON.stringify(buy))
    await expect(loadSideTrade(s.storage, key, s.checkpoint)).rejects.toThrow('no durable record')
    s.local.clear()
    s.durable.set(key, JSON.stringify({ ...buy, txs: [] }))
    await expect(loadSideTrade(s.storage, key, s.checkpoint)).rejects.toThrow('unreadable')
  })
})
