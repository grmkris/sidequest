/**
 * Sending a SIDE trade durably (hard rule 9). A trade is saved before the wallet's first prompt, under one key per
 * wallet (`side-trade.ts`), so a reload or a crash after an uncertain send finds it: TxSteps remounts on the same
 * journal and reconciles it, and no second trade starts until this one is terminal. A trade that fails with nothing in
 * flight (reverted, refused, never sent) is over: it is cleared and the card quotes afresh, never resending the old one.
 */
import * as sdk from '@sidequest/sdk'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { formatAmount } from '../../format.ts'
import { refreshBalances } from '../../query-refresh.ts'
import { type RevertCause, type RevertReads, tradeRevertCause } from '../../side-revert.ts'
import { quoteHolds, type tradeAmounts } from '../../side-sheet.ts'
import { USDC_DECIMALS, usdcMaxText } from '../../side-usdc.ts'
import {
  type SideTradeIntent,
  clearSideTrade,
  loadSideTrade,
  saveSideTrade,
  sideTradeEnded,
  sideTradeKey,
  sideTradeTaskId,
  sideTradeUnstarted,
} from '../../side-trade.ts'
import { stakeContext } from '../../stake-context.ts'
import { friendlyError } from '../../txErrors.ts'
import { chain, deployment } from '../../wallet.ts'
import { TxLink } from '../kit.tsx'
import { TxSteps } from '../TxSteps.tsx'
import { withWalletStepLock } from '../txOperation.ts'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Button } from '../ui/button.tsx'

type Trade = SideTradeIntent['trade']

/**
 * A trade that ended without happening: the trade, its reverted transaction if it reached the chain, the wallet's
 * words if it never did, and once read from the chain, what made it revert (`undefined` while still being read).
 */
export interface TradeEnded {
  intent: SideTradeIntent
  reverted: `0x${string}` | null
  reason: string | null
  cause?: RevertCause | null
}

const NEWER = 'A newer SIDE trade is saved in another tab; keep it for reconciliation.'

const MON = chain.nativeCurrency.symbol

const tradeLock = (key: string, work: () => Promise<void>) =>
  withWalletStepLock(navigator.locks, `side-trade:${key}`, work)

/**
 * The trade saved for this wallet: read under the lock on mount, and again whenever the wallet changes. One that ended
 * without happening is cleared there and then, so a reload after a revert lands on a fresh quote, not on the old trade.
 */
