import { publicKey } from '../queries.ts'
import { refreshBalances } from '../query-refresh.ts'
import { cn } from '../lib/cn.ts'
import { erc20Abi } from 'viem'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as sdk from '@sidequest/sdk'
import { useEffect, useState, type ReactNode } from 'react'
import { formatUnits, parseUnits } from 'viem'
import { useBalance, useReadContract, useReadContracts } from 'wagmi'
import { formatNumber, tokenInfo } from '../format.ts'
import { stakeContext } from '../stake-context.ts'
import { friendlyError } from '../txErrors.ts'
import { chain, deployment, getSideLink } from '../wallet.ts'
import { useToast } from './Sheet.tsx'
import { GasWarning, SWAP_GAS } from './GasWarning.tsx'
import { TxSteps } from './TxSteps.tsx'
import type { WalletStep } from './txOperation.ts'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Button, buttonVariants } from './ui/button.tsx'
import { Input } from './ui/input.tsx'

type Want = 'side' | 'quote'

/**
 * Buy SIDE with the market's quote token, or the quote token with SIDE, on the Uniswap v4 SIDE pool
 * (`deployment.market`): an exact-input swap at the live quote less 1% slippage, with a 10-minute deadline. Without a
 * market, buy and sell SIDE for MON through nad.fun's router (`deployment.launcher`), the same calls on testnet and
 * mainnet, plus a link to SIDE's page on nad.fun where the config names one; otherwise nothing.
 */
export function BuyButtons({ address }: { address: `0x${string}` }) {
  const [want, setWant] = useState<Want | null>(null)
  const m = deployment.market
  if (m === null) {
    const link =
      getSideLink === null ? null : (
        <a
          href={getSideLink}
          target="_blank"
          rel="noreferrer"
          className={cn(buttonVariants({ variant: 'outline' }), 'w-fit')}
        >
          Get SIDE on nad.fun
        </a>
      )
    return deployment.launcher === null ? (
      link
    ) : (
      <LauncherButtons launcher={deployment.launcher} address={address} link={link} />
    )
  }
  const quote = tokenInfo(m.quote)
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          variant={want === 'side' ? 'default' : 'outline'}
          onClick={() => setWant(want === 'side' ? null : 'side')}
        >
          Buy SIDE
        </Button>
        <Button
          variant={want === 'quote' ? 'default' : 'outline'}
          onClick={() => setWant(want === 'quote' ? null : 'quote')}
        >
          Buy {quote.symbol}
        </Button>
      </div>
      {want !== null && <BuyPanel key={want} market={m} want={want} address={address} onDone={() => setWant(null)} />}
    </div>
  )
}

function BuyPanel({
  market: m,
  want,
  address,
  onDone,
}: {
  market: sdk.Market
  want: Want
  address: `0x${string}`
  onDone: () => void
}) {
  const ctx = stakeContext()
  const qc = useQueryClient()
  const toast = useToast()
  const quoteToken = tokenInfo(m.quote)
  const tokenIn = want === 'side' ? m.quote : m.side
  const inInfo = want === 'side' ? quoteToken : { symbol: 'SIDE', decimals: 18 }
  const outInfo = want === 'side' ? { symbol: 'SIDE', decimals: 18 } : quoteToken
  const [text, setText] = useState('')
  const [debounced, setDebounced] = useState('')
  const [steps, setSteps] = useState<{ id: string; txs: WalletStep[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 350)
    return () => clearTimeout(t)
  }, [text])
  const amountIn = (() => {
    try {
      const v = parseUnits(debounced.trim(), inInfo.decimals)
      return v > 0n ? v : null
    } catch {
      return null
    }
  })()
  const balance = useReadContracts({
    contracts: [
      { address: tokenIn, abi: erc20Abi, functionName: 'balanceOf', args: [address], chainId: chain.id },
    ] as const,
    query: { refetchInterval: 10_000 },
  }).data?.[0]?.result as bigint | undefined
  const price = useQuery({
    queryKey: publicKey('market-price', m.poolId),
    queryFn: () => sdk.sidePrice(ctx, m, quoteToken.decimals),
    refetchInterval: 30_000,
  })
  const quoted = useQuery({
    queryKey: publicKey('market-quote', m.poolId, tokenIn, amountIn?.toString()),
    queryFn: () => sdk.quoteExactIn(ctx, m, tokenIn, amountIn!),
    enabled: amountIn !== null,
    retry: false,
  })
  const short = amountIn !== null && balance !== undefined && amountIn > balance
  // A swap is sent from the wallet itself and is never gas-sponsored: say so before it fails for want of MON.
  const gas = useBalance({ address, chainId: chain.id, query: { refetchInterval: 15_000 } }).data?.value
  const noGas = gas !== undefined && gas < SWAP_GAS
  const out = quoted.data?.amountOut
  const review = async () => {
    if (amountIn === null || out === undefined) return
    setBusy(true)
    setError(null)
    try {
      const txs = await sdk.swapTransactions(ctx, m, {
        owner: address,
        tokenIn,
        amountIn,
        minOut: sdk.minOutFor(out),
        deadline: Math.floor(Date.now() / 1000) + 600,
      })
      setSteps({ id: `swap:${address}:${tokenIn}:${amountIn}:${Date.now()}`, txs })
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid gap-3 rounded-xl border border-border p-3">
      {price.data !== undefined && price.data > 0 && (
        <p className="text-sm text-muted-foreground">
          1 SIDE ≈ {price.data.toPrecision(3)} {quoteToken.symbol} · up to 1% slippage
        </p>
      )}
      {steps === null ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={`${inInfo.symbol} to pay`}
              aria-label={`${inInfo.symbol} to pay`}
              inputMode="decimal"
              className="max-w-48"
            />
            <Button
              variant="link"
              disabled={balance === undefined || balance === 0n}
              onClick={() => setText(formatUnits(balance!, inInfo.decimals))}
            >
              Max
            </Button>
          </div>
          <p className="text-sm" aria-live="polite">
            {amountIn === null
              ? `You hold ${balance === undefined ? '…' : formatNumber(balance, inInfo.decimals)} ${inInfo.symbol}.`
              : short
                ? `That is more ${inInfo.symbol} than your wallet holds.`
                : quoted.isError
                  ? 'The pool cannot quote this amount right now.'
                  : out === undefined
                    ? 'Quoting…'
                    : `You get about ${formatNumber(out, outInfo.decimals)} ${outInfo.symbol} (at least ${formatNumber(sdk.minOutFor(out), outInfo.decimals)} ${outInfo.symbol}).`}
          </p>
          <GasWarning mon={gas} action="A swap" need={SWAP_GAS} />
          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div>
            <Button
              disabled={amountIn === null || short || out === undefined || noGas}
              busy={busy}
              onClick={() => void review()}
            >
              Review swap
            </Button>
          </div>
        </>
      ) : (
        <TxSteps
          taskId={steps.id}
          txs={steps.txs}
          owner={address}
          reportToBoard={false}
          allowSponsorship={false}
          autoStart
          onDone={() => {
            toast(`Bought ${outInfo.symbol}`)
            void refreshBalances(qc)
            onDone()
          }}
        />
      )}
    </div>
  )
}

