/**
 * The SIDE sheet's trade card. Buy or Sell, with "You pay" over "You get". Either side can be typed in; nad.fun's router
 * quotes the other. One posting bond is a chip away, and one button says what it does. The card is the same signed in
 * or out: signed out, its button signs in, and the sheet stays open.
 */
import { usePrivy } from '@privy-io/react-auth'
import * as sdk from '@sidequest/sdk'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { erc20Abi, parseUnits } from 'viem'
import { useBalance, useReadContract } from 'wagmi'
import { useBondPolicy } from '../../bond-policy.ts'
import { formatAmount } from '../../format.ts'
import { publicKey } from '../../queries.ts'
import { refreshBalances } from '../../query-refresh.ts'
import { type Edited, type SideTrade, fillText, sideTrade, tradeAmounts, wholeUp } from '../../side-sheet.ts'
import { stakeContext } from '../../stake-context.ts'
import { friendlyError } from '../../txErrors.ts'
import { chain, deployed, deployment, privyAppId, writesOpen } from '../../wallet.ts'
import { GasWarning, SWAP_GAS } from '../GasWarning.tsx'
import { AddressRow, Segmented } from '../kit.tsx'
import { AmountField } from '../money/AmountField.tsx'
import { usePrivyAuthenticated } from '../Privy.tsx'
import { TestnetFaucet } from '../TestnetFaucet.tsx'
import { TxSteps } from '../TxSteps.tsx'
import type { WalletStep } from '../txOperation.ts'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Button } from '../ui/button.tsx'
import { useAuth } from '../Wallet.tsx'

type Trade = 'buy' | 'sell'

const MON = chain.nativeCurrency.symbol

/** A typed amount, parsed a moment after typing stops; grouping commas and spaces are ignored. */
function useAmount(text: string): bigint | null {
  const [settled, setSettled] = useState(text)
  useEffect(() => {
    const t = setTimeout(() => setSettled(text), 300)
    return () => clearTimeout(t)
  }, [text])
  try {
    const v = parseUnits(settled.replace(/[,\s]/g, ''), 18)
    return v > 0n ? v : null
  } catch {
    return null
  }
}

/** Privy's login, or null without Privy or before it is ready. */
function usePrivyLogin(): (() => void) | null {
  if (privyAppId === '') return null
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- privyAppId is a build-time constant, so hook order never changes
  const { ready, login } = usePrivy()
  return ready ? () => login() : null
}

/** The wallet's MON and SIDE, and the most MON a buy may take: less gas, and less Monad's reserve once delegated. */
function useWallet(l: sdk.Launcher | null, address: `0x${string}` | undefined) {
  const ctx = stakeContext()
  const on = address !== undefined && l !== null
  const gas = useBalance({ address, chainId: chain.id, query: { enabled: on, refetchInterval: 15_000 } }).data?.value
  const side = useReadContract({
    address: l?.side,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address!],
    chainId: chain.id,
    query: { enabled: on, refetchInterval: 10_000 },
  }).data
  const delegated = useQuery({
    queryKey: publicKey('delegation', address),
    queryFn: async () => (await sdk.delegationOf(ctx.publicClient, address!)) !== null,
    enabled: on,
  }).data
  // A sale can pay its gas in USDC through the paymaster (ADR-0023); a buy carries MON, so it always pays in MON.
  const usdc = useReadContract({
    address: deployment.aa?.gasToken,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address!],
    chainId: chain.id,
    query: { enabled: address !== undefined && deployment.aa !== null, refetchInterval: 15_000 },
  }).data
  const cap =
    gas === undefined || delegated === undefined
      ? undefined
      : { max: sdk.nativeBuyCap({ balance: gas, gasCost: SWAP_GAS, delegated }), reserve: delegated }
  return { gas, side, usdc, cap }
}

/** What the card's one button says: what it would do, or what stands in the way. */
function ctaLabel(state: SideTrade, trade: Trade, amounts: ReturnType<typeof tradeAmounts>): string {
  if (state === 'closed') return 'Trading opens at launch'
  if (state === 'unavailable') return 'Not available on this network'
  if (state === 'sign-in') return `Sign in to ${trade}`
  if (state === 'connecting') return 'Connecting your wallet…'
  if (amounts === null) return trade === 'buy' ? 'Buy SIDE' : 'Sell SIDE'
  return trade === 'buy'
    ? `Buy ${formatAmount(amounts.expectedOut, 18)} SIDE`
    : `Sell ${formatAmount(amounts.amountIn, 18)} SIDE`
}

