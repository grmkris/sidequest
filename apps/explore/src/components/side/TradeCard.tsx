/**
 * The SIDE sheet's trade card. Buy or Sell, with "You pay" over "You get". Either side can be typed in; the other is
 * the quote, from nad.fun's router, or on mainnet, paying or paid out in USDC, from one route through the MON/USDC pool
 * (useTradeForm.ts). One posting bond is a chip away, and one button says what it does. The card is the same signed
 * in or out: signed out, its button signs in, and the sheet stays open.
 */
import { usePrivy } from '@privy-io/react-auth'
import * as sdk from '@sidequest/sdk'
import { useQuery } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { useEffect } from 'react'
import { erc20Abi } from 'viem'
import { useBalance, useReadContract } from 'wagmi'
import { formatAmount } from '../../format.ts'
import { publicKey } from '../../queries.ts'
import { IMPACT_HIGH, type SideTrade, sideTrade, type tradeAmounts } from '../../side-sheet.ts'
import { USDC_DECIMALS, usdcBuyCap, usdcTexts } from '../../side-usdc.ts'
import { stakeContext } from '../../stake-context.ts'
import { chain, deployment, getSideLink, isMainnet, privyAppId, writesOpen } from '../../wallet.ts'
import { GasWarning, SWAP_GAS } from '../GasWarning.tsx'
import { AddressRow, Segmented } from '../kit.tsx'
import { approxUsd, useMonPrice, usdValue } from '../../usd.ts'
import { useDelegatorAuthorization, usePrivyAuthenticated } from '../Privy.tsx'
import { TestnetFaucet } from '../TestnetFaucet.tsx'
import type { CoinChoice } from './TokenPicker.tsx'
import { TradeDetails } from './TradeDetails.tsx'
import { TradeFields } from './TradeFields.tsx'
import { SavedTrade, TradeEndedNotice, useTradeSend } from './TradeSend.tsx'
import { useTradeForm } from './useTradeForm.ts'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Button } from '../ui/button.tsx'
import { useAuth } from '../Wallet.tsx'

type Trade = 'buy' | 'sell'

const MON = chain.nativeCurrency.symbol

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
  const delegate = useQuery({
    queryKey: publicKey('delegate-of', address),
    queryFn: () => sdk.delegationOf(ctx.publicClient, address!),
    enabled: on,
  }).data
  const delegated = delegate === undefined ? undefined : delegate !== null
  // One batch (a USDC trade) needs the configured DeleGator, or a Privy wallet that can sign the upgrade.
  const authorize = useDelegatorAuthorization(address)
  const batches =
    authorize !== null || (delegate != null && delegate.toLowerCase() === deployment.delegation.delegator.toLowerCase())
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
  return { gas, side, usdc, cap, batches }
}

const USDC_REFUSAL =
  'Paying with USDC needs your Sidequest wallet: this wallet can’t send the swap and the trade as one step.'

/**
 * MON or USDC for the trade's coin side: USDC only where the network routes it (mainnet's MON/USDC pool, with the
 * USDC paymaster), and refused, with why, for a signed-in wallet that can't send one batch.
 */
function coinChoices(address: string | undefined, wallet: ReturnType<typeof useWallet>): CoinChoice[] | null {
  const s = deployment.nativeSwap
  if (s === null || deployment.aa?.paymaster == null) return null
  return [
    {
      coin: 'mon',
      token: null,
      symbol: MON,
      balance: wallet.gas === undefined ? undefined : formatAmount(wallet.gas, 18),
      refusal: null,
    },
    {
      coin: 'usdc',
      token: s.quote,
      symbol: 'USDC',
      balance: wallet.usdc === undefined ? undefined : formatAmount(wallet.usdc, USDC_DECIMALS),
      refusal: address !== undefined && !wallet.batches ? USDC_REFUSAL : null,
    },
  ]
}

/**
 * A USDC trade's shortfall: a buy keeps twice the gas ceiling for the paymaster, which charges after the swap; a sale
 * pays its gas in USDC too.
 */
function usdcShort(trade: Trade, max: bigint | undefined, wallet: ReturnType<typeof useWallet>): string {
  const keep = formatAmount(2n * (deployment.aa?.maxCostPerOp ?? 0n), USDC_DECIMALS)
  if (trade === 'sell') return `A sale into USDC pays its gas in USDC: keep at least ${keep} USDC.`
  if (max === undefined || max === 0n) return `Add USDC to buy with it: a buy keeps ${keep} USDC for its gas.`
  return `Up to ${formatAmount(max, USDC_DECIMALS)} USDC: ${keep} USDC stays for the gas.`
}

/** What the card's one button says: what it would do, or what stands in the way. */
function ctaLabel(
  state: SideTrade,
  trade: Trade,
  amounts: ReturnType<typeof tradeAmounts>,
  impact: number | null,
): string {
  if (state === 'closed') return 'Trading opens at launch'
  if (state === 'unavailable') return 'Not available on this network'
  if (state === 'sign-in') return `Sign in to ${trade}`
  if (state === 'connecting') return 'Connecting your wallet…'
  if (amounts === null) return trade === 'buy' ? 'Buy SIDE' : 'Sell SIDE'
  const anyway = impact !== null && impact >= IMPACT_HIGH ? ' anyway' : ''
  return trade === 'buy'
    ? `Buy ${formatAmount(amounts.expectedOut, 18)} SIDE${anyway}`
    : `Sell ${formatAmount(amounts.amountIn, 18)} SIDE${anyway}`
}

