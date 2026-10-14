/**
 * A SIDE trade from the SIDE sheet, saved before any wallet prompt (hard rule 9). Its id gives the send journal a stable
 * key, so a reload or a crash after an uncertain send finds the same journal, reconciles it, and starts no second trade
 * in a new nonce lane. The protocol is posting-funding's: journal first, then the cross-renderer checkpoint, then the
 * localStorage copy, all under one lock per wallet.
 */
import { Schema } from 'effect'
import {
  type JournalStorage,
  type OpRecord,
  initializeTxJournalDurable,
  readTxJournal,
  readTxJournalDurable,
  txJournalKey,
} from './components/txJournal.ts'
import type { WalletStep } from './components/txOperation.ts'
import { browserVaultIntentCheckpoint, type VaultIntentCheckpoint } from './vault-lock.ts'

export interface SideTradeIntent {
  id: string
  trade: 'buy' | 'sell'
  owner: `0x${string}`
  txs: WalletStep[]
  /** What the trade was quoted to return, in base units: SIDE for a buy, MON (USDC when `payWith`) for a sale. */
  out: string
  /** The router's deadline, in seconds: after it, an unsent trade can only revert. */
  deadline: number
  /** Paid or paid out in USDC through the MON/USDC pool, as one batch (absent: MON, and every trade saved before). */
  payWith?: 'usdc'
  /** On a USDC buy, the most USDC it may spend, in base units. */
  paid?: string
}

/** One saved trade per wallet, router and network: a second trade waits until the first is terminal. */
export const sideTradeKey = (chainId: number, router: string, owner: string) =>
  `sidequest.side-trade:${chainId}:${router.toLowerCase()}:${owner.toLowerCase()}`

/** The send journal's task id: stable for the trade, never a fresh timestamp. */
export const sideTradeTaskId = (id: string) => `side-trade:${id}`

const UNKNOWN =
  'A saved SIDE trade has no durable record, so its outcome is unknown. Check your wallet’s activity first.'
const UNREADABLE = 'The saved SIDE trade is unreadable. Check your wallet’s activity before trading again.'

/** The saved trade, or null; a local copy without its durable record, or an unreadable one, refuses. */
export async function loadSideTrade(
  storage: JournalStorage,
  key: string,
  checkpoint: VaultIntentCheckpoint = browserVaultIntentCheckpoint,
): Promise<SideTradeIntent | null> {
  const bytes = await checkpoint.read(key)
  if (bytes === undefined || bytes === null) {
    if (storage.getItem(key) !== null) throw new Error(UNKNOWN)
    return null
  }
  const saved: unknown = JSON.parse(bytes)
  if (!isSideTrade(saved)) throw new Error(UNREADABLE)
  await readTxJournalDurable(storage, txJournalKey(sideTradeTaskId(saved.id), saved.txs), true, checkpoint)
  return saved
}

/** Save a trade before its first prompt; refused while another is saved for this wallet. */
export async function saveSideTrade(
  storage: JournalStorage,
  key: string,
  trade: SideTradeIntent,
  checkpoint: VaultIntentCheckpoint = browserVaultIntentCheckpoint,
): Promise<void> {
  const current = await checkpoint.read(key)
  if ((current !== undefined && current !== null) || storage.getItem(key) !== null)
    throw new Error('An earlier SIDE trade is unfinished. Finish or check it before starting another.')
  await initializeTxJournalDurable(storage, sideTradeTaskId(trade.id), trade.txs, checkpoint)
  const bytes = JSON.stringify(trade)
  await checkpoint.write(key, bytes)
  storage.setItem(key, bytes)
  if (storage.getItem(key) !== bytes) throw new Error('The trade could not be saved. Nothing was sent.')
}

/** Clear this trade once it is terminal, and only this one: a committed tombstone first, so no stale tab revives it. */
export async function clearSideTrade(
  storage: JournalStorage,
  key: string,
  id: string,
  checkpoint: VaultIntentCheckpoint = browserVaultIntentCheckpoint,
): Promise<boolean> {
  const bytes = await checkpoint.read(key)
  if (bytes !== undefined && bytes !== null) {
    const saved: unknown = JSON.parse(bytes)
    if (!isSideTrade(saved) || saved.id !== id) return false
  }
  await checkpoint.write(key, null)
  storage.removeItem(key)
  return storage.getItem(key) === null
}

/**
 * The trade's send journal, both copies: the durable checkpoint `saveSideTrade` commits first, and the localStorage
 * copy TxSteps keeps afterwards (the trade's steps run without `durableJournal`, so every send after the first
 * checkpoint lands only there). A check that read the checkpoint alone saw an empty journal after any send.
 */