/** Why the amount paid is too much: Monad's reserve in an upgraded wallet, gas, or more SIDE than the wallet holds. */
function shortHint(trade: Trade, cap: { max: bigint; reserve: boolean } | undefined): string {
  if (trade === 'sell') return 'More SIDE than your wallet holds.'
  const max = `${formatAmount(cap?.max ?? 0n, 18)} ${MON}`
  return cap?.reserve === true
    ? `Monad keeps 10 ${MON} in upgraded wallets: up to ${max} now.`
    : `Up to ${max}: the rest of your wallet pays the gas.`
}

/**
 * The card's form state: Buy or Sell, which side was typed, and the router's quote for the other side, with what the
 * trade would send. A shortfall pre-fills "You get" on Buy.
 */
function useTradeForm(l: sdk.Launcher | null, need: bigint | null) {
  const ctx = stakeContext()
  const [trade, setTrade] = useState<Trade>('buy')
  const [edited, setEdited] = useState<Edited>(need === null ? 'pay' : 'get')
  const [text, setText] = useState(need === null ? '' : fillText(wholeUp(need)))
  const typed = useAmount(text)
  const quote = useQuery({
    queryKey: publicKey('launcher-quote', l?.router, trade, edited, typed?.toString()),
    queryFn: () =>
      edited === 'pay' ? sdk.launcherQuote(ctx, l!, trade, typed!) : sdk.launcherQuoteIn(ctx, l!, trade, typed!),
    enabled: deployed && l !== null && typed !== null,
    retry: false,
  })
  const computed = quote.data === undefined ? '' : formatAmount(quote.data, 18)
  return {
    trade,
    edited,
    typed,
    quote,
    amounts: tradeAmounts({ edited, typed, quoted: quote.data }),
    quoting: typed !== null && quote.isFetching,
    payText: edited === 'pay' ? text : computed,
    getText: edited === 'get' ? text : computed,
    type: (side: Edited, next: string) => {
      setEdited(side)
      setText(next)
    },
    setTrade: (next: Trade) => {
      setTrade(next)
      setEdited('pay')
      setText('')
    },
    clear: () => {
      setEdited('pay')
      setText('')
    },
  }
}

/** A finished trade: what it returned, then more of the same or done. */
function TradeDone({
  done,
  onAgain,
  onClose,
}: {
  done: { trade: Trade; out: bigint }
  onAgain: () => void
  onClose: () => void
}) {
  return (
    <div className="grid justify-items-center gap-3 rounded-lg bg-muted/50 px-4 py-5 text-center">
      <span className="grid size-10 place-items-center rounded-full bg-success/15 text-success-text">
        <Check
          aria-hidden
          strokeWidth={2.5}
          className="size-5 motion-safe:animate-[check-in_300ms_var(--ease-out-strong)]"
        />
      </span>
      <output className="text-base font-semibold tabular-nums">
        {done.trade === 'buy'
          ? `Bought about ${formatAmount(done.out, 18)} SIDE`
          : `Sold for about ${formatAmount(done.out, 18)} ${MON}`}
      </output>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onAgain}>
          {done.trade === 'buy' ? 'Buy more' : 'Sell more'}
        </Button>
        <Button onClick={onClose}>Done</Button>
      </div>
    </div>
  )
}

/** Sending a trade: its steps while the wallet confirms, then what it returned. */
function useTradeSend(l: sdk.Launcher | null, address: `0x${string}` | undefined) {
  const ctx = stakeContext()
  const qc = useQueryClient()
  const [steps, setSteps] = useState<{ id: string; txs: WalletStep[]; trade: Trade; out: bigint } | null>(null)
  const [done, setDone] = useState<{ trade: Trade; out: bigint } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const send = async (trade: Trade, amounts: NonNullable<ReturnType<typeof tradeAmounts>>) => {
    if (l === null || address === undefined) return
    setPreparing(true)
    setError(null)
    try {
      const deadline = Math.floor(Date.now() / 1000) + 600
      const input = { owner: address, side: trade, amountIn: amounts.amountIn, minOut: amounts.minOut, deadline }
      const txs = await sdk.launcherTransactions(ctx, l, input)
      const id = `nadfun:${trade}:${address}:${amounts.amountIn}:${Date.now()}`
      setSteps({ id, txs, trade, out: amounts.expectedOut })
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setPreparing(false)
    }
  }
  const finish = () => {
    void refreshBalances(qc)
    if (steps !== null) setDone({ trade: steps.trade, out: steps.out })
    setSteps(null)
  }
  return { steps, done, error, preparing, send, finish, again: () => setDone(null), clearError: () => setError(null) }
}

