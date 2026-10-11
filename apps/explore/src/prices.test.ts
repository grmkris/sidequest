import { type Hex, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverPriceListSigner } from '@sidequest/sdk'
import { describe, expect, it } from 'vitest'
import { SIDE_PRICE_FLOOR, type PriceDraft, priceListFile, priceListOf, priceTypedData } from './prices.ts'

/**
 * The mining tool's own price-list code (scripts/mining/prices.ts, B8): what Explore signs must be exactly what it
 * verifies. Loaded by path so Explore's typecheck does not compile the scripts.
 */
interface Mining {
  PRICE_LIST_TYPES: unknown
  priceListDomain(chainId: number, distributor: string): unknown
  parsePriceList(file: { message: unknown }): unknown
  typedMessage(list: unknown): unknown
  recoverPriceListSigner(list: unknown, signature: Hex, chainId: number, distributor: string): Promise<string>
}
const mining = (await import(
  /* @vite-ignore */ new URL('../../../scripts/mining/prices.ts', import.meta.url).href
)) as Mining

const distributor = '0x00000000000000000000000000000000000000d1'
const usdc = '0x7547d9a4e8ab50c4a4a2f9a3c3b4d1f2e3a4b603'
const eur = '0x00000000000000000000000000000000000000e1'
// A public test key (anvil #0), never a real one.
const owner = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const draft: PriceDraft = {
  epoch: '0',
  factoryUsd: '0.0001',
  tokens: [
    { token: usdc, decimals: 6, usd: '1' },
    { token: eur, decimals: 6, usd: '1.08' },
    { token: '0x00000000000000000000000000000000000000f1', decimals: 18, usd: '' },
  ],
}

describe('the price list Explore signs', () => {
  it('is the mining tool’s typed data, field for field', () => {
    const list = priceListOf(draft)
    if (typeof list === 'string') throw new Error(list)
    const typed = priceTypedData(10143, distributor, list)
    const file = priceListFile(10143, distributor, list, owner.address, '0x00')
    const parsed = mining.parsePriceList({ message: file.message })
    expect(typed.types).toEqual(mining.PRICE_LIST_TYPES)
    // The tool checksums the distributor before building its domain (recoverPriceListSigner, sign-prices.ts).
    expect(typed.domain).toEqual(mining.priceListDomain(10143, getAddress(distributor)))
    expect(typed.message).toEqual(mining.typedMessage(parsed))
    expect(typed.message).toEqual({
      epoch: 0n,
      tokens: [
        { token: getAddress(usdc), decimals: 6, usdPrice: 10n ** 18n },
        { token: getAddress(eur), decimals: 6, usdPrice: 108n * 10n ** 16n },
      ],
      factoryUsdPrice: SIDE_PRICE_FLOOR,
    })
  })

  it('signs a file mining:epoch --prices accepts, recovering the owner', async () => {
    const list = priceListOf(draft)
    if (typeof list === 'string') throw new Error(list)
    const signature = await owner.signTypedData(priceTypedData(10143, distributor, list))
    const file = priceListFile(10143, distributor, list, owner.address, signature)
    // What the tool does with --prices: parse the message, rebuild the domain itself, recover the signer.
    const recovered = await mining.recoverPriceListSigner(
      mining.parsePriceList(JSON.parse(JSON.stringify(file)) as { message: unknown }),
      signature,
      10143,
      distributor,
    )
    expect(recovered).toBe(owner.address.toLowerCase())
    expect(await recoverPriceListSigner(list, signature, 10143, distributor)).toBe(recovered)
    expect(file.signer).toBe(recovered)
    // Bound to the chain and the distributor: the same signature does not recover the owner elsewhere.
    expect(await mining.recoverPriceListSigner(mining.parsePriceList(file), signature, 143, distributor)).not.toBe(
      recovered,
    )
    expect(await mining.recoverPriceListSigner(mining.parsePriceList(file), signature, 10143, eur)).not.toBe(recovered)
  })

  it('refuses what the tool would refuse, before anything is signed', () => {
    expect(priceListOf({ ...draft, epoch: '' })).toMatch(/epoch/)
    expect(priceListOf({ ...draft, tokens: [] })).toMatch(/at least one token/)
    expect(priceListOf({ ...draft, tokens: [{ token: usdc, decimals: 6, usd: '0' }] })).toMatch(/above 0/)
    expect(priceListOf({ ...draft, tokens: [{ token: usdc, decimals: 6, usd: '1.0000000000000000001' }] })).toMatch(
      /18 decimals/,
    )
    expect(
      priceListOf({
        ...draft,
        tokens: [
          { token: usdc, decimals: 6, usd: '1' },
          { token: usdc.toUpperCase().replace('0X', '0x'), decimals: 6, usd: '1' },
        ],
      }),
    ).toMatch(/twice/)
    expect(priceListOf({ ...draft, tokens: [{ token: usdc, decimals: null, usd: '1' }] })).toMatch(/decimals/)
    expect(priceListOf({ ...draft, tokens: [{ token: '0x12', decimals: 6, usd: '1' }] })).toMatch(/not a token address/)
    expect(priceListOf({ ...draft, factoryUsd: '0' })).toMatch(/SIDE price/)
  })
})
