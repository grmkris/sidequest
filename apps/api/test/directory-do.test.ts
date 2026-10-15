import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import * as Effect from 'effect/Effect'
import * as HttpBody from 'effect/http/HttpBody'
import * as HttpClient from 'effect/http/HttpClient'
import { afterAll, beforeAll as hookBeforeAll, expect } from 'vitest'
import * as sdk from '@sidequest/sdk'
import { zeroAddress, type Hex } from 'viem'
import { forkEnabled, startSidequestFork } from '../../../packages/sdk/test/sidequest-fixture.ts'
import { directoryObjectName } from '../src/directory-object.ts'
import DirectoryMainnetProbe from './directory-worker.ts'
import DirectoryDrainedProbe from './directory-drained-worker.ts'
import DirectoryTestnetProbe from './directory-testnet-worker.ts'
import type { DirectoryCall } from '../src/directory-object.ts'

const { test, beforeAll, deploy } = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  dev: true,
})
const Stack = Alchemy.Stack(
  'SidequestDirectoryLocalDrill',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const open = yield* DirectoryMainnetProbe,
      drained = yield* DirectoryDrainedProbe,
      testnet = yield* DirectoryTestnetProbe
    return { open: open.url!, drained: drained.url!, testnet: testnet.url! }
  }),
)
const stack = beforeAll(deploy(Stack))
const post = (url: string | undefined, body: unknown) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.post(url as string, {
      body: HttpBody.text(JSON.stringify(body), 'application/json'),
    })
    return (yield* response.json) as {
      ok: boolean
      code?: string
      message?: string
      retryAfter?: number
      result?: unknown
    }
  })
const request = (patch: Partial<DirectoryCall> = {}): DirectoryCall => ({
  network: 'monad-mainnet',
  rpcUrl: '',
  audience: 'https://test.invalid',
  agentId: '7',
  action: 'prepare',
  kind: 'Enrollment',
  payload: {},
  ...patch,
})

test(
  'real mainnet directory reaches identity verification without a session and binds its runtime network',
  Effect.gen(function* () {
    const { open } = yield* stack
    const config = sdk.deployment('monad-mainnet')
    const call = request({
      payload: {
        profile: { name: 'Probe', description: '', services: [] },
        delegate: zeroAddress,
        adDelegate: false,
        grantExpiresAt: 0,
        enrolled: true,
      },
    })
    const name = directoryObjectName(config.chainId, config.identity, call.audience, call.agentId)
    expect(yield* post(open, { name, call })).toMatchObject({ ok: false, code: 'chain' })
    const now = Math.floor(Date.now() / 1000)
    // SAFETY: call.payload above is the concrete enrollment payload supplied by this probe.
    const record: sdk.DirectoryEnvelope = {
      version: 1,
      kind: 'Enrollment',
      chainId: config.chainId,
      identityRegistry: config.identity,
      audience: call.audience,
      agentId: call.agentId,
      wallet: zeroAddress,
      generation: 1,
      nonce: 1,
      issuedAt: now,
      expiresAt: now + 300,
      payload: call.payload as Record<string, unknown>,
    }
    expect(yield* post(open, { name, call: { ...call, action: 'submit', record, signature: '0x00' } })).toMatchObject({
      ok: false,
      code: 'chain',
    })
    expect(yield* post(open, { name, call: { ...call, network: 'monad-testnet' } })).toMatchObject({
      ok: false,
      code: 'forbidden',
      message: 'directory runtime network mismatch',
    })
  }),
)

test(
  'real drained directory blocks new ads while revocation and opt-out reach the service',
  Effect.gen(function* () {
    const { drained } = yield* stack
    const config = sdk.deployment('monad-mainnet')
    const call = request({ kind: 'ServiceAd' })
    const name = directoryObjectName(config.chainId, config.identity, call.audience, call.agentId)
    expect(yield* post(drained, { name, call })).toMatchObject({
      ok: false,
      code: 'forbidden',
      message: 'directory listing is paused',
    })
    const profile = { name: 'Probe', description: '', services: [] }
    for (const more of [
      { kind: 'RevokeAd', payload: { serviceId: 'research' } },
      {
        kind: 'Enrollment',
        payload: { profile, delegate: zeroAddress, adDelegate: false, grantExpiresAt: 0, enrolled: false },
      },
    ])
      expect(yield* post(drained, { name, call: { ...call, ...more } })).toMatchObject({ ok: false, code: 'chain' })
  }),
)