type Trade = 'buy' | 'sell'

/** Buy SIDE with MON, or sell SIDE for MON, through nad.fun's router: the bonding curve before graduation, its pair after. */
function LauncherButtons({
  launcher,
  address,
  link,
}: {
  launcher: sdk.Launcher
  address: `0x${string}`
  link: ReactNode
}) {
  const [trade, setTrade] = useState<Trade | null>(null)
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          variant={trade === 'buy' ? 'default' : 'outline'}
          onClick={() => setTrade(trade === 'buy' ? null : 'buy')}
        >
          Buy SIDE
        </Button>
        <Button
          variant={trade === 'sell' ? 'default' : 'outline'}
          onClick={() => setTrade(trade === 'sell' ? null : 'sell')}
        >
          Sell SIDE
        </Button>
        {link}
      </div>
      {trade !== null && (
        <LauncherPanel key={trade} launcher={launcher} trade={trade} address={address} onDone={() => setTrade(null)} />
      )}
    </div>
  )
}

/** What the trade form says under the amount: the balance, a shortfall, or the quote with its floor. */
function tradeMessage(input: {
  trade: Trade
  amountIn: bigint | null
  balance: bigint | undefined
  short: boolean
  failed: boolean
  out: bigint | undefined
  /** A buy's ceiling, and whether Monad's 10 MON reserve set it (a delegated wallet). */
  cap: { max: bigint; reserve: boolean } | undefined
}): string {
  const mon = chain.nativeCurrency.symbol
  const inSymbol = input.trade === 'buy' ? mon : 'SIDE'
  const outSymbol = input.trade === 'buy' ? 'SIDE' : mon
  if (input.amountIn === null)
    return `You hold ${input.balance === undefined ? '…' : formatNumber(input.balance, 18)} ${inSymbol}.`
  if (input.short && input.trade === 'buy' && input.cap?.reserve)
    return `Monad keeps 10 ${mon} in upgraded wallets. You can buy with up to ${formatNumber(input.cap.max, 18)} ${mon} now.`
  if (input.short)
    return input.trade === 'buy'
      ? `That leaves too little ${mon} for gas.`
      : 'That is more SIDE than your wallet holds.'
  if (input.failed) return 'nad.fun cannot quote this amount right now.'
  if (input.out === undefined) return 'Quoting…'
  return `You get about ${formatNumber(input.out, 18)} ${outSymbol} (at least ${formatNumber(sdk.minOutFor(input.out), 18)} ${outSymbol}).`
}

function useDecimalAmount(text: string): bigint | null {
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 350)
    return () => clearTimeout(t)
  }, [text])
  try {
    const v = parseUnits(debounced.trim(), 18)
    return v > 0n ? v : null
  } catch {
    return null
  }
}

