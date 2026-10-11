import { getAddress, isAddress, recoverTypedDataAddress, type Address, type Hex } from 'viem'

export const PRICE_LIST_TYPES = {
  PriceList: [
    { name: 'epoch', type: 'uint256' },
    { name: 'tokens', type: 'TokenPrice[]' },
    { name: 'factoryUsdPrice', type: 'uint256' },
  ],
  TokenPrice: [
    { name: 'token', type: 'address' },
    { name: 'decimals', type: 'uint8' },
    { name: 'usdPrice', type: 'uint256' },
  ],
} as const

export const PRICE_LIST_DOMAIN_NAME = 'Sidequest Mining Prices'
export const PRICE_LIST_DOMAIN_VERSION = '1'
export const SIDE_PRICE_FLOOR = 10n ** 14n

export interface TokenPrice {
  token: Address
  decimals: number
  usdPrice: bigint
}

export interface PriceList {
  epoch: bigint
  tokens: TokenPrice[]
  factoryUsdPrice: bigint
}

export interface PriceListFile {
  domain?: unknown
  message: {
    epoch: string
    tokens: Array<{ token: string; decimals: number; usdPrice: string }>
    factoryUsdPrice: string
  }
  signer?: string
  signature?: string
}

export const safeGetOwnersAbi = [
  {
    type: 'function',
    name: 'getOwners',
    inputs: [],
    outputs: [{ name: '', type: 'address[]' }],
    stateMutability: 'view',
  },
] as const

export function priceListDomain(chainId: number, distributor: string) {
  return {
    name: PRICE_LIST_DOMAIN_NAME,
    version: PRICE_LIST_DOMAIN_VERSION,
    chainId,
    verifyingContract: getAddress(distributor),
  } as const
}

const uint = (value: unknown, what: string): bigint => {
  if (!isString(value) || !/^\d+$/.test(value)) throw new Error(`price list: ${what} must be a decimal string`)
  const result = BigInt(value)
  if (result >= 1n << 256n) throw new Error(`price list: ${what} exceeds uint256`)
  return result
}

const record = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error('price list: expected an object')
  return value
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isNumber = (value: unknown): value is number => typeof value === 'number'
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseTokenPrice(value: unknown, index: number): TokenPrice {
  const token = record(value)
  if (!isString(token.token) || !isAddress(token.token, { strict: false }))
    throw new Error(`price list: token ${index} is not an address`)
  if (!isNumber(token.decimals) || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36)
    throw new Error(`price list: token ${index} decimals`)
  const usdPrice = uint(token.usdPrice, `token ${index} usdPrice`)
  if (usdPrice === 0n) throw new Error(`price list: token ${index} has no price`)
  // SAFETY: viem checked the address shape above; lowercase preserves the address.
  return { token: token.token.toLowerCase() as Address, decimals: token.decimals, usdPrice }
}

/** Parses the signed file's message and rejects malformed or ambiguous values. */
export function parsePriceList(value: unknown): PriceList {
  const message = record(record(value).message)
  if (!Array.isArray(message.tokens)) throw new Error('price list: no tokens')
  const tokens = message.tokens.map(parseTokenPrice)
  if (new Set(tokens.map((token) => token.token)).size !== tokens.length)
    throw new Error('price list: a token is listed twice')
  const factoryUsdPrice = uint(message.factoryUsdPrice, 'factoryUsdPrice')
  if (factoryUsdPrice === 0n) throw new Error('price list: no SIDE price')
  return { epoch: uint(message.epoch, 'epoch'), tokens, factoryUsdPrice }
}

/** Domain is informational: verification always rebuilds it from the deployment. */
export function parseSignedPriceList(value: unknown) {
  const prices = parsePriceList(value)
  const file = record(value)
  if (!isString(file.signer) || !isAddress(file.signer, { strict: false }))
    throw new Error('price list: signer is not an address')
  if (!isString(file.signature) || !/^0x[0-9a-fA-F]{130}$/.test(file.signature))
    throw new Error('price list: signature must be 65 bytes')
  // SAFETY: the message, signer and signature were checked above; retain the uploaded file's exact JSON shape.
  return { prices, file: value as PriceListFile & { signer: string; signature: Hex } }
}

export function typedMessage(list: PriceList) {
  return {
    epoch: list.epoch,
    tokens: list.tokens.map((token) => ({
      token: getAddress(token.token),
      decimals: token.decimals,
      usdPrice: token.usdPrice,
    })),
    factoryUsdPrice: list.factoryUsdPrice,
  }
}

export function priceTypedData(chainId: number, distributor: string, list: PriceList) {
  return {
    domain: priceListDomain(chainId, distributor),
    types: PRICE_LIST_TYPES,
    primaryType: 'PriceList' as const,
    message: typedMessage(list),
  }
}

export function priceListFile(chainId: number, distributor: string, list: PriceList, signer: string, signature: Hex) {
  return {
    domain: priceListDomain(chainId, distributor),
    message: {
      epoch: list.epoch.toString(),
      tokens: list.tokens.map((token) => ({
        token: getAddress(token.token),
        decimals: token.decimals,
        usdPrice: token.usdPrice.toString(),
      })),
      factoryUsdPrice: list.factoryUsdPrice.toString(),
    },
    signer: signer.toLowerCase(),
    signature,
  }
}

export async function recoverPriceListSigner(
  list: PriceList,
  signature: Hex,
  chainId: number,
  distributor: Address,
): Promise<Address> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('price list signature must be 65 bytes')
  const signer = await recoverTypedDataAddress({
    domain: priceListDomain(chainId, distributor),
    types: PRICE_LIST_TYPES,
    primaryType: 'PriceList',
    message: typedMessage(list),
    signature,
  })
  // SAFETY: viem returns an address and lowercasing preserves it.
  return signer.toLowerCase() as Address
}

export async function verifiedPriceList(
  file: unknown,
  expected: { epoch: bigint; chainId: number; distributor: Address; owners: readonly Address[] },
) {
  const { prices, file: candidate } = parseSignedPriceList(file)
  if (prices.epoch !== expected.epoch) throw new Error('signed price list has the wrong epoch')
  const signer = await recoverPriceListSigner(prices, candidate.signature, expected.chainId, expected.distributor)
  if (candidate.signer.toLowerCase() !== signer)
    throw new Error('price list signer field differs from recovered signer')
  if (!expected.owners.some((owner) => owner.toLowerCase() === signer))
    throw new Error('price list signer is not a current Safe owner')
  return { prices, signer, signature: candidate.signature }
}
