/**
 * The SIDE sheet's decisions, kept pure: what its trade card shows, what a two-way trade sends, and the `?side` link that
 * opens it. The sheet itself is `components/side/SideToken.tsx`, its card `components/side/TradeCard.tsx`.
 */
import { minOutFor } from '@sidequest/sdk'
import { formatUnits, parseEther } from 'viem'

/**
 * What the trade section shows. `closed`: mainnet before writes open, links only. `unavailable`: no launcher to trade
 * through. `sign-in`: nobody logged in. `connecting`: logged in, the wallet not yet connected. `trade`: the form.
 */
export type SideTrade = 'closed' | 'unavailable' | 'sign-in' | 'connecting' | 'trade'

export function sideTrade(input: {
  writesOpen: boolean
  launcher: boolean
  /** The connected wallet (wagmi), which is all a trade needs: it is sent from the wallet, never through the board. */
  address: string | undefined
  /** Logged in to Privy, whose wallet connects a moment later. */
  authenticated: boolean
}): SideTrade {
  if (!input.writesOpen) return 'closed'
  if (!input.launcher) return 'unavailable'
  if (input.address !== undefined) return 'trade'
  return input.authenticated ? 'connecting' : 'sign-in'
}

const DECIMAL = /^\d+(\.\d{1,18})?$/

/**
 * What a `?side` link asks for: null without it; `{ need: null }` for a bare `?side`; the SIDE to buy for
 * `?side=500000`. Anything that is not a positive decimal opens the sheet without an amount.
 */
export function sideRequest(search: string): { need: bigint | null } | null {
  const value = new URLSearchParams(search).get('side')
  if (value === null) return null
  if (!DECIMAL.test(value)) return { need: null }
  const need = parseEther(value)
  return { need: need > 0n ? need : null }
}

/** The page's search without its `side` parameter (`''` or `?…`), once the sheet has opened from it. */
export function withoutSide(search: string): string {
  const params = new URLSearchParams(search)
  params.delete('side')
  const rest = params.toString()
  return rest === '' ? '' : `?${rest}`
}

/** The SIDE still to buy: what is needed less what the wallet holds, or null when it holds enough or either is unknown. */
export function sideShort(needed: bigint | undefined, held: bigint | undefined): bigint | null {
  if (needed === undefined || held === undefined || held >= needed) return null
  return needed - held
}

/** Which side of the trade card was typed in: what is paid, or what comes back. The other side is the router's quote. */
export type Edited = 'pay' | 'get'

/**
 * How far below the quote a trade may fill, in basis points. nad.fun's curve moves with every trade, and on a busy
 * launch night 1% reverted a buy that took a minute to confirm, so the card starts at 3%.
 */
export const SLIPPAGES = [100, 300, 500] as const
export type Slippage = (typeof SLIPPAGES)[number]
export const DEFAULT_SLIPPAGE: Slippage = 300

/** A slippage as the card shows it: "3%". */
export const slippageText = (bps: number) => `${bps / 100}%`

/**
 * What a two-way trade sends. Typed on "You pay": that amount goes in, and the quote (getAmountOut) is what comes back.
 * Typed on "You get": the quote (getAmountIn) goes in, and the typed amount is what comes back. The floor is the chosen
 * slippage under what comes back. Null until both the amount and its quote are known.
 */
export function tradeAmounts(input: {
  edited: Edited
  typed: bigint | null
  quoted: bigint | undefined
  slippageBps: number
}): { amountIn: bigint; expectedOut: bigint; minOut: bigint } | null {
  if (input.typed === null || input.quoted === undefined || input.quoted === 0n) return null
  const amountIn = input.edited === 'pay' ? input.typed : input.quoted
  const expectedOut = input.edited === 'pay' ? input.quoted : input.typed
  return { amountIn, expectedOut, minOut: minOutFor(expectedOut, input.slippageBps) }
}

/** Price impact from which the card warns, and from which its button asks to go ahead anyway. */
export const IMPACT_WARN = 0.05
export const IMPACT_HIGH = 0.15

/**
 * How much worse this trade's rate is than a small reference trade's, both through the router (fees in both, so this
 * is the curve moving under the trade): 0.012 is 1.2%. `refOut` is what `refIn` returns now. 0 for a trade no worse
 * than the reference, null until both are known.
 */
export function priceImpact(
  amounts: { amountIn: bigint; expectedOut: bigint } | null,
  ref: { refIn: bigint; refOut: bigint } | undefined,
): number | null {
  if (amounts === null || ref === undefined || amounts.amountIn === 0n || ref.refIn === 0n || ref.refOut === 0n)
    return null
  // Out per in, scaled to keep 1e-6 of precision through bigint division.
  const scale = 10n ** 18n
  const rate = (amounts.expectedOut * scale) / amounts.amountIn
  const refRate = (ref.refOut * scale) / ref.refIn
  if (rate >= refRate) return 0
  return Number(((refRate - rate) * 1_000_000n) / refRate) / 1_000_000
}

/** A price impact as the card shows it: "<0.1%", "1.2%", "18%". */
export function impactText(impact: number): string {
  if (impact < 0.001) return '<0.1%'
  return impact < 0.1 ? `${(impact * 100).toFixed(1)}%` : `${Math.round(impact * 100)}%`
}

/** MON per million SIDE at this trade's rate: what 1M SIDE costs on a buy, or returns on a sale. */
export function monPerMillion(trade: 'buy' | 'sell', amounts: { amountIn: bigint; expectedOut: bigint }): bigint {
  const million = 1_000_000n * 10n ** 18n
  const [mon, side] =
    trade === 'buy' ? [amounts.amountIn, amounts.expectedOut] : [amounts.expectedOut, amounts.amountIn]
  return side === 0n ? 0n : (mon * million) / side
}

/**
 * Whether a trade still clears its floor at the router's price now: `now` is what `amountIn` returns at this moment. A
 * trade that would not is refused before the wallet opens, so a stale quote costs no gas.
 */
export const quoteHolds = (amounts: { minOut: bigint }, now: bigint) => now >= amounts.minOut

const UNIT = 10n ** 18n

/** SIDE to ask for: whole SIDE, rounded up, from one SIDE up, so a fill never falls a fraction short. */
export function wholeUp(value: bigint): bigint {
  if (value < UNIT || value % UNIT === 0n) return value
  return (value / UNIT + 1n) * UNIT
}

/** An 18-decimal amount as the trade card fills it in: grouped thousands, every decimal kept ("500,000", "0.5"). */
export function fillText(value: bigint): string {
  const [whole = '0', frac = ''] = formatUnits(value, 18).split('.')
  const grouped = BigInt(whole).toLocaleString('en-US')
  return frac === '' ? grouped : `${grouped}.${frac}`
}
