import { expect, it, vi } from 'vitest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { privateKeyToAccount } from 'viem/accounts'
import { type Address, type Hex, zeroHash } from 'viem'
import * as sdk from '@sidequest/sdk'
import {
  miningFileResponse,
  miningRoute,
  postMiningPrices,
  MINING_PRICE_BODY_LIMIT,
  type MiningBucket,
} from '../src/mining-prices.ts'

// Public anvil fixture key.
const owner = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const deployment = sdk.deployment('monad-testnet')
const distributor = deployment.sidequest!.distributor
const list: sdk.PriceList = {
  epoch: 2n,
  tokens: [{ token: deployment.rewardTokens[0]!, decimals: 6, usdPrice: 10n ** 18n }],
  factoryUsdPrice: 10n ** 14n,
}

async function signed(prices = list, chainId = deployment.chainId, target = distributor) {
  const signature = await owner.signTypedData(sdk.priceTypedData(chainId, target, prices))
  return sdk.priceListFile(chainId, target, prices, owner.address, signature)
}

class Bucket implements MiningBucket {
  readonly values = new Map<string, string>()
  corrupt = false
  async put(key: string, value: string) {
    this.values.set(key, value)
    return {}
  }
  async get(key: string) {
    const value = this.values.get(key)
    return value === undefined
      ? null
      : {
          text: async () => (this.corrupt ? 'corrupt' : value),
          arrayBuffer: async () => new TextEncoder().encode(value).buffer,
        }
  }
}

function fixture(overrides: { end?: bigint; owners?: readonly Address[]; hash?: Hex; failed?: boolean } = {}) {
  const readContract = vi.fn(async (request: { functionName: string }) => {
    if (overrides.failed) throw new Error('private provider details')
    switch (request.functionName) {
      case 'getOwners':
        return overrides.owners ?? [owner.address]
      case 'epochEnd':
        return overrides.end ?? 100n
      case 'rootOf':
        return { root: zeroHash, total: 0n, claimed: 0n, dataHash: overrides.hash ?? zeroHash }
      default:
        throw new Error('unexpected chain read')
    }
  })
  const client = sdk.context('monad-testnet', 'main', 'https://unit.invalid').publicClient
  // SAFETY: the route only reads timestamp and number from this unit fixture block; no transport is called.
  vi.spyOn(client, 'getBlock').mockResolvedValue({ timestamp: 100n, number: 5n } as never)
  // SAFETY: the fixture returns the generated ABI's exact types for every function the route reads.
  vi.spyOn(client, 'readContract').mockImplementation(readContract)
  const bucket = new Bucket()
  return { client, bucket, readContract, stage: 'dev', deployment }
}

it('accepts a live owner, checks deployed contracts at one block and writes canonical bytes', async () => {
  const input = fixture()
  const prices = await signed()
  const previous = await signed({ ...list, epoch: 1n })
  const reply = await postMiningPrices({ ...input, body: JSON.stringify({ prices, previous }) })
  expect(reply).toEqual({
    status: 200,
    body: {
      ok: true,
      epoch: '2',
      signer: owner.address.toLowerCase(),
      keys: ['mining/prices-2.json', 'mining/previous-prices-2.json'],
    },
  })
  expect(input.bucket.values.get('mining/prices-2.json')).toBe(JSON.stringify(prices, null, 2) + '\n')
  expect(input.bucket.values.get('mining/previous-prices-2.json')).toBe(JSON.stringify(previous, null, 2) + '\n')
  expect(input.readContract).toHaveBeenCalledWith(
    expect.objectContaining({ address: deployment.sidequest!.safe, functionName: 'getOwners', blockNumber: 5n }),
  )
  expect(input.readContract).toHaveBeenCalledWith(
    expect.objectContaining({ address: distributor, functionName: 'epochEnd', args: [2n], blockNumber: 5n }),
  )
  expect(input.readContract).toHaveBeenCalledWith(
    expect.objectContaining({ address: distributor, functionName: 'rootOf', args: [2n], blockNumber: 5n }),
  )
})

it.each([
  [{ owners: [] }, 403, 'not-owner'],
  [{ end: 101n }, 409, 'epoch-not-ended'],
  [{ hash: `0x${'1'.repeat(64)}` }, 409, 'already-rooted'],
  [{ failed: true }, 503, 'rpc-unavailable'],
] as const)('refuses chain state case %#', async (overrides, status, code) => {
  const input = fixture(overrides)
  const reply = await postMiningPrices({ ...input, body: JSON.stringify({ prices: await signed() }) })
  expect(reply).toMatchObject({ status, body: { ok: false, code } })
  expect(JSON.stringify(reply)).not.toContain('private provider')
  expect(input.bucket.values.size).toBe(0)
})