async function tradeJournals(
  storage: JournalStorage,
  trade: SideTradeIntent,
  checkpoint: VaultIntentCheckpoint,
): Promise<OpRecord[]> {
  const key = txJournalKey(sideTradeTaskId(trade.id), trade.txs)
  const durable = await readTxJournalDurable(storage, key, true, checkpoint)
  return [durable, readTxJournal(storage, key)].filter((journal) => journal !== null)
}

/** Where one copy of a trade's journal stands. */
function progress(journal: OpRecord, steps: number) {
  const confirmed = (i: number) => journal.recorded[i] === true
  const indexes = Array.from({ length: steps }, (_, i) => i)
  // The user-op path keeps its state in the same record (`aa`): a built operation is in flight until its receipt says
  // otherwise, and a reverted receipt ended it without effect, like a reverted transaction.
  const opReverted = journal.aa?.receipt?.status === 'reverted' ? journal.aa.receipt.txHash : null
  const reverted = opReverted ?? journal.reverted?.at(-1) ?? null
  return {
    // Nothing went to the wallet or the bundler that is still unaccounted for: no pending send, no unconfirmed hash,
    // no sponsorship and no user operation still in flight.
    quiet:
      journal.pending === null &&
      journal.hashes.every((hash, i) => hash === null || confirmed(i)) &&
      journal.sponsor == null &&
      (journal.aa == null || journal.aa.built === undefined || opReverted !== null),
    unsent: journal.hashes.every((hash) => hash === null),
    finished: indexes.every(confirmed),
    started: indexes.some(confirmed),
    tried:
      reverted !== null ||
      (journal.effectFailures?.length ?? 0) > 0 ||
      (journal.attempts ?? []).some((nonce, i) => nonce != null && !confirmed(i)),
    reverted,
  }
}

const progressOf = async (storage: JournalStorage, trade: SideTradeIntent, checkpoint: VaultIntentCheckpoint) =>
  (await tradeJournals(storage, trade, checkpoint)).map((journal) =>
    progress(journal, journal.batch ? 1 : trade.txs.length),
  )

/**
 * Whether a trade's journal shows nothing went to the wallet or the bundler: no MON send pending or hashed, no
 * sponsorship, and no built user operation, in either copy. Only then may it be discarded; this mirrors TxSteps' own
 * safe-to-restart rule for both paths.
 */
export async function sideTradeUnstarted(
  storage: JournalStorage,
  trade: SideTradeIntent,
  checkpoint: VaultIntentCheckpoint = browserVaultIntentCheckpoint,
): Promise<boolean> {
  const all = await progressOf(storage, trade, checkpoint)
  return all.length > 0 && all.every((copy) => copy.quiet && copy.unsent)
}

/** A trade that ended without its effect: `tried` once the wallet was asked, `reverted` the last reverted receipt. */
export interface SideTradeEnd {
  tried: boolean
  reverted: `0x${string}` | null
}

/**
 * Whether a saved trade is over without having happened: quiet in both copies of its journal, and not every step
 * confirmed. Such a trade is cleared and quoted afresh, never sent again with its old floor and deadline. Null while
 * anything may be in flight, for a finished trade, and for a half-done one (a sale whose approval landed and whose
 * sale was never asked for, which is finished instead).
 */
export async function sideTradeEnded(
  storage: JournalStorage,
  trade: SideTradeIntent,
  checkpoint: VaultIntentCheckpoint = browserVaultIntentCheckpoint,
): Promise<SideTradeEnd | null> {
  const all = await progressOf(storage, trade, checkpoint)
  if (all.length === 0 || all.some((copy) => !copy.quiet || copy.finished)) return null
  const tried = all.some((copy) => copy.tried)
  if (!tried && all.some((copy) => copy.started)) return null
  return { tried, reverted: all.findLast((copy) => copy.reverted !== null)?.reverted ?? null }
}

const text = (pattern: RegExp) => Schema.String.check(Schema.isPattern(pattern))
const Decimal = text(/^\d+$/)
const AddressText = text(/^0x[0-9a-fA-F]{40}$/)
const Int = Schema.Number.pipe(Schema.check(Schema.makeFilter((value) => Number.isSafeInteger(value))))
const Step = Schema.Struct({
  description: Schema.String,
  chainId: Int,
  to: AddressText,
  data: text(/^0x(?:[0-9a-f]{2})+$/i),
  value: Decimal,
})
const isSavedTrade = Schema.is(
  Schema.Struct({
    id: text(/^\S+$/),
    trade: Schema.Literals(['buy', 'sell']),
    owner: AddressText,
    txs: Schema.Array(Step).pipe(Schema.check(Schema.makeFilter((steps) => steps.length > 0))),
    out: Decimal,
    deadline: Int,
    payWith: Schema.optionalKey(Schema.Literal('usdc')),
    paid: Schema.optionalKey(Decimal),
  }),
)

/** A saved trade as written by `saveSideTrade`: every field present and well formed. */
function isSideTrade(value: unknown): value is SideTradeIntent {
  return isSavedTrade(value)
}
