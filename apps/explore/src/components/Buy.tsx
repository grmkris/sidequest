import { cn } from '../lib/cn.ts'
import { erc20Abi } from 'viem'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as sdk from '@sidequest/sdk'
import { useEffect, useState } from 'react'
import { formatUnits, parseUnits } from 'viem'
import { useBalance, useReadContracts } from 'wagmi'
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
 * market, a link to SIDE on its launcher (mainnet's nad.fun) where the config names one; otherwise nothing.
 */
export function BuyButtons({ address }: { address: `0x${string}` }) {
  const [want, setWant] = useState<Want | null>(null)
  const m = deployment.market
  if (m === null)
    return getSideLink === null ? null : (
      <a
        href={getSideLink}
        target="_blank"
        rel="noreferrer"
        className={cn(buttonVariants({ variant: 'outline' }), 'w-fit')}
      >
        Get SIDE on nad.fun
      </a>
    )
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
    queryKey: ['market-price', m.poolId],
    queryFn: () => sdk.sidePrice(ctx, m, quoteToken.decimals),
    refetchInterval: 30_000,
  })
  const quoted = useQuery({
    queryKey: ['market-quote', m.poolId, tokenIn, amountIn?.toString()],
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
            void qc.invalidateQueries()
            onDone()
          }}
        />
      )}
    </div>
  )
}
