import { publicKey } from './queries.ts'
import * as sdk from '@sidequest/sdk'
import { useQuery } from '@tanstack/react-query'
import { formatUnits } from 'viem'
import { tokenInfo } from './format.ts'
import { stakeContext } from './stake-context.ts'
import { deployed, deployment, network } from './wallet.ts'

/*
 * Dollar estimates for the wallet. Only two sources count: tokens the network config pegs at one dollar
 * (`usdPegged`: USDC, testnet's mUSD) and SIDE through its market pool when that pool is quoted in a pegged token.
 * Every other token has no price and shows none; nothing is guessed. Testnet values are test value.
 */

const PEGGED = new Set(sdk.networkMeta(network).usdPegged.map((a) => a.toLowerCase()))

export const isUsdPegged = (token: string) => PEGGED.has(token.toLowerCase())

/** One SIDE in dollars from the market pool, or undefined without a live price. Shares Buy's market-price read. */
export function useSidePrice(): number | undefined {
  const m = deployment.market
  const price = useQuery({
    queryKey: publicKey('market-price', m?.poolId),
    queryFn: () => sdk.sidePrice(stakeContext(), m!, tokenInfo(m!.quote).decimals),
    enabled: deployed && m !== null && isUsdPegged(m.quote),
    refetchInterval: 30_000,
    retry: false,
  })
  return price.data !== undefined && Number.isFinite(price.data) && price.data > 0 ? price.data : undefined
}

/** Dollars per whole token: 1 for a pegged token, the pool price for SIDE, undefined for anything else. */
export function usdPerUnit(token: string | null, sidePrice: number | undefined): number | undefined {
  if (token === null) return undefined
  if (isUsdPegged(token)) return 1
  if (token.toLowerCase() === deployment.factory.toLowerCase()) return sidePrice
  return undefined
}

/** A balance in dollars; undefined when the balance or the price is unknown. */
export function usdValue(value: bigint | undefined, decimals: number, perUnit: number | undefined): number | undefined {
  if (value === undefined || perUnit === undefined) return undefined
  return Number(formatUnits(value, decimals)) * perUnit
}

const cents = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

/** "≈ $1,240", "≈ $12.40", "≈ <$0.01"; an empty balance is exactly "$0". */
export function approxUsd(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return '≈ <$0.01'
  return `≈ ${usd < 1000 ? cents.format(usd) : dollars.format(usd)}`
}