test(
  'direct directory RPC canonicalizes host origins and refuses alternate objects and signed audiences',
  Effect.gen(function* () {
    const { testnet } = yield* stack
    const config = sdk.deployment('monad-testnet')
    const audience = `https://${crypto.randomUUID()}.test.invalid`
    const rawAudience = `${audience.toUpperCase()}:443`
    const name = directoryObjectName(config.chainId, config.identity, audience, '7')
    const call = request({ network: 'monad-testnet', audience: rawAudience, action: 'read' })
    expect(yield* post(testnet, { name, call })).toMatchObject({ ok: true, result: { agentId: '7', revision: 0 } })
    // A second spelling must use the same stored scope; storing the raw first value would refuse this read.
    expect(yield* post(testnet, { name, call: { ...call, audience } })).toMatchObject({
      ok: true,
      result: { agentId: '7', revision: 0 },
    })
    const rawName = `${config.chainId}:${config.identity.toLowerCase()}:${rawAudience}:7`
    expect(yield* post(testnet, { name: rawName, call })).toMatchObject({
      ok: false,
      code: 'forbidden',
      message: 'directory object identity mismatch',
    })
    for (const invalid of ['ftp://test.invalid', 'blob:https://test.invalid/id', 'not a URL']) {
      expect(yield* post(testnet, { name, call: { ...call, audience: invalid } })).toMatchObject({
        ok: false,
        code: 'invalid',
        message: 'directory audience must be an HTTP(S) origin',
      })
    }
    const now = Math.floor(Date.now() / 1000)
    const record: sdk.DirectoryEnvelope = {
      version: 1,
      kind: 'Enrollment',
      chainId: config.chainId,
      identityRegistry: config.identity,
      audience: rawAudience,
      agentId: '7',
      wallet: zeroAddress,
      generation: 1,
      nonce: 1,
      issuedAt: now,
      expiresAt: now + 300,
      payload: {
        profile: { name: 'Origin probe', description: '', services: [] },
        enrolled: true,
        delegate: zeroAddress,
        adDelegate: false,
        grantExpiresAt: 0,
      },
    }
    expect(
      yield* post(testnet, { name, call: { ...call, action: 'submit', record, signature: '0x00' } }),
    ).toMatchObject({ ok: false, code: 'forbidden', message: 'wrong chain, registry, audience, or agent' })
  }),
)

let fork: Awaited<ReturnType<typeof startSidequestFork>> | undefined
hookBeforeAll(async () => {
  if (forkEnabled) fork = await startSidequestFork()
}, 180_000)
afterAll(() => fork?.close())

test.skipIf(!forkEnabled)(
  'real directory object verifies the registry wallet and signature, replays enrollment once, and rejects aliased owners',
  Effect.gen(function* () {
    const { testnet } = yield* stack
    const f = fork!
    const agentId = (yield* Effect.promise(() =>
      sdk.registerAgent(f.ctx, f.worker, 'https://sidequest.exchange/directory-fork'),
    )).toString()
    const audience = `https://${crypto.randomUUID()}.test.invalid`
    const name = directoryObjectName(10143, f.ctx.deployment.identity, audience, agentId)
    const call = request({
      network: 'monad-testnet',
      agentId,
      audience,
      rpcUrl: f.url,
      payload: {
        profile: { name: 'Local fork worker', description: '', services: ['Research'] },
        enrolled: true,
        delegate: zeroAddress,
        adDelegate: false,
        grantExpiresAt: 0,
      },
    })
    expect(yield* post(testnet, { name: `alias-${name}`, call })).toMatchObject({
      ok: false,
      code: 'forbidden',
      message: 'directory object identity mismatch',
    })
    const prepared = yield* post(testnet, { name, call })
    expect(prepared.ok).toBe(true)
    const record = prepared.result as sdk.DirectoryEnvelope
    expect(record.wallet).toBe(f.worker.account.address)
    const badSignature = yield* Effect.promise(() => f.creator.signTypedData(sdk.directoryTypedData(record)))
    expect(
      yield* post(testnet, { name, call: { ...call, action: 'submit', record, signature: badSignature } }),
    ).toMatchObject({ ok: false, code: 'forbidden', message: 'invalid directory signature' })
    expect((yield* post(testnet, { name, call: { ...call, action: 'read' } })).result).toMatchObject({
      enrolled: false,
      revision: 0,
    })
    const signature = yield* Effect.promise(() => f.worker.signTypedData(sdk.directoryTypedData(record)))
    const submitted = { ...call, action: 'submit', record, signature: signature as Hex }
    expect((yield* post(testnet, { name, call: submitted })).result).toMatchObject({
      idempotent: false,
      agent: { enrolled: true, wallet: f.worker.account.address, revision: 1 },
    })
    expect((yield* post(testnet, { name, call: submitted })).result).toMatchObject({
      idempotent: true,
      agent: { enrolled: true, revision: 1 },
    })
    expect(yield* post(testnet, { name, call: { ...call, audience: 'https://evil.invalid' } })).toMatchObject({
      ok: false,
      code: 'forbidden',
      message: 'directory object identity mismatch',
    })
    expect((yield* post(testnet, { name, call: { ...call, action: 'read' } })).result).toMatchObject({
      enrolled: true,
      revision: 1,
    })
    const optOut = (yield* post(testnet, {
      name,
      call: { ...call, payload: { ...(call.payload as Record<string, unknown>), enrolled: false } },
    })).result as sdk.DirectoryEnvelope
    const revoke = yield* Effect.promise(() => f.worker.signTypedData(sdk.directoryTypedData(optOut)))
    expect(
      (yield* post(testnet, { name, call: { ...call, action: 'submit', record: optOut, signature: revoke } })).result,
    ).toMatchObject({ agent: { enrolled: false, revision: 2 } })
    expect((yield* post(testnet, { name, call: { ...call, action: 'read' } })).result).toMatchObject({
      enrolled: false,
      revision: 2,
    })
  }),
  { timeout: 180_000 },
)
