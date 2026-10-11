import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Address, type Hex, verifyTypedData, zeroAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { type DirectoryEnvelope, directoryTypedData } from '@sidequest/sdk'
import { DirectoryService } from './directory.ts'
import { fromNodeSqlite } from './store.ts'

const registry: Address = '0x8004A818BFB912233c491871b3d84c89A494BD9e'
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function fixture() {
  const database = new DatabaseSync(':memory:')
  databases.push(database)
  const account = privateKeyToAccount(generatePrivateKey())
  const delegate = privateKeyToAccount(generatePrivateKey())
  let now = 1_800_000_000
  let wallet: Address = account.address
  let unavailable = false
  const verify = vi.fn(async (signer: Address, record: DirectoryEnvelope, signature: Hex) =>
    verifyTypedData({ address: signer, ...directoryTypedData(record), signature }),
  )
  const deps = {
    sql: fromNodeSqlite(database),
    chainId: 10143,
    identityRegistry: registry,
    audience: 'https://testnet.example',
    agentId: '4242',
    now: () => now,
    readIdentity: async () => {
      if (unavailable) throw new Error('RPC unavailable')
      return { wallet, agentURI: 'https://example.test/agent.json' }
    },
    verify,
  }
  const service = new DirectoryService(deps)
  const sign = (record: DirectoryEnvelope, signer = account) => signer.signTypedData(directoryTypedData(record))
  const submit = async (record: DirectoryEnvelope, signer = account) =>
    service.submit(record, await sign(record, signer))
  const enroll = async (delegated = false) =>
    submit(
      await service.prepare('Enrollment', {
        profile: { name: 'Quill', description: 'Research and writing', services: ['Research'] },
        enrolled: true,
        delegate: delegated ? delegate.address : zeroAddress,
        adDelegate: delegated,
        grantExpiresAt: delegated ? now + 3600 : 0,
      }),
    )
  const beat = () =>
    service.prepare('Heartbeat', {
      state: 'available',
      capacity: 1,
      sessionId: 'private-process-session',
      capabilitiesHash: `0x${'11'.repeat(32)}`,
      endpointHash: `0x${'22'.repeat(32)}`,
    })
  const ad = () =>
    service.prepare(
      'ServiceAd',
      {
        serviceId: 'research',
        name: 'Source-backed research',
        description: 'Advisory only',
        inputs: 'A public question',
        outputs: 'A report with sources',
        turnaroundSeconds: 3600,
        price: { model: 'quote', amountBaseUnits: '0', token: zeroAddress },
      },
      now + 3600,
    )
  return {
    database,
    account,
    delegate,
    deps,
    service,
    sign,
    submit,
    enroll,
    beat,
    ad,
    verify,
    advance: (seconds: number) => {
      now += seconds
    },
    rotate: (value: Address) => {
      wallet = value
    },
    outage: (value: boolean) => {
      unavailable = value
    },
  }
}

