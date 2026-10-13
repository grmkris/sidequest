import { Button } from './ui/button.tsx'
import { Input } from './ui/input.tsx'
import { cn } from '../lib/cn.ts'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Item, ItemGroup, ItemContent } from './ui/item.tsx'
import { TxLink } from './kit.tsx'
import * as sdk from '@sidequest/sdk'
import { Check, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Hex, TransactionReceipt } from 'viem'
import { useAccount, useSwitchChain } from 'wagmi'
import { stepsPrompt, useSendTransactionWithPrompt } from '../wallet-prompt.ts'
import { getBlock, getBlockNumber, getTransaction, getTransactionCount, waitForTransactionReceipt } from 'wagmi/actions'
import { type TxRequest, boardApi } from '../api.ts'
import { batchGasLimit, gasLimit } from '../gas.ts'
import { sidequest } from '../sidequest.ts'
import { friendlyError } from '../txErrors.ts'
import { useLiveSponsorship } from '../sponsor.ts'
import { atomicRefusal } from '../aa-mode.ts'
import { chain, deployment, wagmiConfig, writesOpen } from '../wallet.ts'
import { LaunchNotice } from './LaunchGate.tsx'
import { usePrivyBatch } from './Privy.tsx'
import {
  type ChainReads,
  type Reconciled,
  type SendSnapshot,
  type TxStatus,
  type WalletStep,
  guardedSnapshot,
  reconcileSend,
  retryAction,
  walletRefused,
  walletStepRequest,
  withWalletAccountLock,
  withWalletStepLock,
} from './txOperation.ts'

import {
  JOURNAL_CORRUPT,
  emptyJournal,
  sequentialJournal,
  readTxJournal,
  readTxJournalDurable,
  txJournalKey,
  writeTxJournal,
  writeTxJournalDurable,
  type OpRecord,
} from './txJournal.ts'

type Status = TxStatus

const chainReads = (address: Hex): ChainReads => ({
  nonce: (blockTag) => getTransactionCount(wagmiConfig, { address, blockTag, chainId: chain.id }),
  blockNumber: () => getBlockNumber(wagmiConfig, { chainId: chain.id, cacheTime: 0 }),
  block: (blockNumber) => getBlock(wagmiConfig, { blockNumber, includeTransactions: true, chainId: chain.id }),
})

/** Waits between chain checks after an ambiguous wallet error: a broadcast step is mined within seconds on Monad. */
const RECHECK_MS = [1000, 2000, 3000, 4000, 5000]
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const SPONSORED = {
  lost: 'Sidequest’s relay did not answer, so whether it sent these steps is unknown. Check again: the relay never sends the same steps twice.',
  checking: 'Sidequest’s relay did not answer. Checking whether it sent these steps…',
  slow: 'Sidequest’s relay sent it and Monad has not mined it yet. Check again in a moment.',
}

const UNCERTAIN = {
  checking: 'Your wallet returned an error without a transaction hash. Checking the chain for this step…',
  pending:
    'Your account has a transaction waiting to be mined. Check again in a moment, or paste its hash from your wallet activity; do not send this step again yet.',
  unknown:
    'The chain could not confirm whether this step went out. Check again, or paste its hash from your wallet activity; do not send it again yet.',
}

const load = (key: string, required = false) => readTxJournal(localStorage, key, required)
const save = (key: string, record: OpRecord | null) => writeTxJournal(localStorage, key, record)

const SPONSORED_LABEL: Partial<Record<Status['at'], string>> = {
  idle: 'Waiting for the previous transaction',
  signing: 'Sending through Sidequest…',
  sent: 'Sent by Sidequest · waiting for Monad…',
}

const LABEL: Record<Status['at'], string> = {
  idle: 'Waiting',
  signing: 'Confirm in your wallet…',
  uncertain: 'Submission outcome unknown',
  sent: 'Sent · waiting for Monad…',
  confirmed: 'Confirmed · recording…',
  recorded: 'Confirmed',
  failed: 'Failed · retry below',
}

/**
 * Browser actions select user operations (gas in USDC, or in MON with no paymaster) or MON transactions, preserving the
 * original action journal.
 */
export { BrowserTxSteps as TxSteps } from './BrowserTxSteps.tsx'

