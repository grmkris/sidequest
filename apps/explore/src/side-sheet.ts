/**
 * The SIDE sheet's decisions, kept pure: what its trade section shows, the MON a Fill puts in the buy, and the `?side`
 * link that opens it. The sheet itself is `components/side/SideToken.tsx`.
 */
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
