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

const STEP = 10n ** 14n

/**
 * The MON a Fill puts in the buy for a quoted cost: 2% over it for the curve moving before the buy lands, rounded up to
 * four decimals so the field stays readable. The form quotes the exact SIDE out before anything is sent.
 */
export function fillMon(cost: bigint): string {
  const padded = (cost * 102n + 99n) / 100n
  return formatUnits(((padded + STEP - 1n) / STEP) * STEP, 18)
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
 * What a two-way trade sends. Typed on "You pay": that amount goes in, and the quote (getAmountOut) is what comes back.
 * Typed on "You get": the quote (getAmountIn) goes in, and the typed amount is what comes back. The floor is always 1%
 * under what comes back. Null until both the amount and its quote are known.
 */
export function tradeAmounts(input: {
  edited: Edited
  typed: bigint | null
  quoted: bigint | undefined
}): { amountIn: bigint; expectedOut: bigint; minOut: bigint } | null {
  if (input.typed === null || input.quoted === undefined || input.quoted === 0n) return null
  const amountIn = input.edited === 'pay' ? input.typed : input.quoted
  const expectedOut = input.edited === 'pay' ? input.quoted : input.typed
  return { amountIn, expectedOut, minOut: minOutFor(expectedOut) }
}

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