export type TxStepsProps = {
  taskId: string
  txs: WalletStep[]
  onDone: (hashes: string[]) => void
  boardId?: string | undefined
  owner?: string | undefined
  canSend?: boolean
  onBusyChange?: (busy: boolean) => void
  onSafeToRestartChange?: (safe: boolean) => void
  reportToBoard?: boolean
  autoStart?: boolean
  retainRecord?: boolean
  allowBatch?: boolean
  /** Retained for callers during cutover; browser actions always pay their own gas. */
  allowSponsorship?: boolean
  sponsor?: 'faucet'
  requireAtomic?: boolean
  /** Rechecked immediately after chain reads, before any new wallet prompt. */
  sendGuard?: (() => string | null | Promise<string | null>) | undefined
  requireJournal?: boolean
  verifyReceipt?: boolean
  /** Use committed cross-renderer journal checkpoints under the existing step lock. */
  durableJournal?: boolean
  /** A successful receipt must prove the requested effect. A returned error proves no effect and permits retry; unreadable or conflicting proof must throw. */
  receiptGuard?:
    | ((receipt: Pick<TransactionReceipt, 'logs'>, steps: readonly WalletStep[]) => string | null)
    | undefined
}

export function MonTxSteps({
  taskId,
  txs,
  onDone,
  boardId,
  owner,
  canSend = true,
  onBusyChange,
  onSafeToRestartChange,
  reportToBoard = true,
  autoStart = false,
  retainRecord = false,
  allowBatch = true,
  requireAtomic = false,

  sendGuard,
  requireJournal = false,
  verifyReceipt = false,
  receiptGuard,
  durableJournal = false,
}: TxStepsProps) {
  const { chainId, address } = useAccount()
  const currentAccount = useRef({ chainId, address, canSend })
  currentAccount.current = { chainId, address, canSend }

  const walletBatch = usePrivyBatch(address)
  const zeroValue = txs.every((tx) => tx.value === '0')
  const boardSteps = txs.map((tx) => ({ ...tx, value: '0' as const }))
  const batch = allowBatch && zeroValue ? walletBatch : null
  const canSponsor = false
  const sponsorship = useLiveSponsorship(address, false)
  const { switchChainAsync } = useSwitchChain()
  const sendTransactionAsync = useSendTransactionWithPrompt()
  const key = txJournalKey(taskId, txs)
  const loadDurable = async (required = false) =>
    durableJournal ? readTxJournalDurable(localStorage, key, required) : load(key, required)
  const persistDurable = async (r: OpRecord | null) => {
    if (durableJournal) await writeTxJournalDurable(localStorage, key, r)
    else save(key, r)
    setRecord(r ?? emptyJournal())
  }
  const [initial] = useState(() => {
    try {
      return {
        record: load(key, requireJournal && !durableJournal) ?? {
          ...emptyJournal(),
          batch: batch !== null && txs.length > 1,
        },
        error: null,
      }
    } catch (failure) {
      return { record: emptyJournal(), error: friendlyError(failure) }
    }
  })
  const [journalError, setJournalError] = useState<string | null>(initial.error)
  const [record, setRecord] = useState<OpRecord>(initial.record)
  const [status, setStatus] = useState<Status[]>(() =>
    (record.batch || record.sponsored === true ? [txs[0] as TxRequest] : txs).map((_, i): Status => {
      if (initial.error !== null) return { at: 'uncertain', error: initial.error }
      const h = record.hashes[i]
      if (h === null || h === undefined) {
        if (record.sponsored === true && record.sponsor != null) return { at: 'uncertain', error: SPONSORED.lost }
        if (record.pending !== i) {
          const failure = record.effectFailures?.findLast((entry) => entry.index === i)
          return failure === undefined
            ? { at: 'idle' }
            : { at: 'failed', hash: failure.hash, error: failure.error, noEffect: true }
        }
        return { at: 'uncertain', checking: true, error: UNCERTAIN.checking }
      }
      return record.recorded[i] === true && receiptGuard === undefined
        ? { at: 'recorded', hash: h }
        : { at: 'sent', hash: h }
    }),
  )
  const [switching, setSwitching] = useState<string | null>(null)
  const [pendingHash, setPendingHash] = useState('')
  // Why the steps went from the wallet after Sidequest was going to pay; once set, the relay is not offered again.
  const [notice, setNotice] = useState<{ text: string; hash?: Hex } | null>(null)
  const [sponsorOff, setSponsorOff] = useState(false)
  const sending = useRef(false)
  const checking = useRef(false)
  const done = useRef(false)
  const receiptProofs = useRef(new Set<Hex>())

  const commit = async (r: OpRecord) => {
    await persistDurable(r)
  }
  const syncRecord = (r: OpRecord) => {
    setRecord(r)
    setStatus(
      (r.batch || r.sponsored === true ? [txs[0] as TxRequest] : txs).map((_, i): Status => {
        const hash = r.hashes[i]
        if (hash != null)
          return r.recorded[i] === true && (receiptGuard === undefined || receiptProofs.current.has(hash))
            ? { at: 'recorded', hash }
            : { at: 'sent', hash }
        const failure = r.effectFailures?.findLast((entry) => entry.index === i)
        return r.pending === i
          ? { at: 'uncertain', error: UNCERTAIN.unknown }
          : failure === undefined
            ? { at: 'idle' }
            : { at: 'failed', hash: failure.hash, error: failure.error, noEffect: true }
      }),
    )
  }
  const set = (i: number, s: Status) => setStatus((all) => all.map((x, j) => (j === i ? s : x)))
  const journalFailure = (failure: unknown) => {
    const error = friendlyError(failure)
    setJournalError(error)
    setStatus((all) =>
      all.map((entry) => (entry.at === 'recorded' || entry.at === 'sent' ? entry : { at: 'uncertain', error })),
    )
  }
  const hasSavedJournal = () => {
    try {
      return load(key) !== null
    } catch (failure) {
      journalFailure(failure)
      return true
    }
  }

  /** A user-supplied hash is evidence only if it names this exact wallet attempt on the configured chain. */
  const verifyTransaction = async (i: number, hash: Hex, r: OpRecord) => {
    const transaction = await getTransaction(wagmiConfig, { hash, chainId: chain.id })
    const nonce = r.pending === i ? r.snapshot?.nonce : r.attempts?.[i]
    const call = r.batch
      ? { to: r.from, data: sdk.batchCalldata(boardSteps), value: 0n }
      : { to: txs[i]!.to, data: txs[i]!.data, value: BigInt(txs[i]!.value) }
    if (
      transaction.chainId !== chain.id ||
      r.from == null ||
      nonce == null ||
      transaction.from.toLowerCase() !== r.from.toLowerCase() ||
      transaction.nonce !== nonce ||
      transaction.to?.toLowerCase() !== call.to?.toLowerCase() ||
      transaction.input.toLowerCase() !== call.data.toLowerCase() ||
      transaction.value !== call.value
    )
      throw new Error(
        'This receipt differs from the reviewed sender, chain, attempt, recipient, calldata or amount. Reconcile the original transaction.',
      )
  }

  /** Waits for a sent hash, then has the board record it; used after a send and after a reload. */
  const settle = async (i: number, hash: Hex, r: OpRecord) => {
    if (r.sponsored === true) {
      await settleSponsored(hash, r)
      return
    }
    try {
      if (verifyReceipt) await verifyTransaction(i, hash, r)
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: chain.id })
      if (receiptGuard !== undefined && receipt.transactionHash.toLowerCase() !== hash.toLowerCase())
        throw new Error('The effect receipt names a different transaction. Reconcile before continuing.')
      if (receipt.status !== 'success') {
        const latest = (await loadDurable(requireJournal)) ?? r
        const reverted = [...(latest.reverted ?? [])]
        if (!reverted.some((previous) => previous.toLowerCase() === hash.toLowerCase())) reverted.push(hash)
        const hashes = [...latest.hashes]
        hashes[i] = null
        await commit({
          ...latest,
          pending: latest.pending === i ? null : latest.pending,
          snapshot: latest.pending === i ? null : (latest.snapshot ?? null),
          hashes,
          reverted,
          recorded: Object.assign([...latest.recorded], { [i]: false }),
        })
        set(i, {
          at: 'failed',
          hash,
          reverted: true,
          error: record.batch
            ? 'The transaction reverted, so none of the steps happened.'
            : 'The transaction reverted, so nothing changed.',
        })
        return
      }
      const latest = (await loadDurable(requireJournal)) ?? r
      const effectError = receiptGuard?.(receipt, r.batch ? txs : [txs[i]!])
      if (effectError) {
        const effectFailures = [...(latest.effectFailures ?? [])]
        if (!effectFailures.some((failure) => failure.hash === hash))
          effectFailures.push({ index: i, hash, error: effectError })
        const hashes = [...latest.hashes]
        hashes[i] = null
        await commit({
          ...latest,
          pending: latest.pending === i ? null : latest.pending,
          snapshot: latest.pending === i ? null : (latest.snapshot ?? null),
          hashes,
          effectFailures,
          recorded: Object.assign([...latest.recorded], { [i]: false }),
        })
        set(i, { at: 'failed', hash, noEffect: true, error: effectError })
        return
      }
      receiptProofs.current.add(hash)
      if (latest.pending === i) {
        const hashes = [...latest.hashes]
        hashes[i] = hash
        await commit({ ...latest, pending: null, snapshot: null, hashes })
      }
    } catch (e) {
      set(
        i,
        r.pending === i
          ? { at: 'uncertain', error: friendlyError(e) }
          : { at: 'failed', hash, error: friendlyError(e) },
      )
      return
    }
    await report(i, hash, r)
  }

  /** Steps that will not go through the relay after all: from the wallet, as one batch where it can, with why. */
  const toWallet = async (text: string | null, hash?: Hex) => {
    const next: OpRecord = {
      batch: batch !== null && txs.length > 1,
      hashes: [],
      recorded: [],
      pending: null,
    }
    setSponsorOff(true)
    await commit(next)
    setStatus((next.batch ? [txs[0] as TxRequest] : txs).map((): Status => ({ at: 'idle' })))
    setNotice(text === null ? null : hash === undefined ? { text } : { text, hash })
  }

  /**
   * The relay's transaction, from the chain: confirmed, it is recorded like any step; reverted, nothing happened and
   * the steps are offered from the wallet (under this delegation the same calls would only return the same failure).
   * Not mined within a minute, it waits on a check that submits the same key again: the board answers with the same
   * operation and rebroadcasts its identical signed bytes.
   */
  const settleSponsored = async (hash: Hex, r: OpRecord) => {
    try {
      const receipt = await waitForTransactionReceipt(wagmiConfig, {
        hash,
        chainId: chain.id,
        timeout: 60_000,
      })
      if (receipt.status !== 'success') {
        await toWallet(
          'Sidequest sent these steps and the transaction reverted, so nothing changed. You can send them from your wallet; you pay the gas.',
          hash,
        )
        return
      }
      const effectError = receiptGuard?.(receipt, txs)
      if (effectError) throw new Error(effectError)
      receiptProofs.current.add(hash)
    } catch {
      set(0, { at: 'uncertain', error: SPONSORED.slow })
      return
    }
    await report(0, hash, r)
  }

  const runSponsored = async (saved = record) => {
    const hash = saved.hashes[0]
    if (hash != null) await settleSponsored(hash, saved)
    else
      set(0, {
        at: 'uncertain',
        error: 'A previous transaction has no known hash. Ask support to reconcile it before sending again.',
      })
  }
  const report = async (i: number, hash: Hex, r: OpRecord) => {
    set(i, { at: 'confirmed', hash })
    try {
      // The task's own board records it (a job may be shown on another board's page). A step that belongs to no job
      // (staking) is done once the chain confirms it.
      if (reportToBoard) await boardApi(boardId).tool('report_transaction', { taskId, txHash: hash })
      // Receipt reconciliation can finish in a stale tab after another tab has sent a later step. Merge with the
      // authoritative journal so that this tab cannot erase that step's hash or pending state.
      const latest = (await loadDurable(requireJournal)) ?? r
      const existing = latest.hashes[i]
      if (existing !== null && existing !== undefined && existing.toLowerCase() !== hash.toLowerCase())
        throw new Error(
          'The saved transaction journal changed while this receipt was being reconciled. Reconcile before continuing.',
        )
      const next = {
        ...latest,
        hashes: Object.assign([...latest.hashes], { [i]: hash }),
        recorded: Object.assign([...latest.recorded], { [i]: true }),
      }
      await commit(next)
      set(i, { at: 'recorded', hash })
    } catch (e) {
      set(i, {
        at: 'confirmed',
        hash,
        reportError: `On the chain, but the board did not record it: ${friendlyError(e)}`,
      })
    }
  }

  /**
   * After a wallet error that was not a refusal: asks the chain, a few times over some seconds, whether the step went
   * out. Mined: follow it like any sent step. Provably not sent: a real retry. Otherwise it stays uncertain, with a
   * check again and the hash from wallet activity as the ways out; it is never sent twice on a guess.
   */
  const reconcile = async (i: number, r: OpRecord) => {
    if (checking.current) return
    const snapshot = r.snapshot
    const from = r.from
    if (snapshot == null || from == null) {
      set(i, { at: 'uncertain', error: JOURNAL_CORRUPT })
      return
    }
    checking.current = true
    set(i, { at: 'uncertain', checking: true, error: UNCERTAIN.checking })
    const call = r.batch
      ? { to: from, data: sdk.batchCalldata(txs.map((t) => ({ ...t, value: '0' as const }))) }
      : { to: txs[i]!.to, data: txs[i]!.data, value: BigInt(txs[i]!.value) }
    let outcome: Reconciled = { at: 'unknown' }
    let notSent = 0
    for (const wait of RECHECK_MS) {
      await sleep(wait)
      outcome = await reconcileSend(chainReads(from), snapshot, from, { ...call, nonce: snapshot.nonce })
      notSent = outcome.at === 'not-sent' ? notSent + 1 : 0
      // Twice in a row: a step the wallet broadcast just before failing would be pending or mined by then.
      if (outcome.at === 'found' || notSent === 2) break
    }
    checking.current = false
    if (outcome.at === 'found') {
      const known = {
        ...r,
        pending: null,
        snapshot: null,
        hashes: Object.assign([...r.hashes], { [i]: outcome.hash }),
      }
      await commit(known)
      set(i, { at: 'sent', hash: outcome.hash })
      await settle(i, outcome.hash, known)
    } else if (outcome.at === 'not-sent') {
      await commit({ ...r, pending: null, snapshot: null })
      set(i, {
        at: 'failed',
        error:
          'Your wallet returned an error and nothing left your account, so nothing was sent. You can send it again.',
      })
    } else {
      set(i, {
        at: 'uncertain',
        error: outcome.at === 'pending' ? UNCERTAIN.pending : UNCERTAIN.unknown,
      })
    }
  }

  /** Reloads and manual receipt checks share the send lock, including every journal write they can produce. */
  const reconcileSaved = async (i: number) => {
    try {
      await withWalletStepLock(navigator.locks, key, async () => {
        const latest = (await loadDurable(requireJournal)) ?? record
        syncRecord(latest)
        const hash = latest.hashes[i]
        if (
          hash != null &&
          (latest.recorded[i] !== true || (receiptGuard !== undefined && !receiptProofs.current.has(hash)))
        )
          await settle(i, hash, latest)
        else if (latest.pending === i) await reconcile(i, latest)
      })
    } catch (failure) {
      journalFailure(failure)
    }
  }

  // Privy's wallet may become ready after the first render: offer the batch as long as nothing has started.
  const started = status.some((x) => x.at !== 'idle')
  useEffect(() => {
    if (
      batch !== null &&
      txs.length > 1 &&
      !record.batch &&
      record.sponsored !== true &&
      !started &&
      journalError === null &&
      !hasSavedJournal()
    ) {
      setRecord({ ...record, batch: true })
      setStatus([{ at: 'idle' }])
    }
  }, [batch !== null])

  // After a reload: follow any sent transaction to the end, and settle an uncertain one against the chain, instead of
  // offering to send either again.
  useEffect(() => {
    status.forEach((s, i) => {
      if (s.at === 'sent' || (s.at === 'uncertain' && s.checking === true)) void reconcileSaved(i)
    })
  }, [])

  const steps = record.batch || record.sponsored === true ? 1 : txs.length
  const allDone = status.length === steps && status.every((s) => s.at === 'recorded')
  useEffect(() => {
    if (!allDone || done.current || journalError !== null) return
    done.current = true
    void withWalletStepLock(navigator.locks, key, async () => {
      const latest = (await loadDurable(requireJournal)) ?? record
      if (latest.recorded.length !== steps || !latest.recorded.every((entry) => entry === true)) return
      if (!retainRecord) await persistDurable(null)
      onDone(latest.hashes.flatMap((hash) => (hash === null ? [] : [hash])))
    }).catch(journalFailure)
  }, [allDone])

  const runLocked = async (i: number) => {
    if (!writesOpen || journalError !== null) return
    // Another tab may have broadcast while this mounted instance still showed idle.
    const authoritative = (await loadDurable(requireJournal)) ?? record
    if (authoritative.aa != null) throw new Error('A user operation is saved for this action. Reload to reconcile it.')
    if (requireAtomic && batch === null) throw new Error(atomicRefusal(deployment.aa))
    syncRecord(authoritative)
    // A relay retry asks about the same saved operation before following its hash. Its nonce may have been
    // consumed by a replacement, in which case receipt-only polling would never discover the safe fallback.
    if (authoritative.sponsored === true) {
      if (authoritative.recorded[0] !== true) await runSponsored(authoritative)
      return
    }
    if (authoritative.hashes[i] != null) {
      await settle(i, authoritative.hashes[i]!, authoritative)
      return
    }
    if (authoritative.pending !== null) {
      if (authoritative.snapshot != null && authoritative.from != null)
        await reconcile(authoritative.pending, authoritative)
      return
    }
    if (
      sending.current ||
      !canSend ||
      address === undefined ||
      (owner !== undefined && owner.toLowerCase() !== address.toLowerCase()) ||
      authoritative.pending !== null ||
      retryAction(status[i] ?? { at: 'signing' }) !== 'send'
    )
      return
    if (authoritative.batch && batch === null) {
      set(i, { at: 'failed', error: 'This wallet cannot send a batch; send them one at a time.' })
      return
    }
    sending.current = true
    set(i, { at: 'signing' })
    // The nonce before the wallet is opened is what later tells a lost send from one that went out.
    const from = address as Hex
    let snapshot: SendSnapshot
    try {
      // A MON batch requires an already delegated wallet before capturing the send nonce.
      const reads = chainReads(from)
      snapshot = await guardedSnapshot(reads, sendGuard, authoritative.batch ? batch?.prepare : undefined)
    } catch (e) {
      set(i, {
        at: 'failed',
        error: `Your account could not be read from the chain, so nothing was sent. ${friendlyError(e)}`,
      })
      sending.current = false
      return
    }
    if (
      currentAccount.current.address?.toLowerCase() !== from.toLowerCase() ||
      currentAccount.current.chainId !== chain.id ||
      !currentAccount.current.canSend
    ) {
      set(i, {
        at: 'failed',
        error: 'The selected wallet or network changed before the send. Nothing was sent.',
      })
      sending.current = false
      return
    }
    const withPending = {
      ...authoritative,
      pending: i,
      snapshot,
      attempts: Object.assign([...(authoritative.attempts ?? [])], { [i]: snapshot.nonce }),
      from,
    }
    try {
      await persistDurable(withPending)
    } catch (failure) {
      sending.current = false
      setJournalError(friendlyError(failure))
      set(i, { at: 'uncertain', error: friendlyError(failure) })
      return
    }
    let hash: Hex
    try {
      if (authoritative.batch) {
        if (batch === null) throw new Error('This wallet cannot send a batch; send them one at a time.')
        hash = await batch(boardSteps, batchGasLimit(txs, sidequest), snapshot.nonce, stepsPrompt(boardSteps, true))
      } else {
        const tx = txs[i]!
        const gas = gasLimit(tx, sidequest)
        hash = await sendTransactionAsync(
          {
            ...walletStepRequest(tx, from, chain.id, snapshot.nonce),
            ...(gas === undefined ? {} : { gas }),
          },
          stepsPrompt([tx], tx.to.toLowerCase() === from.toLowerCase()),
        )
      }
    } catch (e) {
      sending.current = false
      if (walletRefused(e)) {
        await commit({ ...withPending, pending: null, snapshot: null })
        set(i, { at: 'failed', error: friendlyError(e) })
      } else {
        await reconcile(i, withPending)
      }
      return
    }
    const sent = {
      ...withPending,
      pending: null,
      snapshot: null,
      hashes: Object.assign([...authoritative.hashes], { [i]: hash }),
    }
    try {
      await persistDurable(sent)
    } catch (failure) {
      sending.current = false
      setJournalError(friendlyError(failure))
      set(i, { at: 'uncertain', error: friendlyError(failure) })
      return
    }
    set(i, { at: 'sent', hash })
    await settle(i, hash, sent)
    sending.current = false
  }

  const chooseSequential = async () => {
    if (!record.batch || sending.current || status.some((entry) => retryAction(entry) !== 'send')) return
    try {
      await withWalletStepLock(navigator.locks, key, async () => {
        const latest = (await loadDurable(requireJournal)) ?? record
        const next = sequentialJournal(latest)
        await commit(next)
        setStatus(txs.map((): Status => ({ at: 'idle' })))
      })
    } catch (failure) {
      journalFailure(failure)
    }
  }

  const run = async (i: number) => {
    try {
      await withWalletStepLock(navigator.locks, key, () =>
        address === undefined
          ? runLocked(i)
          : withWalletAccountLock(navigator.locks, chain.id, address, () => runLocked(i)),
      )
    } catch (failure) {
      sending.current = false
      setJournalError(friendlyError(failure))
      set(i, { at: 'uncertain', error: friendlyError(failure) })
    }
  }

  const next = status.findIndex((s) => s.at !== 'recorded')
  const current = status[next]
  // `autoStart`: the tap that showed these steps was the decision, so the wallet opens at once for a fresh operation
  // (never for one restored from a reload, which reconciles instead).
  // It waits for the sponsorship status, so a step Sidequest pays for never opens the wallet first.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (
      journalError !== null ||
      !autoStart ||
      autoStarted.current ||
      !sponsorship.settled ||
      started ||
      hasSavedJournal()
    )
      return
    if (canSponsor && record.sponsored !== true && !sponsorOff) return
    if (record.sponsored !== true && chainId !== chain.id) return
    autoStarted.current = true
    void run(0)
  }, [sponsorship.settled, record.sponsored])
  const busy =
    current !== undefined &&
    (current.at === 'signing' ||
      current.at === 'sent' ||
      (current.at === 'confirmed' && current.reportError === undefined))
  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])
  const safeToRestart =
    record.pending === null &&
    status.every(
      (entry) =>
        entry.at === 'idle' ||
        entry.at === 'recorded' ||
        (entry.at === 'failed' && (entry.hash === undefined || entry.reverted === true || entry.noEffect === true)),
    )
  useEffect(() => {
    onSafeToRestartChange?.(safeToRestart)
  }, [safeToRestart, onSafeToRestartChange])

  // Mainnet before launch (D16): whatever page handed these over, nothing is sent or signed.
  if (!writesOpen) return <LaunchNotice />

  if (chainId !== chain.id && record.sponsored !== true) {
    return (
      <div className="grid gap-2">
        <Button
          busy={switching === ''}
          onClick={async () => {
            setSwitching('')
            try {
              await switchChainAsync({ chainId: chain.id })
              setSwitching(null)
            } catch (e) {
              setSwitching(friendlyError(e))
            }
          }}
        >
          Switch your wallet to {chain.name}
        </Button>
        {switching !== null && switching !== '' && (
          <Alert variant="destructive">
            <AlertDescription>{switching}</AlertDescription>
          </Alert>
        )}
      </div>
    )
  }

  const rows = txs

  return (
    <div className="grid gap-3">
      {journalError !== null && (
        <Alert variant="destructive">
          <AlertDescription>{journalError}</AlertDescription>
        </Alert>
      )}
      {record.pending !== null && current?.at === 'uncertain' && (
        <div role="status" className="grid gap-2 rounded-xl bg-warning/14 px-4 py-3 text-sm text-warning-text">
          <p>{current.error}</p>
          {current.checking !== true && (
            <>
              {record.snapshot != null && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (record.pending !== null) void reconcileSaved(record.pending)
                  }}
                >
                  Check the chain again
                </Button>
              )}

              <Input
                aria-label="Transaction hash from wallet activity"
                value={pendingHash}
                onChange={(event) => setPendingHash(event.target.value)}
                placeholder="0x… transaction hash"
              />

              <Button
                variant="secondary"
                disabled={!/^0x[0-9a-fA-F]{64}$/.test(pendingHash)}
                onClick={() => {
                  void withWalletStepLock(navigator.locks, key, async () => {
                    const latest = (await loadDurable(requireJournal)) ?? record
                    syncRecord(latest)
                    const index = latest.pending
                    if (index === null) return
                    const hash = pendingHash as Hex
                    try {
                      await verifyTransaction(index, hash, latest)
                    } catch (failure) {
                      set(index, { at: 'uncertain', error: friendlyError(failure) })
                      return
                    }
                    await settle(index, hash, latest)
                  }).catch(journalFailure)
                }}
              >
                Check existing transaction
              </Button>
            </>
          )}
        </div>
      )}
      {notice !== null && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-x-2 rounded-xl bg-warning/14 px-4 py-3 text-sm leading-snug text-warning-text"
        >
          {notice.text}
          {notice.hash !== undefined && <TxLink hash={notice.hash} />}
        </p>
      )}
      {record.sponsored === true && current?.at === 'uncertain' && (
        <div role="status" className="grid gap-2 rounded-xl bg-warning/14 px-4 py-3 text-sm text-warning-text">
          <p>{current.error}</p>
          {current.checking !== true && (
            <Button variant="secondary" onClick={() => void run(0)}>
              Check again
            </Button>
          )}
        </div>
      )}
      <ItemGroup>
        {rows.map((tx, i) => {
          const s = status[record.batch || record.sponsored === true ? 0 : i] ?? { at: 'idle' }
          return (
            <Item key={`${i}-${tx.description}`} className="before:left-14">
              <StepIcon n={i + 1} s={s} />
              <ItemContent className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block text-base first-letter:uppercase',
                    s.at === 'idle' && i !== next && 'text-muted-foreground',
                  )}
                >
                  {tx.description}
                </span>
                {
                  <span className="flex flex-wrap items-center gap-x-2 text-ui text-muted-foreground">
                    {record.sponsored === true && SPONSORED_LABEL[s.at] !== undefined
                      ? SPONSORED_LABEL[s.at]
                      : record.batch && s.at === 'idle'
                        ? `Waiting · ${txs.length} steps as one transaction`
                        : s.at === 'uncertain' && s.checking === true
                          ? record.sponsored === true
                            ? 'Checking with Sidequest…'
                            : 'Checking the chain…'
                          : LABEL[s.at]}
                    {'hash' in s && s.hash !== undefined && <TxLink hash={s.hash} />}
                  </span>
                }
              </ItemContent>
            </Item>
          )
        })}
      </ItemGroup>
      {current?.at === 'failed' && (
        <Alert variant="destructive">
          <AlertDescription>{current.error}</AlertDescription>
        </Alert>
      )}
      {current?.at === 'confirmed' && current.reportError !== undefined && (
        <Alert variant="destructive">
          <AlertDescription>{current.reportError}</AlertDescription>
        </Alert>
      )}
      {!allDone && current !== undefined && current.at !== 'uncertain' && (
        <Button
          size="lg"
          busy={busy}
          disabled={
            (!canSend || (owner !== undefined && owner.toLowerCase() !== address?.toLowerCase())) &&
            retryAction(current) === 'send'
          }
          onClick={() => {
            if ((current.at === 'confirmed' && current.reportError !== undefined) || retryAction(current) === 'receipt')
              void reconcileSaved(next)
            else void run(next)
          }}
        >
          {current.at === 'confirmed' && current.reportError !== undefined
            ? 'Record it again'
            : current.at === 'failed'
              ? 'Try again'
              : record.sponsored === true
                ? txs.length > 1
                  ? 'Check the previous transaction'
                  : 'Check the previous transaction'
                : record.batch
                  ? `Confirm ${txs.length > 1 ? `all ${txs.length} as one transaction` : ''}`.trim()
                  : txs.length > 1
                    ? `Confirm step ${next + 1} of ${txs.length}`
                    : 'Confirm in your wallet'}
        </Button>
      )}
      {record.sponsored === true && (!started || (current?.at === 'failed' && record.sponsor == null)) && (
        <Button
          variant="link"
          size="sm"
          onClick={() => {
            void withWalletStepLock(navigator.locks, key, () => toWallet(null)).catch(journalFailure)
          }}
          className="justify-self-center"
        >
          Pay the gas yourself instead
        </Button>
      )}
      {record.batch && status.every((entry) => retryAction(entry) === 'send') && (
        <Button variant="link" size="sm" onClick={() => void chooseSequential()} className="justify-self-center">
          Send them one at a time instead
        </Button>
      )}
    </div>
  )
}

function StepIcon({ n, s }: { n: number; s: Status }) {
  if (s.at === 'recorded') {
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-success-text text-background">
        <Check aria-hidden className="size-3.5" strokeWidth={3} />
      </span>
    )
  }
  if (s.at === 'failed') {
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-destructive-text text-background">
        <X aria-hidden className="size-3.5" strokeWidth={3} />
      </span>
    )
  }
  if (s.at === 'signing' || s.at === 'sent' || s.at === 'confirmed' || (s.at === 'uncertain' && s.checking === true)) {
    return (
      <span
        aria-hidden
        className="size-6 shrink-0 animate-spin rounded-full border-[2.5px] border-accent border-t-primary"
      />
    )
  }
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-muted-foreground">
      {n}
    </span>
  )
}
