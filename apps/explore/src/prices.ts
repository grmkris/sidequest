/** The admin form shares its signed price-list contract with the SDK. */
import { type PriceList, type TokenPrice } from '@sidequest/sdk'
import { getAddress, isAddress, parseUnits } from 'viem'

export { SIDE_PRICE_FLOOR, priceListFile, priceTypedData, type PriceList } from '@sidequest/sdk'

/** The form: USD prices as typed ("1", "0.9998"); a token row with no price is left off the list. */
export interface PriceDraft {
  epoch: string
  factoryUsd: string
  tokens: Array<{ token: string; decimals: number | null; usd: string }>
}

const usd = (text: string): bigint | null =>
  /^\d+(\.\d{1,18})?$/.test(text.trim()) ? parseUnits(text.trim(), 18) : null
const isString = (value: unknown): value is string => typeof value === 'string'

const tokenPrice = (row: PriceDraft['tokens'][number], tokens: TokenPrice[]): TokenPrice | string | null => {
  if (row.usd.trim() === '') return null
  if (!isAddress(row.token, { strict: false })) return `${row.token} is not a token address.`
  if (row.decimals === null) return `The decimals of ${row.token} could not be read from the chain.`
  if (!Number.isInteger(row.decimals) || row.decimals < 0 || row.decimals > 36)
    return `${row.token} has decimals out of range.`
  const price = usd(row.usd)
  if (price === null || price === 0n) return `Enter a USD price above 0 for ${row.token}, at most 18 decimals.`
  if (tokens.some((t) => t.token.toLowerCase() === row.token.toLowerCase())) return `${row.token} is listed twice.`
  return { token: getAddress(row.token), decimals: row.decimals, usdPrice: price }
}

/** The list a draft describes, or why it cannot be signed: what `parsePriceList` in the mining tool would refuse. */
export function priceListOf(d: PriceDraft): PriceList | string {
  if (!/^\d+$/.test(d.epoch.trim())) return 'Enter the epoch number.'
  const tokens: TokenPrice[] = []
  for (const row of d.tokens) {
    const result = tokenPrice(row, tokens)
    if (isString(result)) return result
    if (result !== null) tokens.push(result)
  }
  if (tokens.length === 0) return 'Price at least one token: fees in unpriced tokens do not count.'
  const factoryUsdPrice = usd(d.factoryUsd)
  if (factoryUsdPrice === null || factoryUsdPrice === 0n) return 'Enter the SIDE price in USD, above 0.'
  return { epoch: BigInt(d.epoch.trim()), tokens, factoryUsdPrice }
}
