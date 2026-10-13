import { Schema } from 'effect'
import type { Hex } from 'viem'
import type { TxRequest } from '../api.ts'

/** Board calls remain zero-value; reviewed wallet funding may also send native MON. */
export type WalletStep = Omit<TxRequest, 'value'> & { value: string }
export function walletStepRequest(tx: WalletStep, account: Hex, chainId: number, nonce?: number) {
  if (tx.chainId !== chainId || !/^\d+$/.test(tx.value) || BigInt(tx.value) >= 2n ** 256n)
    throw new Error('Invalid transaction value or network. Nothing was sent.')
  if (nonce !== undefined && (!Number.isSafeInteger(nonce) || nonce < 0))
    throw new Error('Invalid transaction nonce. Nothing was sent.')
  return {
    account,
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value),
    chainId,
    ...(nonce === undefined ? {} : { nonce }),
  }
}

export interface StepLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>
}

/** How long a step may wait on its lock before the page says that something else holds it. */
export const LOCK_WAIT_NOTICE_MS = 2000

/**
 * The lock spans journal reread, wallet confirmation and hash persistence. No unsafe fallback. Another tab can hold it
 * for minutes (an open wallet prompt, or a hidden tab's throttled timers), so `onWait` runs once the wait gets long.
 */
export async function withWalletStepLock<T>(
  locks: StepLocks | undefined,
  key: string,
  operation: () => Promise<T>,
  onWait?: () => void,
): Promise<T> {
  if (locks === undefined)
    throw new Error(
      'This browser cannot safely coordinate wallet operations across tabs. Use a browser with Web Locks.',
    )
  if (onWait === undefined) return locks.request(`sidequest.wallet-step:${key}`, operation)
  let held = false
  const timer = setTimeout(() => {
    if (!held) onWait()
  }, LOCK_WAIT_NOTICE_MS)
  try {
    return await locks.request(`sidequest.wallet-step:${key}`, () => {
      held = true
      clearTimeout(timer)
      return operation()
    })
  } finally {
    clearTimeout(timer)
  }
}

/** Different operations must not capture the same account nonce while another tab is confirming a send. */
export function withWalletAccountLock<T>(
  locks: StepLocks | undefined,
  chainId: number,
  account: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withWalletStepLock(locks, `account:${chainId}:${account.toLowerCase()}`, operation)
}

export type TxStatus =
  | { at: 'idle' }
  | { at: 'signing' }
  | { at: 'uncertain'; error: string; checking?: boolean }
  | { at: 'sent'; hash: Hex }
  | { at: 'confirmed'; hash: Hex; reportError?: string }
  | { at: 'recorded'; hash: Hex }
  | { at: 'failed'; error: string; hash?: Hex; reverted?: boolean; noEffect?: boolean }

export function retryAction(status: TxStatus): 'send' | 'receipt' | 'report' | 'wait' {
  if (status.at === 'confirmed' && status.reportError !== undefined) return 'report'
  if (status.at === 'failed' && status.hash !== undefined && status.reverted !== true && status.noEffect !== true)
    return 'receipt'
  if (status.at === 'idle' || status.at === 'failed') return 'send'
  return 'wait'
}

const isText = Schema.is(Schema.String)

export function walletRefused(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth++) {
    const failure = current as { code?: unknown; cause?: unknown; message?: unknown }
    if (failure.code === 4001 || failure.code === 'ACTION_REJECTED') return true
    // Privy's own transaction screen, closed or declined, says exactly this.
    if (isText(failure.message) && /^the user rejected the request\.?$/i.test(failure.message)) return true
    current = failure.cause
  }
  return false
}

/**
 * The account's next nonce (pending) and the head block, read just before a step goes to the wallet, so an ambiguous
 * wallet error can be settled against the chain instead of guessed. The block is a decimal string (JSON-safe).
 */
export interface SendSnapshot {
  nonce: number
  block: string
}

/** Check approval freshness both before and after asynchronous pre-send reads. */
export async function guardedSnapshot(
  reads: Pick<ChainReads, 'nonce' | 'blockNumber'>,
  guard?: () => string | null | Promise<string | null>,
  prepare?: () => Promise<void>,
): Promise<SendSnapshot> {
  const assert = async () => {
    const problem = await guard?.()
    if (problem) throw new Error(problem)
  }
  await assert()
  await prepare?.()
  await assert()
  const [nonce, block] = await Promise.all([reads.nonce('pending'), reads.blockNumber()])
  await assert()
  return { nonce, block: block.toString() }
}

