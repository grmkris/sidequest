import { parseUnits, formatUnits } from 'viem'
import type { AdvanceBudgetTerms, CallBudgetTerms } from './api.ts'
import { deployment, isMainnet } from './wallet.ts'

/** The single marker used for an empty value cell. */
export const EMPTY_CELL = '—'

export interface TokenMeta {
  symbol: string
  decimals: number
  name?: string
  /** Not a token the deployment lists: any ERC-20 can be a reward (ADR-0010), and anyone can name a token anything. */
  unverified?: boolean
}

const LISTED = new Set([...deployment.rewardTokens, deployment.factory].map((a) => a.toLowerCase()))
/** One of the deployment's known tokens (listed first in the apps) or SIDE; every other ERC-20 is unverified. */
export const isListedToken = (address: string) => LISTED.has(address.toLowerCase())

/**
 * Tokens by address. The deployment's own are known up front (Circle USDC on mainnet; mUSD and mEUR on testnet);
 * every board's tokens (with the symbol and decimals the board read from the chain) are added by `registerTokens` once
 * `/data/boards` answers, so a token like $CHOMP never shows as "token", and `useToken` adds any other ERC-20 it reads.
 */
export const TOKENS: Record<string, TokenMeta> = isMainnet
  ? {
      [deployment.rewardTokens[0]?.toLowerCase() ?? '']: { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
      [deployment.factory.toLowerCase()]: { symbol: 'SIDE', decimals: 18 },
    }
  : {
      [deployment.rewardTokens[0]?.toLowerCase() ?? '']: { symbol: 'mUSD', name: 'Mock USD (testnet)', decimals: 6 },
      [deployment.rewardTokens[1]?.toLowerCase() ?? '']: { symbol: 'mEUR', name: 'Mock EUR (testnet)', decimals: 6 },
      [deployment.factory.toLowerCase()]: { symbol: 'SIDE', decimals: 18 },
    }

let registryVersion = 0
const tokenListeners = new Set<() => void>()
export const tokenRegistryVersion = () => registryVersion
export const subscribeTokens = (listener: () => void) => {
  tokenListeners.add(listener)
  return () => tokenListeners.delete(listener)
}

export function registerTokens(
  tokens: ReadonlyArray<{ address: string; symbol: string; decimals: number; name?: string }>,
): void {
  let changed = false
  for (const t of tokens) {
    const a = t.address.toLowerCase()
    if (TOKENS[a] === undefined) {
      TOKENS[a] = {
        symbol: t.symbol,
        ...(t.name === undefined ? {} : { name: t.name }),
        decimals: t.decimals,
        ...(isListedToken(a) ? {} : { unverified: true }),
      }
      changed = true
    }
  }
  if (changed) {
    registryVersion++
    tokenListeners.forEach((listener) => listener())
  }
}

/** A token's symbol and decimals once known; undefined for one not read yet. */
export const tokenMeta = (address: string): TokenMeta | undefined => TOKENS[address.toLowerCase()]

/** Every token known so far but the bond token: the listed ones, every board's, and any read from the chain. */
export const rewardTokenList = () =>
  Object.entries(TOKENS).filter(([a]) => a !== deployment.factory.toLowerCase() && a !== '')

export function tokenInfo(address: string | null | undefined): TokenMeta {
  const a = (address ?? '').toLowerCase()
  return TOKENS[a] ?? { symbol: 'tokens', decimals: 18 }
}

/** Base units as people read them: grouped thousands, at most 4 decimals, trailing zeros dropped. */
export function formatNumber(value: bigint, decimals: number): string {
  const [whole = '0', frac = ''] = formatUnits(value, decimals).split('.')
  const grouped = BigInt(whole).toLocaleString('en-US')
  const f = frac.slice(0, 4).replace(/0+$/, '')
  if (value > 0n && BigInt(whole) === 0n && f === '') return '<0.0001'
  return f === '' ? grouped : `${grouped}.${f}`
}

/**
 * An amount as people scan a quote or a balance: whole units from 1,000 up, at most two decimals from 1, four significant
 * digits below 1 ("29,687", "10.27", "0.0646"). Truncated, never rounded up, so a balance or a minimum never reads high.
 * For money forms; amounts elsewhere stay `formatNumber`.
 */
export function formatAmount(value: bigint, decimals: number): string {
  const [whole = '0', frac = ''] = formatUnits(value, decimals).split('.')
  const units = BigInt(whole)
  const grouped = units.toLocaleString('en-US')
  if (units >= 1000n) return grouped
  if (units >= 1n) {
    const f = frac.slice(0, 2).replace(/0+$/, '')
    return f === '' ? grouped : `${grouped}.${f}`
  }
  const zeros = /^0*/.exec(frac)?.[0].length ?? 0
  const f = frac.slice(0, zeros + 4).replace(/0+$/, '')
  return f === '' ? '0' : `0.${f}`
}

/** "7 mUSD". That testnet tokens have no value is said by the TESTNET tag and the wallet, not after every amount. */
export function amount(value: string | null | undefined, token: string | null | undefined): string {
  if (value === null || value === undefined) return EMPTY_CELL
  const t = tokenMeta((token ?? '').toLowerCase())
  if (t === undefined) return `${EMPTY_CELL} tokens`
  return `${formatNumber(BigInt(value), t.decimals)} ${t.symbol}`
}

/** An execution budget's cap as people read it; a call budget names the function and contract it may call once. */
export function budgetCap(eb: AdvanceBudgetTerms | CallBudgetTerms): string {
  if (eb.kind === 'advance') return amount(eb.cap, eb.token)
  const name = /function\s+(\w+)/.exec(eb.function ?? '')?.[1] ?? 'call'
  return `${formatNumber(BigInt(eb.cap), 18)} MON for ${name}() on ${eb.target.slice(0, 8)}…${eb.target.slice(-4)}`
}

export const bond = (value: string | null | undefined) =>
  value === null || value === undefined ? EMPTY_CELL : `${formatNumber(BigInt(value), 18)} SIDE`

/** "3 h 5 min", "2 d 4 h", "40 s": a span of seconds at two units of precision. */
export function span(seconds: number): string {
  const a = Math.abs(Math.round(seconds))
  const d = Math.floor(a / 86_400)
  const h = Math.floor((a % 86_400) / 3600)
  const m = Math.floor((a % 3600) / 60)
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`
  if (h > 0) return m > 0 && h < 6 ? `${h} h ${m} min` : `${h} h`
  if (m > 0) return `${m} min`
  return `${a} s`
}

/** "in 3 h", "2 d ago" relative to `now` (unix seconds). */
export const relative = (unix: number, now = Date.now() / 1000) =>
  unix >= now ? `in ${span(unix - now)}` : `${span(now - unix)} ago`

/** How long ago, as short as a list column needs: "now", "4m", "2h", "3d", "5w". */
export function shortAgo(unix: number, now: number): string {
  const s = Math.max(0, Math.floor(now - unix))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`
  return `${Math.floor(s / (7 * 86_400))}w`
}

/** A duration as short as a track between two stops needs: "40s", "12m", "2h", "3d". */
export function shortSpan(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

/** The day a moment falls on, in the reader's time zone, as a feed heading: "Today", "Yesterday", "Thu 8 Oct". */
const calendarDay = (unix: number) => new Date(unix * 1000).toDateString()

export function dayLabel(unix: number, now: number): string {
  if (calendarDay(unix) === calendarDay(now)) return 'Today'
  if (calendarDay(unix) === calendarDay(now - 86_400)) return 'Yesterday'
  return new Date(unix * 1000).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

/** A moment in the reader's own time zone: "Thu 1 Oct, 14:29". */
export function localTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function toBase(value: string, token: string): bigint | null {
  try {
    return parseUnits(value.trim(), tokenInfo(token).decimals)
  } catch {
    return null
  }
}

/** "1,000.5 mUSD" for a decimal amount a person typed; the text as typed if it is not a number. */
export function humanAmount(value: string, symbol: string): string {
  const [whole = '', frac = ''] = value.trim().split('.')
  if (!/^\d+$/.test(whole || '0') || !/^\d*$/.test(frac)) return `${value} ${symbol}`
  const grouped = BigInt(whole || '0').toLocaleString('en-US')
  const f = frac.replace(/0+$/, '')
  return `${f === '' ? grouped : `${grouped}.${f}`} ${symbol}`
}