describe('signed directory', () => {
  it('enrolls a zero-job identity and keeps chain job tables untouched', async () => {
    const context = fixture()
    context.database.exec(
      "CREATE TABLE jobs (id INTEGER PRIMARY KEY, state TEXT); INSERT INTO jobs VALUES (61, 'open')",
    )
    const result = await context.enroll()
    expect(result.agent).toMatchObject({
      agentId: '4242',
      enrolled: true,
      ownership: 'verified',
      profileSource: 'operator-supplied',
      presence: { freshness: 'unknown', accepting: false },
    })
    await context.submit(await context.beat())
    expect(context.database.prepare('SELECT state FROM jobs WHERE id = 61').get()).toEqual({ state: 'open' })
  })

  it('expires a heartbeat at read time while retaining the agent and ads', async () => {
    const context = fixture()
    await context.enroll()
    await context.submit(await context.ad())
    const result = await context.submit(await context.beat())
    expect(result.agent.presence).toMatchObject({ freshness: 'fresh', accepting: true })
    context.advance(61)
    const stale = await context.service.read()
    expect(stale.enrolled).toBe(true)
    expect(stale.presence).toMatchObject({ freshness: 'stale', accepting: false })
    expect(stale.ads).toHaveLength(1)
  })

  it('limits expiry/skew and supports idempotent retry without extending the lease', async () => {
    const context = fixture()
    await context.enroll()
    const record = await context.beat()
    const accepted = await context.submit(record)
    context.advance(5)
    const repeated = await context.submit(record)
    expect(repeated.idempotent).toBe(true)
    expect(repeated.agent.revision).toBe(accepted.agent.revision)
    expect(context.service.state().heartbeat?.expiresAt).toBe(record.expiresAt)
    const replay = { ...record, payload: { ...record.payload, capacity: 2 } }
    await expect(context.submit(replay)).rejects.toThrow(/replayed nonce/)
    const future = await context.beat()
    future.expiresAt += 120
    await expect(context.submit(future)).rejects.toThrow(/validity window/)
    const old = await context.beat()
    old.issuedAt -= 11
    await expect(context.submit(old)).rejects.toThrow(/validity window/)
  })

  it.each(['chainId', 'identityRegistry', 'audience', 'agentId'] as const)(
    'rejects a different %s binding before signature verification',
    async (field) => {
      const context = fixture()
      await context.enroll()
      context.verify.mockClear()
      const record = await context.beat()
      const altered = {
        ...record,
        [field]:
          field === 'chainId'
            ? 143
            : field === 'identityRegistry'
              ? zeroAddress
              : field === 'agentId'
                ? '99'
                : 'https://evil.example',
      }
      await expect(context.service.submit(altered, '0x1234')).rejects.toThrow(
        /wrong chain, registry, audience, or agent/,
      )
      expect(context.verify).not.toHaveBeenCalled()
    },
  )

  it('accepts only valid current-wallet or scoped-delegate signatures', async () => {
    const context = fixture()
    await context.enroll(true)
    const record = await context.beat()
    expect((await context.submit(record, context.delegate)).agent.presence.accepting).toBe(true)
    context.advance(20)
    const manual = await context.beat()
    expect((await context.submit(manual)).agent.presence.accepting).toBe(true)
    context.advance(20)
    const bad = await context.beat()
    const stranger = privateKeyToAccount(generatePrivateKey())
    await expect(context.submit(bad, stranger)).rejects.toThrow(/invalid directory signature/)
  })

  it('injects ERC-1271 verification without recovering the contract address as an EOA', async () => {
    const context = fixture()
    const smartWallet = '0x0000000000000000000000000000000000000127' as Address
    context.rotate(smartWallet)
    context.deps.verify = vi.fn(async (signer, _record, signature) => signer === smartWallet && signature === '0x1234')
    const service = new DirectoryService(context.deps)
    const record = await service.prepare('Enrollment', {
      profile: { name: 'Smart wallet agent', description: '', services: [] },
      enrolled: true,
      delegate: zeroAddress,
      adDelegate: false,
      grantExpiresAt: 0,
    })
    expect((await service.submit(record, '0x1234')).agent.wallet).toBe(smartWallet)
    expect(context.deps.verify).toHaveBeenCalledWith(smartWallet, record, '0x1234')
  })

  it('revokes old generations on wallet rotation, opt-out, and re-enrollment', async () => {
    const context = fixture()
    await context.enroll(true)
    const oldBeat = await context.beat()
    await context.submit(oldBeat, context.delegate)
    await context.submit(await context.ad(), context.delegate)
    context.advance(31)
    context.rotate(privateKeyToAccount(generatePrivateKey()).address)
    const changed = await context.service.read()
    expect(changed.ownership).toBe('changed')
    expect(changed.enrolled).toBe(false)
    expect(changed.presence.freshness).toBe('unknown')
    expect(changed.ads).toHaveLength(0)
    await expect(context.submit(oldBeat, context.delegate)).rejects.toThrow(/current ERC-8004 agent wallet/)
    context.rotate(context.account.address)
    await context.enroll()
    await expect(context.submit(oldBeat, context.delegate)).rejects.toThrow(/stale generation/)
    const out = await context.service.prepare('Enrollment', {
      profile: { name: 'Quill', description: '', services: [] },
      enrolled: false,
      delegate: zeroAddress,
      adDelegate: false,
      grantExpiresAt: 0,
    })
    expect((await context.submit(out)).agent.enrolled).toBe(false)
    await expect(context.submit(await context.beat())).rejects.toThrow(/enroll the current wallet/)
  })

  it('rejects wallet rotation while asynchronous signature verification is pending', async () => {
    const context = fixture()
    await context.enroll()
    const record = await context.beat()
    context.deps.verify = vi.fn(async () => {
      context.rotate(privateKeyToAccount(generatePrivateKey()).address)
      return true
    })
    await expect(context.submit(record)).rejects.toThrow(/wallet changed during verification/)
    expect(context.service.state().heartbeat).toBeNull()
  })

  it('keeps the signed opt-out tombstone available for a projection retry', async () => {
    const context = fixture()
    await context.enroll()
    const out = await context.service.prepare('Enrollment', {
      profile: { name: 'Quill', description: '', services: [] },
      enrolled: false,
      delegate: zeroAddress,
      adDelegate: false,
      grantExpiresAt: 0,
    })
    const first = await context.submit(out)
    const retry = await context.submit(out)
    expect(first.projection?.enrolled).toBe(false)
    expect(retry.idempotent).toBe(true)
    expect(retry.projection?.enrolled).toBe(false)
  })

  it('marks registry outage unknown and rejects mutation, without deleting enrollment', async () => {
    const context = fixture()
    await context.enroll()
    const record = await context.beat()
    await context.submit(record)
    context.outage(true)
    await expect(context.submit(record)).rejects.toThrow(/identity registry unavailable/)
    expect(context.service.publicView()).toMatchObject({
      enrolled: true,
      ownership: 'unknown',
      presence: { freshness: 'unknown', accepting: false },
    })
  })

  it('keeps price and expiry independent of heartbeat; revocation leaves a replay tombstone', async () => {
    const context = fixture()
    await context.enroll()
    const ad = await context.ad()
    await context.submit(ad)
    const prior = context.service.publicView().ads[0]
    await context.submit(await context.beat())
    expect(context.service.publicView().ads[0]).toEqual(prior)
    const revoke = await context.service.prepare('RevokeAd', { serviceId: 'research' })
    await context.submit(revoke)
    expect(context.service.publicView().ads).toEqual([])
    expect(context.service.state().ads.research?.revoked).toBe(true)
    expect((await context.submit(ad)).idempotent).toBe(true)
    expect(context.service.publicView().ads).toEqual([])
  })

  it('does not expose delegate, signature, nonce, session or endpoint data', async () => {
    const context = fixture()
    await context.enroll(true)
    await context.submit(await context.beat(), context.delegate)
    const json = JSON.stringify(context.service.publicView())
    for (const privateField of [
      'delegate',
      'signature',
      'nonce',
      'sessionId',
      'endpointHash',
      'private-process-session',
    ])
      expect(json).not.toContain(privateField)
    expect(context.service.publicView().presence.lastSeenBucket! % 60).toBe(0)
  })

  it('rejects oversized/unknown fields and limits accepted beats before persisting', async () => {
    const context = fixture()
    await context.enroll()
    const record = await context.beat()
    await expect(context.submit({ ...record, payload: { ...record.payload, role: 'approver' } })).rejects.toThrow(
      /unknown directory field/,
    )
    for (let index = 0; index < 8; index++) await context.submit(await context.beat())
    await expect(context.submit(await context.beat())).rejects.toThrow(/rate limit/)
    expect(context.service.state().beats).toHaveLength(8)
  })

  it('rejects concurrent snapshots rather than accepting conflicting replay state', async () => {
    const context = fixture()
    await context.enroll()
    const first = await context.beat()
    const second = { ...first, payload: { ...first.payload, capacity: 2 } }
    const results = await Promise.allSettled([context.submit(first), context.submit(second)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })
})