/** The chain reads a reconciliation needs; the transactions of a block as far as matching a call goes. */
export interface ChainReads {
  nonce(blockTag: 'latest' | 'pending'): Promise<number>
  /** The account's nonce after a past block: lets `reconcileSend` find the block its send landed in by bisection. */
  nonceAt?(block: bigint): Promise<number>
  blockNumber(): Promise<bigint>
  block(number: bigint): Promise<{
    transactions: ReadonlyArray<{
      hash: Hex
      from: string
      to: string | null
      input: Hex
      nonce: number
      value?: bigint
    }>
  }>
}

/**
 * Where a step stands after its wallet failed without a definitive refusal:
 * - `found`: it was mined (the hash to follow);
 * - `not-sent`: every transaction this account sent since the snapshot is accounted for and none is this call, and
 *   nothing is waiting in the mempool, so sending again cannot double it;
 * - `pending`: the account has a transaction waiting that is not mined yet;
 * - `unknown`: the chain could not answer, or there were too many blocks to look through.
 */
export type Reconciled = { at: 'found'; hash: Hex } | { at: 'not-sent' } | { at: 'pending' } | { at: 'unknown' }

const same = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase()

/** Blocks read before the one where the nonce moved: an RPC may report a block's state a few blocks late (Monad). */
const NONCE_LAG = 3n

/**
 * The first block after `start` whose nonce is past `nonce`, by bisection over `nonceAt`: about 10 reads for a
 * thousand blocks, where reading them one by one took minutes on a public RPC (13 Oct, a buy confirmed a minute late).
 */
async function firstBlockPast(reads: ChainReads, nonce: number, start: bigint, head: bigint): Promise<bigint> {
  let lo = start
  let hi = head
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    const at = await reads.nonceAt?.(mid)
    if (at === undefined) return start
    if (at > nonce) hi = mid
    else lo = mid + 1n
  }
  return lo
}

/**
 * Settles an ambiguous send against the chain. When the account's mined nonce has not moved past the snapshot and
 * nothing is pending, nothing went out. When it has moved, the blocks from where it moved (found by bisection when the
 * reads allow it, else from the snapshot) are read until every one of the account's new transactions is seen; the one
 * carrying this exact call is the step. At most `maxBlocks` blocks are read, after which the answer is `unknown` rather
 * than a guess.
 */
export async function reconcileSend(
  reads: ChainReads,
  snapshot: SendSnapshot,
  from: string,
  call: { to: string; data: Hex; value?: bigint; nonce?: number },
  maxBlocks = 240,
): Promise<Reconciled> {
  let mined: number
  let pending: number
  let head: bigint
  try {
    ;[mined, pending, head] = await Promise.all([reads.nonce('latest'), reads.nonce('pending'), reads.blockNumber()])
  } catch {
    return { at: 'unknown' }
  }
  const sent = mined - snapshot.nonce
  if (sent > 0) {
    let seen = 0
    let start = BigInt(snapshot.block)
    try {
      if (reads.nonceAt !== undefined && head > start) {
        const moved = await firstBlockPast(reads, snapshot.nonce, start, head)
        start = moved - NONCE_LAG > start ? moved - NONCE_LAG : start
      }
    } catch {
      return { at: 'unknown' }
    }
    const last = head < start + BigInt(maxBlocks) - 1n ? head : start + BigInt(maxBlocks) - 1n
    try {
      for (let n = start; n <= last && seen < sent; n++) {
        for (const tx of (await reads.block(n)).transactions) {
          if (!same(tx.from, from) || tx.nonce < snapshot.nonce) continue
          if (
            same(tx.to, call.to) &&
            (call.nonce === undefined || tx.nonce === call.nonce) &&
            tx.input.toLowerCase() === call.data.toLowerCase() &&
            (tx.value ?? 0n) === (call.value ?? 0n)
          )
            return { at: 'found', hash: tx.hash }
          seen++
        }
      }
    } catch {
      return { at: 'unknown' }
    }
    if (seen < sent) return { at: 'unknown' }
  }
  return pending > mined ? { at: 'pending' } : { at: 'not-sent' }
}