function useSavedTrade(key: string | null) {
  const [saved, setSaved] = useState<SideTradeIntent | null>(null)
  // A trade made here prompts at once; one recovered after a reload waits to be reconciled or confirmed.
  const [fresh, setFresh] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ended, setEnded] = useState<TradeEnded | null>(null)
  useEffect(() => {
    setSaved(null)
    setLoaded(false)
    setError(null)
    setEnded(null)
    if (key === null) return
    let active = true
    void tradeLock(key, async () => {
      let found = await loadSideTrade(localStorage, key)
      const end = found === null ? null : await sideTradeEnded(localStorage, found)
      if (found !== null && end !== null && (await clearSideTrade(localStorage, key, found.id))) {
        if (active && end.tried) setEnded({ intent: found, reverted: end.reverted, reason: null })
        found = null
      }
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
  return { saved, setSaved, fresh, setFresh, loaded, error, ended, setEnded }
}

/** The chain reads behind a revert's cause, through the app's public client. */
function revertReads(l: sdk.Launcher, owner: `0x${string}`): RevertReads {
  const client = stakeContext().publicClient
  return {
    landed: async (hash) => {
      const receipt = await client.getTransactionReceipt({ hash })
      const block = await client.getBlock({ blockNumber: receipt.blockNumber })
      return { block: receipt.blockNumber, timestamp: block.timestamp }
    },
    amountOut: (side, amountIn, blockNumber) =>
      client.readContract({
        address: l.router,
        abi: sdk.nadRouterAbi,
        functionName: 'getAmountOut',
        args: [l.side, amountIn, side === 'buy'],
        blockNumber,
      }),
    balance: (blockNumber) => client.getBalance({ address: owner, blockNumber }),
    delegated: async () => (await sdk.delegationOf(client, owner)) !== null,
  }
}

/** Once a reverted trade is back on the form, read from the chain what made it revert, for the notice to name. */
function useRevertCause(
  l: sdk.Launcher | null,
  ended: TradeEnded | null,
  setEnded: (update: (now: TradeEnded | null) => TradeEnded | null) => void,
) {
  useEffect(() => {
    if (l === null || ended === null || ended.reverted === null || ended.cause !== undefined) return
    const { intent, reverted } = ended
    void tradeRevertCause(revertReads(l, intent.owner), intent, reverted).then((cause) =>
      setEnded((now) => (now !== null && now.reverted === reverted ? { ...now, cause } : now)),
    )
  }, [l, ended?.reverted])
}

type Amounts = NonNullable<ReturnType<typeof tradeAmounts>>

const STALE =
  'The price moved past your slippage since this quote, so nothing was sent. Check the new amounts, then try again.'

/**
 * A trade paid or paid out in USDC: every leg re-checked at the price now, then the route's one batch (Permit2
 * approvals, the pool's swap, nad.fun), saved with what it may spend.
 */
async function prepareUsdcTrade(
  ctx: ReturnType<typeof stakeContext>,
  l: sdk.Launcher,
  owner: `0x${string}`,
  amounts: Amounts,
  plan: sdk.UsdcPlan,
): Promise<SideTradeIntent> {
  if (deployment.nativeSwap === null) throw new Error('Paying with USDC isn’t available on this network.')
  const route = { swap: deployment.nativeSwap, launcher: l }
  if (!(await sdk.usdcPlanHolds(ctx, route, plan))) throw new Error(STALE)
  const deadline = Math.floor(Date.now() / 1000) + 600
  const txs = await sdk.usdcPlanTransactions(ctx, route, plan, { owner, deadline })
  return {
    id: crypto.randomUUID(),
    trade: plan.trade,
    owner,
    txs,
    out: amounts.expectedOut.toString(),
    deadline,
    payWith: 'usdc',
    ...(plan.trade === 'buy' ? { paid: plan.usdcMax.toString() } : {}),
  }
}

/**
 * The trade to save, built against the router's price now: the quote on screen may be a while old, so a trade whose
 * floor no longer holds stops here, before the wallet opens and before it costs any gas.
 */
async function prepareTrade(
  ctx: ReturnType<typeof stakeContext>,
  l: sdk.Launcher,
  input: { owner: `0x${string}`; trade: Trade; amounts: Amounts; plan: sdk.UsdcPlan | null },
): Promise<SideTradeIntent> {
  const { owner, trade, amounts, plan } = input
  if (plan !== null) return prepareUsdcTrade(ctx, l, owner, amounts, plan)
  if (!quoteHolds(amounts, await sdk.launcherQuote(ctx, l, trade, amounts.amountIn))) throw new Error(STALE)
  const deadline = Math.floor(Date.now() / 1000) + 600
  const call = { owner, side: trade, amountIn: amounts.amountIn, minOut: amounts.minOut, deadline }
  const txs = await sdk.launcherTransactions(ctx, l, call)
  return { id: crypto.randomUUID(), trade, owner, txs, out: amounts.expectedOut.toString(), deadline }
}

export function useTradeSend(l: sdk.Launcher | null, address: `0x${string}` | undefined) {
  const ctx = stakeContext()
  const qc = useQueryClient()
  const key = l === null || address === undefined ? null : sideTradeKey(chain.id, l.router, address)
  const { saved, setSaved, fresh, setFresh, loaded, error: loadError, ended, setEnded } = useSavedTrade(key)
  useRevertCause(l, ended, setEnded)
  const [done, setDone] = useState<{ trade: Trade; out: bigint; payWith?: 'usdc' } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const send = async (trade: Trade, amounts: Amounts, plan: sdk.UsdcPlan | null = null) => {
    if (l === null || address === undefined || key === null) return
    setPreparing(true)
    setError(null)
    setEnded(null)
    try {
      const next = await prepareTrade(ctx, l, { owner: address, trade, amounts, plan })
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
      if (!(await clearSideTrade(localStorage, key, saved.id))) throw new Error(NEWER)
      setDone({
        trade: saved.trade,
        out: BigInt(saved.out),
        ...(saved.payWith === undefined ? {} : { payWith: saved.payWith }),
      })
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
      if (!(await clearSideTrade(localStorage, key, saved.id))) throw new Error(NEWER)
      setSaved(null)
    }).catch((failure: unknown) => setError(friendlyError(failure)))
  }
  /**
   * The trade failed with nothing in flight: it is over. Clear it and go back to the form, which quotes afresh, saying
   * what happened. Its old floor and deadline are never sent again.
   */
  const failed = (reason: string) => {
    if (saved === null || key === null) return
    const trade = saved
    void tradeLock(key, async () => {
      const end = await sideTradeEnded(localStorage, trade)
      if (end === null || !end.tried) return
      if (!(await clearSideTrade(localStorage, key, trade.id))) throw new Error(NEWER)
      setEnded({ intent: trade, reverted: end.reverted, reason })
      setSaved(null)
      void refreshBalances(qc)
    }).catch((failure: unknown) => setError(friendlyError(failure)))
  }
  return {
    saved,
    fresh,
    loaded,
    done,
    error: error ?? loadError,
    preparing,
    ended,
    send,
    finish,
    discard,
    failed,
    again: () => setDone(null),
    clearError: () => {
      setError(null)
      setEnded(null)
    },
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
  onFailure,
}: {
  trade: SideTradeIntent
  owner: `0x${string}`
  fresh: boolean
  error: string | null
  onBusyChange: (busy: boolean) => void
  onDone: () => void
  onDiscard: () => void
  onFailure: (reason: string) => void
}) {
  const [safe, setSafe] = useState(false)
  const buy = trade.trade === 'buy'
  const usdc = trade.payWith === 'usdc'
  return (
    <div className="grid gap-3">
      <SavedTradeHeading trade={trade} fresh={fresh} />
      <TxSteps
        key={trade.id}
        taskId={sideTradeTaskId(trade.id)}
        txs={trade.txs}
        owner={owner}
        reportToBoard={false}
        allowSponsorship={false}
        requireJournal
        requireAtomic={usdc}
        retainRecord
        verifyReceipt
        autoStart={fresh}
        sendGuard={() =>
          Date.now() / 1000 > trade.deadline ? 'This trade’s deadline passed. Discard it and quote again.' : null
        }
        onBusyChange={onBusyChange}
        onSafeToRestartChange={setSafe}
        onFailure={onFailure}
        onDone={onDone}
        presentation="inline"
        labels={{
          idle: 'Not sent yet',
          signing: 'Confirm in your wallet…',
          sent: buy ? 'Buying on nad.fun…' : 'Selling on nad.fun…',
          confirmed: 'Confirmed',
          recorded: 'Confirmed',
          failed: 'Didn’t go through',
        }}
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

/** What a saved trade is and how it goes: its amount, then its route (or, recovered after a reload, that it's pending). */
function SavedTradeHeading({ trade, fresh }: { trade: SideTradeIntent; fresh: boolean }) {
  const buy = trade.trade === 'buy'
  const usdc = trade.payWith === 'usdc'
  const out = formatAmount(BigInt(trade.out), !buy && usdc ? USDC_DECIMALS : 18)
  const route = usdc
    ? buy
      ? `For up to ${usdcMaxText(BigInt(trade.paid ?? '0'))} USDC, through Uniswap and nad.fun in one step.`
      : 'Through nad.fun and Uniswap in one step.'
    : buy
      ? `For ${formatAmount(BigInt(trade.txs[0]?.value ?? '0'), 18)} ${MON}, through nad.fun.`
      : 'Through nad.fun, from your wallet.'
  return (
    <div className="grid gap-0.5">
      <p className="text-base font-semibold text-pretty tabular-nums">
        {buy ? `Buying about ${out} SIDE` : `Selling SIDE for about ${out} ${usdc ? 'USDC' : MON}`}
      </p>
      <p className="text-ui text-pretty text-muted-foreground tabular-nums">
        {fresh ? route : 'Started earlier and not settled yet. You can trade again once it settles.'}
      </p>
    </div>
  )
}

/** What made a trade revert, in a sentence: the cause the chain shows, or only that it reverted. */
const REVERTED: Record<RevertCause, string> = {
  price: 'the price moved more than your slippage before it was mined',
  deadline: 'it was mined after its 10-minute deadline',
  reserve: `Monad keeps 10 ${MON} in upgraded wallets, and this buy would have left less`,
}

/**
 * Why the last trade didn't happen, above a fresh quote. A revert spent gas, so it reads as a warning, with its cause
 * and transaction; a trade the wallet never sent (cancelled, refused) changed nothing and reads plainly.
 */
export function TradeEndedNotice({ ended }: { ended: TradeEnded }) {
  const buy = ended.intent.trade === 'buy'
  if (ended.reverted === null)
    return (
      <output className="block rounded-xl bg-muted/60 px-4 py-3 text-sm leading-snug text-pretty">
        {ended.reason ?? `Your last ${buy ? 'buy' : 'sale'} wasn’t sent, so nothing changed.`}
      </output>
    )
  const why = ended.cause == null ? 'reverted on the chain' : `reverted: ${REVERTED[ended.cause]}`
  return (
    <output className="flex flex-wrap items-center gap-x-2 rounded-xl bg-warning/14 px-4 py-3 text-sm leading-snug text-pretty text-warning-text">
      <span>
        Your last {buy ? 'buy' : 'sale'} {why}. Nothing was {buy ? 'bought' : 'sold'}; only its gas was spent. The
        amounts below are a fresh quote.
      </span>
      <TxLink hash={ended.reverted} />
    </output>
  )
}