export function TradeCard({
  need,
  onBusyChange,
  onSignIn,
  onClose,
}: {
  /** SIDE still to buy: the card opens on Buy with "You get" filled in. */
  need: bigint | null
  onBusyChange: (busy: boolean) => void
  /** A sign-in starts here: the sheet keeps it from sending the first app page to Welcome. */
  onSignIn: () => void
  onClose: () => void
}) {
  const l = deployment.launcher
  const { address } = useAuth()
  const form = useTradeForm(l, need)
  const sending = useTradeSend(l, address)
  // A card that leaves mid-request (the sheet closed) must not leave the sheet non-modal.
  useEffect(() => () => onBusyChange(false), [onBusyChange])
  if (sending.done !== null)
    return (
      <TradeDone
        done={sending.done}
        onClose={onClose}
        onAgain={() => {
          sending.again()
          form.clear()
        }}
      />
    )
  if (sending.steps !== null && address !== undefined)
    return (
      <TxSteps
        taskId={sending.steps.id}
        txs={sending.steps.txs}
        owner={address}
        reportToBoard={false}
        allowSponsorship={false}
        autoStart
        onBusyChange={onBusyChange}
        onDone={() => {
          sending.finish()
          form.clear()
        }}
      />
    )
  return <TradeForm l={l} address={address} form={form} sending={sending} onSignIn={onSignIn} />
}

/** Whether the wallet can pay this trade's gas: MON for a buy; MON, or USDC through the paymaster, for a sale. */
function gasReady(trade: Trade, wallet: ReturnType<typeof useWallet>): boolean {
  if (wallet.gas === undefined || wallet.gas >= SWAP_GAS) return true
  const aa = deployment.aa
  if (trade === 'buy' || aa === null || aa.paymaster === null || wallet.usdc === undefined) return false
  return wallet.usdc >= aa.maxCostPerOp
}

/** What the form shows, from the trade state, the form and the wallet: kept out of the component to keep it plain. */
function formView(state: SideTrade, form: ReturnType<typeof useTradeForm>, wallet: ReturnType<typeof useWallet>) {
  const { trade, amounts } = form
  const max = trade === 'buy' ? wallet.cap?.max : wallet.side
  const short = amounts !== null && max !== undefined && amounts.amountIn > max
  const out = trade === 'buy' ? 'SIDE' : MON
  return {
    open: state !== 'closed' && state !== 'unavailable',
    max: state === 'trade' ? max : undefined,
    short: short ? shortHint(trade, wallet.cap) : null,
    noGas: state === 'trade' && !gasReady(trade, wallet),
    ready: state === 'trade' && amounts !== null && !short && !form.quoting,
    floor:
      amounts === null
        ? 'Through nad.fun’s router, at most 1% below the quote.'
        : `At least ${formatAmount(amounts.minOut, 18)} ${out}, through nad.fun’s router.`,
  }
}

