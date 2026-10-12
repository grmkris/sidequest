import { publicKey } from '../queries.ts'
import { refreshBalances } from '../query-refresh.ts'
import { erc20Abi } from 'viem'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as sdk from '@sidequest/sdk'
import { useEffect, useState } from 'react'
import { formatUnits, parseUnits } from 'viem'
import { useBalance, useReadContract } from 'wagmi'
import { formatNumber } from '../format.ts'
import { stakeContext } from '../stake-context.ts'
import { friendlyError } from '../txErrors.ts'
import { chain } from '../wallet.ts'
import { GasWarning, SWAP_GAS } from './GasWarning.tsx'
import { TxSteps } from './TxSteps.tsx'
import type { WalletStep } from './txOperation.ts'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Button } from './ui/button.tsx'
import { Input } from './ui/input.tsx'

export type Trade = 'buy' | 'sell'

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

/**
 * Buy SIDE with MON, or sell SIDE for MON, through nad.fun's router: the bonding curve before graduation, its pair after.
 * The amount is the caller's, so the SIDE sheet can fill it. A finished trade reports what it was quoted to return
 * rather than toasting, since a toast would sit under the sheet. Sent from the wallet, never gas-sponsored.
 */
export function LauncherPanel({
  launcher: l,
  trade,
  address,
  text,
  onText,
  onBusyChange,
  onDone,
}: {
  launcher: sdk.Launcher
  trade: Trade
  address: `0x${string}`
  text: string
  onText: (text: string) => void
  /** A wallet request is pending: the sheet goes non-modal so the wallet's own prompt can be pressed. */
  onBusyChange: (busy: boolean) => void
  onDone: (done: { trade: Trade; out: bigint }) => void
}) {
  const ctx = stakeContext()
  const qc = useQueryClient()
  const amountIn = useDecimalAmount(text)
  const [steps, setSteps] = useState<{ id: string; txs: WalletStep[]; out: bigint } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { gas, side, balance, cap, short, out, failed, ready } = useLauncherTrade(l, trade, address, amountIn)
  // A panel that leaves mid-request (the tab switched, the sheet closed) must not leave its sheet non-modal.
  useEffect(() => () => onBusyChange(false), [onBusyChange])
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
        out,
      })
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }
  const message = tradeMessage({ trade, amountIn, balance, short, failed, out, cap })
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">Through nad.fun&apos;s router · up to 1% slippage</p>
      {steps === null ? (
        <LauncherForm
          trade={trade}
          text={text}
          setText={onText}
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
          onBusyChange={onBusyChange}
          onDone={() => {
            void refreshBalances(qc)
            onDone({ trade, out: steps.out })
          }}
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
      <GasWarning
        mon={props.gas}
        action={props.trade === 'buy' ? 'A buy' : 'A sale'}
        need={SWAP_GAS}
        allowUsdc={props.trade !== 'buy'}
      />
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
