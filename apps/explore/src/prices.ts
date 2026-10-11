/** The admin form shares its signed price-list contract with the SDK. */
import { parsePriceList, type Network, type PriceList, type TokenPrice } from '@sidequest/sdk'
import { formatUnits, getAddress, isAddress, parseUnits } from 'viem'
import testnet from '../../../contracts/config/monad-testnet.json' with { type: 'json' }
import mainnet from '../../../contracts/config/monad-mainnet.json' with { type: 'json' }

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
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The SDK deployment omits pool metadata; inspect only its presence in the same network config. */
export function miningPoolConfigured(network: Network): boolean {
  const config = network === 'monad-testnet' ? testnet : mainnet
  const mining: unknown = 'mining' in config ? config.mining : undefined
  return isRecord(mining) && Object.hasOwn(mining, 'officialPool') && mining.officialPool != null
}

/** Published epochs carry their signed list at top level; standalone prices carry the message directly. */
function priceListFrom(text: string, published: boolean): PriceList {
  const value: unknown = JSON.parse(text)
  return parsePriceList(published && isRecord(value) ? value.priceList : value)
}

export async function previousPricesOf(epoch: bigint, load: (name: string) => Promise<string | null>) {
  if (epoch === 0n) return { factoryUsd: null, missing: false }
  const previous = epoch - 1n
  const published = await load(`epoch-${previous}.json`)
  const prices = published === null ? await load(`prices-${previous}.json`) : null
  if (published === null && prices === null) return { factoryUsd: null, missing: true }
  const list = priceListFrom(published ?? prices ?? '', published !== null)
  if (list.epoch !== previous) throw new Error('The previous prices name another epoch')
  return { factoryUsd: formatUnits(list.factoryUsdPrice, 18), missing: false }
}

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
