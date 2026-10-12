/**
 * Sending a SIDE trade durably (hard rule 9). A trade is saved before the wallet's first prompt, under one key per
 * wallet (`side-trade.ts`), so a reload or a crash after an uncertain send finds it: TxSteps remounts on the same
 * journal and reconciles it, and no second trade starts until this one is terminal.
 */
import * as sdk from '@sidequest/sdk'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { formatAmount } from '../../format.ts'
import { refreshBalances } from '../../query-refresh.ts'
import type { tradeAmounts } from '../../side-sheet.ts'
import {
  type SideTradeIntent,
  clearSideTrade,
  loadSideTrade,
  saveSideTrade,
  sideTradeKey,
  sideTradeTaskId,
  sideTradeUnstarted,
} from '../../side-trade.ts'
import { stakeContext } from '../../stake-context.ts'
import { friendlyError } from '../../txErrors.ts'
import { chain } from '../../wallet.ts'
import { TxSteps } from '../TxSteps.tsx'
import { withWalletStepLock } from '../txOperation.ts'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Button } from '../ui/button.tsx'

type Trade = SideTradeIntent['trade']

const MON = chain.nativeCurrency.symbol

const tradeLock = (key: string, work: () => Promise<void>) =>
  withWalletStepLock(navigator.locks, `side-trade:${key}`, work)

/** The trade saved for this wallet: read under the lock on mount, and again whenever the wallet changes. */
function useSavedTrade(key: string | null) {
  const [saved, setSaved] = useState<SideTradeIntent | null>(null)
  // A trade made here prompts at once; one recovered after a reload waits to be reconciled or confirmed.
  const [fresh, setFresh] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setSaved(null)
    setLoaded(false)
    setError(null)
    if (key === null) return
    let active = true
    void tradeLock(key, async () => {
      const found = await loadSideTrade(localStorage, key)
      if (!active) return
      setSaved(found)
      setFresh(false)
      setLoaded(true)
    }).catch((failure: unknown) => {
      if (active) setError(friendlyError(failure))
    })
    return () => {
      active = false
    }
  }, [key])
  return { saved, setSaved, fresh, setFresh, loaded, error }
}

export function useTradeSend(l: sdk.Launcher | null, address: `0x${string}` | undefined) {
  const ctx = stakeContext()
  const qc = useQueryClient()
  const key = l === null || address === undefined ? null : sideTradeKey(chain.id, l.router, address)
  const { saved, setSaved, fresh, setFresh, loaded, error: loadError } = useSavedTrade(key)
  const [done, setDone] = useState<{ trade: Trade; out: bigint } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const send = async (trade: Trade, amounts: NonNullable<ReturnType<typeof tradeAmounts>>) => {
    if (l === null || address === undefined || key === null) return
    setPreparing(true)
    setError(null)
    try {
      const deadline = Math.floor(Date.now() / 1000) + 600
      const input = { owner: address, side: trade, amountIn: amounts.amountIn, minOut: amounts.minOut, deadline }
      const txs = await sdk.launcherTransactions(ctx, l, input)
      const next: SideTradeIntent = {
        id: crypto.randomUUID(),
        trade,
        owner: address,
        txs,
        out: amounts.expectedOut.toString(),
        deadline,
      }
      await tradeLock(key, () => saveSideTrade(localStorage, key, next))
      setFresh(true)
      setSaved(next)
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setPreparing(false)
    }
  }
  /** The trade landed: clear it (only this one), then say what it returned. */
  const finish = () => {
    if (saved === null || key === null) return
    void tradeLock(key, async () => {
      if (!(await clearSideTrade(localStorage, key, saved.id)))
        throw new Error('A newer SIDE trade is saved in another tab; keep it for reconciliation.')
      setDone({ trade: saved.trade, out: BigInt(saved.out) })
      setSaved(null)
      void refreshBalances(qc)
    }).catch((failure: unknown) => setError(friendlyError(failure)))
  }
  /** Drop a saved trade that never reached the wallet or the bundler; anything sent is reconciled instead. */
  const discard = () => {
    if (saved === null || key === null) return
    void tradeLock(key, async () => {
      if (!(await sideTradeUnstarted(localStorage, saved)))
        throw new Error('This trade was sent. Wait for it to be confirmed before trading again.')
      if (!(await clearSideTrade(localStorage, key, saved.id)))
        throw new Error('A newer SIDE trade is saved in another tab; keep it for reconciliation.')
      setSaved(null)
    }).catch((failure: unknown) => setError(friendlyError(failure)))
  }
  return {
    saved,
    fresh,
    loaded,
    done,
    error: error ?? loadError,
    preparing,
    send,
    finish,
    discard,
    again: () => setDone(null),
    clearError: () => setError(null),
  }
}

/**
 * A saved trade until it is terminal: its steps on the same journal as when it was made, so an uncertain send is
 * reconciled rather than sent again, and Discard only while nothing has gone to the wallet or the bundler.
 */
export function SavedTrade({
  trade,
  owner,
  fresh,
  error,
  onBusyChange,
  onDone,
  onDiscard,
}: {
  trade: SideTradeIntent
  owner: `0x${string}`
  fresh: boolean
  error: string | null
  onBusyChange: (busy: boolean) => void
  onDone: () => void
  onDiscard: () => void
}) {
  const [safe, setSafe] = useState(false)
  const out = formatAmount(BigInt(trade.out), 18)
  return (
    <div className="grid gap-3">
      {!fresh && (
        <p className="text-ui text-pretty text-muted-foreground">
          {trade.trade === 'buy' ? `Your buy of about ${out} SIDE` : `Your sale for about ${out} ${MON}`} is unfinished.
          Finish or check it before another trade.
        </p>
      )}
      <TxSteps
        key={trade.id}
        taskId={sideTradeTaskId(trade.id)}
        txs={trade.txs}
        owner={owner}
        reportToBoard={false}
        allowSponsorship={false}
        requireJournal
        retainRecord
        verifyReceipt
        autoStart={fresh}
        sendGuard={() =>
          Date.now() / 1000 > trade.deadline ? 'This trade’s deadline passed. Discard it and quote again.' : null
        }
        onBusyChange={onBusyChange}
        onSafeToRestartChange={setSafe}
        onDone={onDone}
      />
      {safe && (
        <Button variant="link" className="justify-self-start" onClick={onDiscard}>
          Discard this trade
        </Button>
      )}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
