import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import * as Effect from 'effect/Effect'
import { expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import * as sdk from '@sidequest/sdk'
import MiningPricesProbe from './mining-prices-worker.ts'

const { test, beforeAll, deploy } = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  dev: true,
})
const Stack = Alchemy.Stack(
  'MiningPricesLocalTest',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const probe = yield* MiningPricesProbe
    return { probe: probe.url }
  }),
)
const stack = beforeAll(deploy(Stack))

test(
  'mining GET routes in real workerd allow only artifact names and serve real R2 bytes',
  Effect.gen(function* () {
    const urls = yield* stack
    yield* Effect.promise(async () => {
      if (urls.probe === undefined) throw new Error('local workers did not start')
      expect(await (await fetch(`${urls.probe}/runtime`)).text()).toBe('Cloudflare-Workers')
      for (const prefix of ['prices', 'previous-prices', 'pending-epoch', 'pending-state', 'epoch', 'state']) {
        const name = `${prefix}-${Date.now()}.json`
        expect((await fetch(`${urls.probe}/data/mining/${name}`)).status).toBe(404)
        const bytes = '{ "message": "stored é", "ok": false }\n'
        expect((await fetch(`${urls.probe}/seed/${name}`, { method: 'POST', body: bytes })).status).toBe(204)
        const response = await fetch(`${urls.probe}/data/mining/${name}`)
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('application/json')
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.text()).toBe(bytes)
      }
      for (const name of ['other-1.json', 'epoch-1.txt', 'prices.json', 'epoch--1.json', 'pending-epoch-1.json/'])
        expect((await fetch(`${urls.probe}/data/mining/${name}`)).status).toBe(400)
    })
  }),
)

test(
  'mining POST routes refuse oversize, bad shape, prod and absent RPC in real workerd',
  Effect.gen(function* () {
    const urls = yield* stack
    yield* Effect.promise(async () => {
      if (urls.probe === undefined) throw new Error('local workers did not start')
      // Public anvil key; no chain calls or transaction signer enters the local runtime.
      const owner = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
      const config = sdk.deployment('monad-testnet')
      const list: sdk.PriceList = { epoch: 2n, tokens: [], factoryUsdPrice: 10n ** 14n }
      const distributor = config.sidequest!.distributor
      const signature = await owner.signTypedData(sdk.priceTypedData(config.chainId, distributor, list))
      const prices = sdk.priceListFile(config.chainId, distributor, list, owner.address, signature)
      for (const [body, status, code] of [
        ['x'.repeat(64 * 1024 + 1), 413, 'body-too-large'],
        ['{}', 400, 'invalid-shape'],
        [JSON.stringify({ prices }), 503, 'rpc-unavailable'],
      ] as const) {
        const response = await fetch(`${urls.probe}/data/mining/prices`, {
          method: 'POST',
          body,
          headers: { 'content-type': 'application/json' },
        })
        expect(response.status).toBe(status)
        expect(await response.json()).toMatchObject({ ok: false, code })
      }
      const response = await fetch(`${urls.probe}/data/mining/prices`, {
        method: 'POST',
        body: '{}',
        headers: { 'x-probe-stage': 'prod' },
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ ok: false, code: 'pipeline-off' })
    })
  }),
)