/** The wallet's MON and SIDE, the router's quote for `amountIn`, and whether the wallet can cover the trade. */
function useLauncherTrade(l: sdk.Launcher, trade: Trade, address: `0x${string}`, amountIn: bigint | null) {
  const ctx = stakeContext()
  const gas = useBalance({ address, chainId: chain.id, query: { refetchInterval: 15_000 } }).data?.value
  const side = useReadContract({
    address: l.side,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address],
    chainId: chain.id,
    query: { refetchInterval: 10_000 },
  }).data
  const balance = trade === 'buy' ? gas : side
  const quoted = useQuery({
    queryKey: publicKey('launcher-quote', l.router, trade, amountIn?.toString()),
    queryFn: () => sdk.launcherQuote(ctx, l, trade, amountIn!),
    enabled: amountIn !== null,
    retry: false,
  })
  // A delegated wallet (Explore upgrades it on its first batch) must keep Monad's 10 MON reserve after a buy, or the
  // buy reverts and still pays gas; a sale sends no MON. Never gas-sponsored.
  const delegated = useQuery({
    queryKey: publicKey('delegation', address),
    queryFn: async () => (await sdk.delegationOf(ctx.publicClient, address)) !== null,
  }).data
  const cap =
    gas === undefined || delegated === undefined
      ? undefined
      : { max: sdk.nativeBuyCap({ balance: gas, gasCost: SWAP_GAS, delegated }), reserve: delegated }
  const short =
    amountIn !== null &&
    (trade === 'buy' ? cap !== undefined && amountIn > cap.max : side !== undefined && amountIn > side)
  const out = quoted.data
  const ready = amountIn !== null && !short && out !== undefined && !(gas !== undefined && gas < SWAP_GAS)
  return { gas, side, balance, cap, short, out, failed: quoted.isError, ready }
}

function LauncherPanel({
  launcher: l,
  trade,
  address,
  onDone,
}: {
  launcher: sdk.Launcher
  trade: Trade
  address: `0x${string}`
  onDone: () => void
}) {
  const ctx = stakeContext()
  const qc = useQueryClient()
  const toast = useToast()
  const [text, setText] = useState('')
  const amountIn = useDecimalAmount(text)
  const [steps, setSteps] = useState<{ id: string; txs: WalletStep[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { gas, side, balance, cap, short, out, failed, ready } = useLauncherTrade(l, trade, address, amountIn)
  const review = async () => {
    if (amountIn === null || out === undefined) return
    setBusy(true)
    setError(null)
    try {
      const deadline = Math.floor(Date.now() / 1000) + 600
      const input = { owner: address, side: trade, amountIn, minOut: sdk.minOutFor(out), deadline }
      setSteps({
        id: `nadfun:${trade}:${address}:${amountIn}:${Date.now()}`,
        txs: await sdk.launcherTransactions(ctx, l, input),
      })
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }
  const done = () => {
    toast(trade === 'buy' ? 'Bought SIDE' : 'Sold SIDE')
    void refreshBalances(qc)
    onDone()
  }
  const message = tradeMessage({ trade, amountIn, balance, short, failed, out, cap })
  return (
    <div className="grid gap-3 rounded-xl border border-border p-3">
      <p className="text-sm text-muted-foreground">Through nad.fun&apos;s router · up to 1% slippage</p>
      {steps === null ? (
        <LauncherForm
          trade={trade}
          text={text}
          setText={setText}
          max={trade === 'buy' ? cap?.max : side}
          message={message}
          gas={gas}
          error={error}
          ready={ready}
          busy={busy}
          review={() => void review()}
        />
      ) : (
        <TxSteps
          taskId={steps.id}
          txs={steps.txs}
          owner={address}
          reportToBoard={false}
          allowSponsorship={false}
          autoStart
          onDone={done}
        />
      )}
    </div>
  )
}

function LauncherForm(props: {
  trade: Trade
  text: string
  setText: (text: string) => void
  /** The most the wallet can trade: its SIDE for a sale; for a buy, its MON less gas and any reserve. */
  max: bigint | undefined
  message: string
  gas: bigint | undefined
  error: string | null
  ready: boolean
  busy: boolean
  review: () => void
}) {
  const inSymbol = props.trade === 'buy' ? chain.nativeCurrency.symbol : 'SIDE'
  const { max } = props
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={props.text}
          onChange={(event) => props.setText(event.target.value)}
          placeholder={`${inSymbol} to pay`}
          aria-label={`${inSymbol} to pay`}
          inputMode="decimal"
          className="max-w-48"
        />
        {max !== undefined && max > 0n && (
          <Button variant="link" onClick={() => props.setText(formatUnits(max, 18))}>
            Max
          </Button>
        )}
      </div>
      <p className="text-sm" aria-live="polite">
        {props.message}
      </p>
      <GasWarning mon={props.gas} action={props.trade === 'buy' ? 'A buy' : 'A sale'} need={SWAP_GAS} />
      {props.error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{props.error}</AlertDescription>
        </Alert>
      )}
      <div>
        <Button disabled={!props.ready} busy={props.busy} onClick={props.review}>
          {props.trade === 'buy' ? 'Review buy' : 'Review sale'}
        </Button>
      </div>
    </>
  )
}