/** The form: Buy or Sell, the two fields, the floor of the quote, and the one button (or what it takes to use it). */
function TradeForm({
  l,
  address,
  form,
  sending,
  onSignIn,
}: {
  l: sdk.Launcher | null
  address: `0x${string}` | undefined
  form: ReturnType<typeof useTradeForm>
  sending: ReturnType<typeof useTradeSend>
  onSignIn: () => void
}) {
  const state = sideTrade({ writesOpen, launcher: l !== null, address, authenticated: usePrivyAuthenticated() })
  const wallet = useWallet(l, address)
  const { trade, amounts } = form
  const view = formView(state, form, wallet)
  return (
    <div className="grid gap-3">
      <Segmented
        label="Buy or sell SIDE"
        value={trade}
        options={[
          ['buy', 'Buy'],
          ['sell', 'Sell'],
        ]}
        onChange={(next) => {
          if (next !== trade) form.setTrade(next)
          sending.clearError()
        }}
        className="w-full"
      />
      <div className="grid gap-1.5 rounded-xl bg-muted/60 p-1.5">
        <PayField form={form} side={l?.side ?? null} open={view.open} max={view.max} short={view.short} />
        <GetField form={form} side={l?.side ?? null} open={view.open} />
      </div>
      <p className="text-ui text-pretty text-muted-foreground tabular-nums">{view.floor}</p>
      {view.noGas && address !== undefined ? (
        <div className="grid gap-2">
          <GasWarning
            mon={wallet.gas}
            usdc={wallet.usdc}
            allowUsdc={trade === 'sell'}
            action={trade === 'buy' ? 'A buy' : 'A sale'}
            need={SWAP_GAS}
          />
          <AddressRow value={address} short copyLabel="Copy your address" />
        </div>
      ) : (
        <TradeButton
          state={state}
          label={ctaLabel(state, trade, amounts)}
          ready={view.ready}
          busy={sending.preparing}
          onSignIn={onSignIn}
          onSend={() => {
            if (amounts !== null) void sending.send(trade, amounts)
          }}
        />
      )}
      {sending.error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{sending.error}</AlertDescription>
        </Alert>
      )}
      {state === 'trade' && address !== undefined && <TestnetFaucet address={address} compact />}
    </div>
  )
}

/** The card's one button: it signs in when nobody is, and sends the trade once one is ready. */
function TradeButton({
  state,
  label,
  ready,
  busy,
  onSignIn,
  onSend,
}: {
  state: SideTrade
  label: string
  ready: boolean
  busy: boolean
  onSignIn: () => void
  onSend: () => void
}) {
  const login = usePrivyLogin()
  const signIn = state === 'sign-in'
  return (
    <Button
      size="lg"
      className="w-full"
      busy={busy || state === 'connecting'}
      disabled={signIn ? login === null : !ready}
      onClick={() => {
        if (signIn) {
          onSignIn()
          login?.()
        } else onSend()
      }}
    >
      {label}
    </Button>
  )
}

/** "You pay": typed, or quoted from "You get"; Max and a shortfall for a connected wallet. */
function PayField({
  form,
  side,
  open,
  max,
  short,
}: {
  form: ReturnType<typeof useTradeForm>
  side: `0x${string}` | null
  open: boolean
  /** The most the wallet can pay, for Max; undefined signed out. */
  max: bigint | undefined
  /** Why the amount is too much, or null. */
  short: string | null
}) {
  const buy = form.trade === 'buy'
  const canMax = max !== undefined && max > 0n
  return (
    <AmountField
      label="You pay"
      value={form.payText}
      onChange={(next) => form.type('pay', next)}
      token={buy ? null : side}
      symbol={buy ? MON : 'SIDE'}
      balance={max === undefined ? undefined : formatAmount(max, 18)}
      onMax={canMax ? () => form.type('pay', fillText(max)) : undefined}
      pending={form.edited === 'get' && form.quoting}
      tone={short === null ? 'neutral' : 'warning'}
      hint={short ?? undefined}
      disabled={!open}
    />
  )
}

/** "You get": typed, or quoted from "You pay"; on Buy, one posting bond a chip away. */
function GetField({
  form,
  side,
  open,
}: {
  form: ReturnType<typeof useTradeForm>
  side: `0x${string}` | null
  open: boolean
}) {
  const bond = useBondPolicy().data?.minimumCreatorBond
  const buy = form.trade === 'buy'
  const failed = form.typed !== null && form.quote.isError
  const chip =
    buy && bond !== undefined ? (
      <AmountChip onClick={() => form.type('get', fillText(bond))}>1 bond</AmountChip>
    ) : undefined
  return (
    <AmountField
      label="You get"
      value={form.getText}
      onChange={(next) => form.type('get', next)}
      token={buy ? side : null}
      symbol={buy ? 'SIDE' : MON}
      chips={chip}
      pending={form.edited === 'pay' && form.quoting}
      hint={failed ? 'nad.fun can’t quote this amount right now.' : undefined}
      tone={failed ? 'destructive' : 'neutral'}
      disabled={!open}
    />
  )
}

/** A quick amount beside a field's label: one posting bond. */
function AmountChip({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex min-h-7 items-center rounded-full bg-muted px-2.5 text-xs font-medium text-foreground transition-[background-color,scale] duration-(--dur-fast) active:scale-[0.96] disabled:opacity-50 pointer-coarse:min-h-11 [@media(hover:hover)]:hover:bg-muted/70"
    >
      {children}
    </button>
  )
}