/** Why the amount paid is too much: Monad's reserve in an upgraded wallet, gas, or more SIDE than the wallet holds. */
function shortHint(trade: Trade, cap: { max: bigint; reserve: boolean } | undefined): string {
  if (trade === 'sell') return 'More SIDE than your wallet holds.'
  if (cap?.max === 0n) return cantBuy(cap.reserve)
  const max = `${formatAmount(cap?.max ?? 0n, 18)} ${MON}`
  return cap?.reserve === true
    ? `Monad keeps 10 ${MON} in upgraded wallets: up to ${max} now.`
    : `Up to ${max}: the rest of your wallet pays the gas.`
}

/** A wallet with no MON to spend on a buy: why, and what it can do instead. */
function cantBuy(reserve: boolean): string {
  const why = reserve
    ? `Monad keeps 10 ${MON} in upgraded wallets, so this one can’t buy yet.`
    : `A buy is paid in ${MON}.`
  const instead = isMainnet
    ? getSideLink === null
      ? ''
      : ' Or buy on nad.fun from a wallet of your own and send the SIDE here.'
    : ' Or claim free test SIDE below.'
  return `${why} Add ${MON} to buy here.${instead}`
}

/** A finished trade: what it returned, then more of the same or done. */
function TradeDone({
  done,
  onAgain,
  onClose,
}: {
  done: { trade: Trade; out: bigint; payWith?: 'usdc' | undefined }
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
          : done.payWith === 'usdc'
            ? `Sold for about ${formatAmount(done.out, USDC_DECIMALS)} USDC`
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
  if (sending.saved !== null && address !== undefined)
    return (
      <SavedTrade
        trade={sending.saved}
        owner={address}
        fresh={sending.fresh}
        error={sending.error}
        onBusyChange={onBusyChange}
        onDone={() => {
          sending.finish()
          form.clear()
        }}
        onDiscard={sending.discard}
        onFailure={sending.failed}
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

/** The most the wallet can pay: MON less gas (and the reserve), USDC less twice the gas ceiling, or its SIDE. */
function tradeMax(form: ReturnType<typeof useTradeForm>, wallet: ReturnType<typeof useWallet>): bigint | undefined {
  if (form.trade === 'sell') return wallet.side
  if (form.coin === 'mon') return wallet.cap?.max
  return wallet.usdc === undefined ? undefined : usdcBuyCap(wallet.usdc, deployment.aa?.maxCostPerOp ?? 0n)
}

/**
 * Whether the trade asks for more than the wallet has: an amount over its limit, a buy with nothing to spend (said
 * before anything is typed), or a USDC sale without its gas in USDC.
 */
function isShort(
  state: SideTrade,
  form: ReturnType<typeof useTradeForm>,
  wallet: ReturnType<typeof useWallet>,
  max: bigint | undefined,
): boolean {
  if (form.amounts !== null && max !== undefined && form.amounts.amountIn > max) return true
  if (state !== 'trade') return false
  if (form.trade === 'buy') return max === 0n
  const gas = 2n * (deployment.aa?.maxCostPerOp ?? 0n)
  return form.coin === 'usdc' && wallet.usdc !== undefined && wallet.usdc < gas
}

/** What the form shows, from the trade state, the form and the wallet: kept out of the component to keep it plain. */
function formView(
  state: SideTrade,
  form: ReturnType<typeof useTradeForm>,
  wallet: ReturnType<typeof useWallet>,
  monPrice: number | undefined,
) {
  const { trade, amounts } = form
  const usdc = form.coin === 'usdc'
  const max = tradeMax(form, wallet)
  const short = isShort(state, form, wallet, max)
  // The MON side of the trade in dollars, where MON has a price (mainnet); a USDC trade is in dollars already.
  const usd = usdc ? undefined : usdValue(trade === 'buy' ? amounts?.amountIn : amounts?.expectedOut, 18, monPrice)
  return {
    usd: usd === undefined ? undefined : approxUsd(usd),
    open: state !== 'closed' && state !== 'unavailable',
    max: state === 'trade' ? max : undefined,
    short: short ? (usdc ? usdcShort(trade, max, wallet) : shortHint(trade, wallet.cap)) : null,
    noGas: state === 'trade' && !usdc && !gasReady(trade, wallet),
    ready: state === 'trade' && amounts !== null && !short && !form.quoting,
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
  const view = formView(state, form, wallet, useMonPrice())
  // Back from a trade that didn't happen: price the same amount again now, not from the quote it was sent on.
  useEffect(() => {
    if (sending.ended !== null && form.typed !== null) void form.quote.refetch()
  }, [sending.ended])
  return (
    <div className="grid gap-3">
      {sending.ended !== null && <TradeEndedNotice ended={sending.ended} />}
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
      <TradeFields form={form} side={l?.side ?? null} view={view} choices={coinChoices(address, wallet)} />
      <TradeDetails
        trade={trade}
        amounts={amounts}
        impact={form.impact}
        slippage={form.slippage}
        onSlippage={form.setSlippage}
        texts={form.plan === null ? null : usdcTexts(form.plan, MON)}
      />
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
          label={ctaLabel(state, trade, amounts, form.impact)}
          ready={view.ready && sending.loaded}
          busy={sending.preparing}
          onSignIn={onSignIn}
          onSend={() => {
            // A refused stale quote leaves the form: price it again at once rather than at the next refresh.
            if (amounts !== null)
              void sending.send(trade, amounts, form.plan).then(() => {
                void form.quote.refetch()
              })
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
