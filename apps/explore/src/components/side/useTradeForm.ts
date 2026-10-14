/**
 * The SIDE trade card's form state: Buy or Sell, paid (or paid out) in MON or USDC, which side was typed, the
 * slippage, and the quote for the other side, with what the trade would send. A MON trade is nad.fun's router alone;
 * a USDC trade is the SDK's route through the MON/USDC pool (swap.ts), quoted as one plan. Quotes follow the curve
 * every 10 s. A shortfall pre-fills "You get" on Buy.
 */
import * as sdk from '@sidequest/sdk'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { parseEther, parseUnits } from 'viem'
import { formatAmount } from '../../format.ts'
import { publicKey } from '../../queries.ts'
import {
  DEFAULT_SLIPPAGE,
  type Edited,
  type Slippage,
  fillText,
  priceImpact,
  tradeAmounts,
  wholeUp,
} from '../../side-sheet.ts'
import { type Coin, USDC_DECIMALS, usdcAmounts } from '../../side-usdc.ts'
import { stakeContext } from '../../stake-context.ts'
import { deployed, deployment } from '../../wallet.ts'

type Trade = 'buy' | 'sell'

/** A typed amount in `decimals`, parsed a moment after typing stops; grouping commas and spaces are ignored. */
function useAmount(text: string, decimals: number): bigint | null {
  const [settled, setSettled] = useState(text)
  useEffect(() => {
    const t = setTimeout(() => setSettled(text), 300)
    return () => clearTimeout(t)
  }, [text])
  try {
    const v = parseUnits(settled.replace(/[,\s]/g, ''), decimals)
    return v > 0n ? v : null
  } catch {
    return null
  }
}

/** A small trade to measure price impact against: 0.1 MON in on a buy, 1,000 SIDE in on a sale. */
const REF_IN = { buy: parseEther('0.1'), sell: parseEther('1000') } as const

/**
 * What the form reads from its quotes: the amounts to send, the leg price impact is measured on, and the side not typed
 * as quoted (nad.fun's other amount, or the USDC plan's, USDC in six decimals). Pure, to keep the hook plain.
 */
function quoted(input: {
  trade: Trade
  usdc: boolean
  plan: sdk.UsdcPlan | undefined
  edited: Edited
  typed: bigint | null
  quote: bigint | undefined
  /** What the reference trade (REF_IN) returns now. */
  ref: bigint | undefined
  slippageBps: number
}) {
  const { trade, plan } = input
  const ref = input.ref === undefined ? undefined : { refIn: REF_IN[trade], refOut: input.ref }
  if (!input.usdc) {
    const amounts = tradeAmounts({
      edited: input.edited,
      typed: input.typed,
      quoted: input.quote,
      slippageBps: input.slippageBps,
    })
    const other = input.quote === undefined ? '' : formatAmount(input.quote, 18)
    return { amounts, impact: priceImpact(amounts, ref), plan: null, pay: other, get: other }
  }
  if (plan === undefined) return { amounts: null, impact: null, plan: null, pay: '', get: '' }
  const a = usdcAmounts(plan)
  const [payDecimals, getDecimals] = trade === 'buy' ? [USDC_DECIMALS, 18] : [18, USDC_DECIMALS]
  return {
    amounts: { amountIn: a.amountIn, expectedOut: a.expectedOut, minOut: a.minOut },
    // The MON/USDC pool moves no measurable amount at these sizes: impact is the nad.fun leg's.
    impact: priceImpact(a.nadLeg, ref),
    plan,
    pay: formatAmount(a.shownIn, payDecimals),
    get: formatAmount(a.expectedOut, getDecimals),
  }
}

/** The field that holds the coin: "You pay" on a buy, "You get" on a sale. */
const coinField = (trade: Trade): Edited => (trade === 'buy' ? 'pay' : 'get')

/**
 * The form's quotes, every 10 s: nad.fun's for a MON trade, the USDC route's plan for a USDC one, and a small
 * reference trade's, which price impact is measured against.
 */
function useQuotes(
  l: sdk.Launcher | null,
  input: { trade: Trade; usdc: boolean; edited: Edited; typed: bigint | null; slippage: Slippage },
) {
  const ctx = stakeContext()
  const { trade, usdc, edited, typed, slippage } = input
  const route = deployment.nativeSwap !== null && l !== null ? { swap: deployment.nativeSwap, launcher: l } : null
  const quote = useQuery({
    queryKey: publicKey('launcher-quote', l?.router, trade, edited, typed?.toString()),
    queryFn: () =>
      edited === 'pay' ? sdk.launcherQuote(ctx, l!, trade, typed!) : sdk.launcherQuoteIn(ctx, l!, trade, typed!),
    enabled: !usdc && deployed && l !== null && typed !== null,
    refetchInterval: 10_000,
    retry: false,
  })
  const plan = useQuery({
    queryKey: publicKey('usdc-plan', l?.router, trade, edited, typed?.toString(), slippage),
    queryFn: () => sdk.quoteUsdcPlan(ctx, route!, { trade, edited, typed: typed!, slippageBps: slippage }),
    enabled: usdc && deployed && route !== null && typed !== null,
    refetchInterval: 10_000,
    retry: false,
  })
  const ref = useQuery({
    queryKey: publicKey('launcher-ref', l?.router, trade),
    queryFn: () => sdk.launcherQuote(ctx, l!, trade, REF_IN[trade]),
    enabled: deployed && l !== null && typed !== null,
    refetchInterval: 10_000,
    retry: false,
  })
  return { quote, plan, ref }
}

export function useTradeForm(l: sdk.Launcher | null, need: bigint | null) {
  const [trade, setTrade] = useState<Trade>('buy')
  const [coin, setCoin] = useState<Coin>('mon')
  const [edited, setEdited] = useState<Edited>(need === null ? 'pay' : 'get')
  const [text, setText] = useState(need === null ? '' : fillText(wholeUp(need)))
  const [slippage, setSlippage] = useState<Slippage>(DEFAULT_SLIPPAGE)
  const usdc = coin === 'usdc'
  const typed = useAmount(text, usdc && edited === coinField(trade) ? USDC_DECIMALS : 18)
  const { quote, plan, ref } = useQuotes(l, { trade, usdc, edited, typed, slippage })
  const q = quoted({
    trade,
    usdc,
    plan: plan.data,
    edited,
    typed,
    quote: quote.data,
    ref: ref.data,
    slippageBps: slippage,
  })
  const active = usdc ? plan : quote
  const reset = (side: Edited) => {
    setEdited(side)
    setText('')
  }
  return {
    trade,
    coin,
    edited,
    typed,
    quote: active,
    plan: q.plan,
    slippage,
    setSlippage,
    amounts: q.amounts,
    impact: q.impact,
    // A new amount is quoting; the 10 s refresh of one already quoted updates in place.
    quoting: typed !== null && active.isFetching && !active.isRefetching,
    payText: edited === 'pay' ? text : q.pay,
    getText: edited === 'get' ? text : q.get,
    type: (side: Edited, next: string) => {
      setEdited(side)
      setText(next)
    },
    setTrade: (next: Trade) => {
      setTrade(next)
      reset('pay')
    },
    /** MON or USDC: an amount typed in the coin's own field no longer means the same, so it clears. */
    setCoin: (next: Coin) => {
      if (next === coin) return
      setCoin(next)
      if (edited === coinField(trade)) reset('pay')
    },
    clear: () => reset('pay'),
  }
}
