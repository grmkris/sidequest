import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { deployment } from './deployment.ts'
import {
  parsePriceList,
  parseSignedPriceList,
  priceListFile,
  priceTypedData,
  recoverPriceListSigner,
  verifiedPriceList,
  type PriceList,
} from './mining-prices.ts'

// Public anvil fixture key.
const owner = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const config = deployment('monad-testnet')
const distributor = config.sidequest!.distributor
const list: PriceList = {
  epoch: 2n,
  tokens: [{ token: config.rewardTokens[0]!, decimals: 6, usdPrice: 10n ** 18n }],
  factoryUsdPrice: 10n ** 14n,
}
const file = priceListFile(
  config.chainId,
  distributor,
  list,
  owner.address,
  await owner.signTypedData(priceTypedData(config.chainId, distributor, list)),
)

describe('mining signed price files', () => {
  it('parses exact integers and recovers an owner with a rebuilt domain', async () => {
    expect(parseSignedPriceList(file).prices).toEqual({
      ...list,
      tokens: list.tokens.map((token) => ({ ...token, token: token.token.toLowerCase() })),
    })
    const altered = { ...file, domain: { chainId: 999 } }
    expect(
      await verifiedPriceList(altered, { epoch: 2n, chainId: config.chainId, distributor, owners: [owner.address] }),
    ).toMatchObject({ signer: owner.address.toLowerCase() })
    expect(await recoverPriceListSigner(list, file.signature, config.chainId, distributor)).toBe(
      owner.address.toLowerCase(),
    )
  })

  it.each([
    null,
    [],
    {},
    { message: null },
    { message: { ...file.message, tokens: [null] } },
    { message: { ...file.message, epoch: 2 } },
    { message: { ...file.message, epoch: '-1' } },
    { message: { ...file.message, epoch: (1n << 256n).toString() } },
  ])('refuses malformed messages: %j', (value) => {
    expect(() => parsePriceList(value)).toThrow()
  })

  it.each([
    { token: 'bad', decimals: 6, usdPrice: '1' },
    { token: config.rewardTokens[0], decimals: 37, usdPrice: '1' },
    { token: config.rewardTokens[0], decimals: 1.5, usdPrice: '1' },
    { token: config.rewardTokens[0], decimals: 6, usdPrice: '0' },
    { token: config.rewardTokens[0], decimals: 6, usdPrice: '1.1' },
  ])('refuses invalid token rows: %j', (row) => {
    expect(() => parsePriceList({ message: { ...file.message, tokens: [row] } })).toThrow()
  })

  it('refuses duplicate tokens and zero SIDE prices', () => {
    expect(() =>
      parsePriceList({ message: { ...file.message, tokens: [...file.message.tokens, ...file.message.tokens] } }),
    ).toThrow(/twice/)
    expect(() => parsePriceList({ message: { ...file.message, factoryUsdPrice: '0' } })).toThrow(/SIDE/)
  })

  it('requires a signer and a 65-byte signature', async () => {
    expect(() => parseSignedPriceList({ ...file, signer: undefined })).toThrow(/signer/)
    expect(() => parseSignedPriceList({ ...file, signature: '0x' })).toThrow(/65 bytes/)
    await expect(recoverPriceListSigner(list, '0x', config.chainId, distributor)).rejects.toThrow(/65 bytes/)
  })

  it('refuses a wrong epoch, mismatched signer and non-owner', async () => {
    const expected = { epoch: 2n, chainId: config.chainId, distributor, owners: [owner.address] }
    await expect(verifiedPriceList(file, { ...expected, epoch: 3n })).rejects.toThrow(/epoch/)
    await expect(verifiedPriceList({ ...file, signer: distributor }, expected)).rejects.toThrow(/signer field/)
    await expect(verifiedPriceList(file, { ...expected, owners: [] })).rejects.toThrow(/owner/)
  })
})
