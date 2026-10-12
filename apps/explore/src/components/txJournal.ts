import type { Hex } from 'viem'
import { Schema } from 'effect'
import { decodeAaJournal, type AaJournal } from '../aa-journal.ts'
import type { SendSnapshot, WalletStep } from './txOperation.ts'
import { type VaultIntentCheckpoint, browserVaultIntentCheckpoint } from '../vault-lock.ts'

export interface OpRecord {
  batch: boolean
  hashes: Array<Hex | null>
  recorded: boolean[]
  pending: number | null
  snapshot?: SendSnapshot | null
  from?: Hex | null
  /** The account nonce captured for this exact wallet attempt. */
  attempts?: Array<number | null>
  sponsored?: boolean
  sponsor?: { key: string; operationId: Hex | null } | null
  /** Proven reverted receipts are retained for audit while their step becomes sendable again. */
  reverted?: Hex[]
  /** Successful receipts proven to have no requested effect; keep their hashes while offering a retry. */
  effectFailures?: Array<{ index: number; hash: Hex; error: string }>
  /** A signed user operation is persisted before the bundler call so a reload keeps its action lane. */
  aa?: AaJournal | null
}

export interface JournalStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
export const emptyJournal = (): OpRecord => ({ batch: false, hashes: [], recorded: [], pending: null })
/** Mode changes may never replace an unresolved attempt or successful batch. */
export function sequentialJournal(record: OpRecord): OpRecord {
  if (
    !record.batch ||
    record.pending !== null ||
    record.hashes.some((hash) => hash !== null) ||
    record.recorded.some(Boolean)
  )
    throw new Error('Reconcile the original batch before changing how it is sent.')
  return { ...record, batch: false }
}
export function txJournalKey(taskId: string, txs: WalletStep[]): string {
  const native = txs.some((tx) => tx.value !== '0')
  let hash = 0x811c9dc5
  for (const char of txs
    .map((tx) => (native ? `${tx.chainId}:${tx.to}:${tx.data}:${tx.value}` : `${tx.to}:${tx.data}`))
    .join('|'))
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193)
  return `sidequest.op${native ? '-value' : ''}:${taskId}:${(hash >>> 0).toString(36)}`
}
export const JOURNAL_CORRUPT = 'Transaction journal is corrupt. Wallet outcome is unknown; reconcile before continuing.'

const isText = Schema.is(Schema.String)
const isBoolean = Schema.is(Schema.Boolean)

const invalidEffectFailures = (value: OpRecord): boolean => {
  const failures = value.effectFailures
  return (
    failures !== undefined &&
    (!Array.isArray(failures) ||
      !failures.every(
        (failure) =>
          failure !== null &&
          failure instanceof Object &&
          Number.isSafeInteger(failure.index) &&
          failure.index >= 0 &&
          isText(failure.hash) &&
          /^0x[0-9a-f]{64}$/i.test(failure.hash) &&
          isText(failure.error),
      ))
  )
}

const invalidJournalRecord = (value: OpRecord): boolean =>
  !value ||
  !isBoolean(value.batch) ||
  !Array.isArray(value.hashes) ||
  !value.hashes.every((hash) => hash === null || (isText(hash) && /^0x[0-9a-f]{64}$/i.test(hash))) ||
  !Array.isArray(value.recorded) ||
  !value.recorded.every((recorded) => recorded === null || isBoolean(recorded)) ||
  (value.reverted !== undefined &&
    (!Array.isArray(value.reverted) ||
      !value.reverted.every((hash) => isText(hash) && /^0x[0-9a-f]{64}$/i.test(hash)))) ||
  (value.pending !== null &&
    (!Number.isSafeInteger(value.pending) || value.pending < 0 || value.snapshot == null || value.from == null)) ||
  (value.snapshot != null && (!Number.isSafeInteger(value.snapshot.nonce) || !/^\d+$/.test(value.snapshot.block))) ||
  (value.from != null && !/^0x[0-9a-f]{40}$/i.test(value.from)) ||
  (value.attempts != null &&
    (!Array.isArray(value.attempts) ||
      !value.attempts.every((nonce) => nonce === null || (Number.isSafeInteger(nonce) && nonce >= 0))))

export function readTxJournal(storage: JournalStorage, key: string, requireExisting = false): OpRecord | null {
  let raw: string | null
  try {
    raw = storage.getItem(key)
  } catch {
    throw new Error('Transaction journal is unreadable. Wallet outcome is unknown; reconcile before continuing.')
  }
  if (raw === null) {
    if (requireExisting)
      throw new Error(
        'The saved transaction journal is missing. Wallet outcome is unknown; reconcile before continuing.',
      )
    return null
  }
  let value: OpRecord
  try {
    // SAFETY: readTxJournal immediately validates the parsed legacy record with invalidJournalRecord.
    value = JSON.parse(raw) as OpRecord
  } catch {
    throw new Error(JOURNAL_CORRUPT)
  }
  if (invalidJournalRecord(value) || invalidEffectFailures(value)) throw new Error(JOURNAL_CORRUPT)
  if (value.aa != null) decodeAaJournal(value.aa)
  return value
}
export function writeTxJournal(storage: JournalStorage, key: string, record: OpRecord | null): void {
  try {
    if (record === null) storage.removeItem(key)
    else {
      const bytes = JSON.stringify(record)
      storage.setItem(key, bytes)
      if (storage.getItem(key) !== bytes) throw new Error('write not durable')
    }
  } catch {
    throw new Error(
      'Transaction journal could not be saved. No new wallet prompt is allowed; reconcile any existing broadcast.',
    )
  }
}

const journalCheckpointKey = (key: string) => `sidequest.tx-journal:${key}`

/** Read the inner send journal from the committed cross-renderer store before trusting localStorage. */
export async function readTxJournalDurable(
  storage: JournalStorage,
  key: string,
  requireExisting = false,
  checkpoint: VaultIntentCheckpoint = browserVaultIntentCheckpoint,
): Promise<OpRecord | null> {
  const durable = await checkpoint.read(journalCheckpointKey(key))
  // Every durable journal is checkpointed before its local copy, so a local one alone has an unknown outcome.
  if (durable === undefined) {
    if (readTxJournal(storage, key, requireExisting) !== null)
      throw new Error(
        'This saved transaction has no durable record. Wallet outcome is unknown; reconcile before continuing.',
      )
    return null
  }
  return readTxJournal({ getItem: () => durable, setItem: () => {}, removeItem: () => {} }, key, requireExisting)
}

/** Commit the inner journal before exposing its localStorage copy. */
export async function writeTxJournalDurable(
  storage: JournalStorage,
  key: string,
  record: OpRecord | null,
  checkpoint: VaultIntentCheckpoint = browserVaultIntentCheckpoint,
): Promise<void> {
  const bytes = record === null ? null : JSON.stringify(record)
  await checkpoint.write(journalCheckpointKey(key), bytes)
  writeTxJournal(storage, key, record)
}

/** Persist the inner journal before an outer approval record can advertise executable transactions. */
export async function initializeTxJournalDurable(
  storage: JournalStorage,
  taskId: string,
  txs: WalletStep[],
  checkpoint: VaultIntentCheckpoint = browserVaultIntentCheckpoint,
): Promise<void> {
  const key = txJournalKey(taskId, txs)
  if ((await readTxJournalDurable(storage, key, false, checkpoint)) === null)
    await writeTxJournalDurable(storage, key, emptyJournal(), checkpoint)
}