it('refuses signatures for a wrong chain or distributor and a corrupt 65-byte signature', async () => {
  const files = [
    await signed(list, 143),
    await signed(list, deployment.chainId, deployment.sidequest!.safe),
    { ...(await signed()), signature: `0x${'0'.repeat(130)}` },
  ]
  for (const prices of files) {
    const input = fixture()
    expect(await postMiningPrices({ ...input, body: JSON.stringify({ prices }) })).toMatchObject({
      status: 403,
      body: { code: 'invalid-signature' },
    })
    expect(input.bucket.values.size).toBe(0)
  }
})

it('treats the supplied domain as informational and permits a last write while unrooted', async () => {
  const input = fixture()
  const first = { ...(await signed()), domain: { chainId: 0 } }
  const second = await signed({ ...list, factoryUsdPrice: 2n * list.factoryUsdPrice })
  for (const prices of [first, second])
    expect((await postMiningPrices({ ...input, body: JSON.stringify({ prices }) })).status).toBe(200)
  expect(input.bucket.values.get('mining/prices-2.json')).toBe(JSON.stringify(second, null, 2) + '\n')
})

it('refuses previous lists with a wrong epoch, reference price, signer or owner', async () => {
  const prices = await signed()
  const cases = [
    [await signed(), 'previous-epoch'],
    [await signed({ ...list, epoch: 1n, factoryUsdPrice: 1n }), 'previous-price'],
    [{ ...(await signed({ ...list, epoch: 1n })), signer: distributor }, 'invalid-signature'],
  ] as const
  for (const [previous, code] of cases) {
    const input = fixture()
    expect(await postMiningPrices({ ...input, body: JSON.stringify({ prices, previous }) })).toMatchObject({
      body: { code },
    })
    expect(input.bucket.values.size).toBe(0)
  }
  const other = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
  const prev = { ...list, epoch: 1n }
  const previous = sdk.priceListFile(
    deployment.chainId,
    distributor,
    prev,
    other.address,
    await other.signTypedData(sdk.priceTypedData(deployment.chainId, distributor, prev)),
  )
  expect(await postMiningPrices({ ...fixture(), body: JSON.stringify({ prices, previous }) })).toMatchObject({
    body: { code: 'not-owner' },
  })
})

it('refuses oversized bodies, malformed files, prod and a missing RPC without writing', async () => {
  const input = fixture()
  expect(await postMiningPrices({ ...input, body: 'x'.repeat(MINING_PRICE_BODY_LIMIT + 1) })).toMatchObject({
    status: 413,
  })
  for (const body of ['bad json', '[]', '{}', JSON.stringify({ prices: { ...(await signed()), signature: '0x' } })])
    expect(await postMiningPrices({ ...input, body })).toMatchObject({ status: 400, body: { code: 'invalid-shape' } })
  const body = JSON.stringify({ prices: await signed() })
  expect(await postMiningPrices({ ...input, stage: 'prod', body })).toMatchObject({
    status: 403,
    body: { code: 'pipeline-off' },
  })
  expect(await postMiningPrices({ ...input, client: undefined, body })).toMatchObject({
    status: 503,
    body: { code: 'rpc-unavailable' },
  })
  expect(input.bucket.values.size).toBe(0)
})

it('requires successful readback of both files', async () => {
  const input = fixture()
  input.bucket.corrupt = true
  expect(await postMiningPrices({ ...input, body: JSON.stringify({ prices: await signed() }) })).toMatchObject({
    status: 503,
    body: { code: 'storage-unavailable' },
  })
})

it('serves only the six allowed names and returns exact stored bytes without caching', async () => {
  const bucket = new Bucket()
  for (const prefix of ['prices', 'previous-prices', 'pending-epoch', 'pending-state', 'epoch', 'state']) {
    const name = `${prefix}-2.json`
    expect((await miningFileResponse(bucket, name)).status).toBe(404)
    const bytes = '{ "ok": false, "unicode": "é" }\n'
    await bucket.put(`mining/${name}`, bytes)
    const response = HttpServerResponse.toWeb(await miningFileResponse(bucket, name))
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe(bytes)
  }
  for (const name of ['prices.json', 'epoch-2.txt', '../secret.json', 'other-2.json', 'epoch--2.json', 'state-2.json/'])
    expect((await miningFileResponse(bucket, name)).status).toBe(400)
})

it('counts streamed UTF-8 bytes and rejects declared or actual oversize bodies before chain reads', async () => {
  const input = fixture()
  for (const request of [
    new Request('https://unit.invalid/data/mining/prices', {
      method: 'POST',
      body: 'small',
      headers: { 'content-length': String(MINING_PRICE_BODY_LIMIT + 1) },
    }),
    new Request('https://unit.invalid/data/mining/prices', {
      method: 'POST',
      body: 'é'.repeat(MINING_PRICE_BODY_LIMIT / 2 + 1),
    }),
  ])
    expect((await miningRoute(request, '/data/mining/prices', input)).status).toBe(413)
  expect(input.readContract).not.toHaveBeenCalled()
})
