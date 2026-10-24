import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { type Address, verifyTypedData, zeroAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentDirectory, type DirectoryPort } from './agent-directory.ts'
import { AgentSigning } from './agent-signing.ts'
import { AgentStore } from './agents.ts'
import { DirectoryError, DirectoryService } from './directory.ts'
import { migrateAgentSchema } from './agent-schema.ts'
import { fromNodeSqlite } from './store.ts'
import { AgentProfiles } from './agent-profiles.ts'

const deployment = sdk.deployment('monad-testnet')
const context = { deployment, stack: sdk.stack(deployment, 'main'), publicClient: {} } as unknown as sdk.Ctx
const audience = 'https://dev.sidequest.exchange'
const operator: Address = '0x2222222222222222222222222222222222222222'
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

const ad = {
  serviceId: 'review',
  name: 'Code review',
  description: 'One pull request',
  inputs: 'A PR link',
  outputs: 'Review comments',
  turnaroundSeconds: 3600,
  price: { model: 'quote', amountBaseUnits: '0', token: zeroAddress },
}

function fixture() {
  const key = privateKeyToAccount(generatePrivateKey())
  const board = new DatabaseSync(':memory:'),
    object = new DatabaseSync(':memory:')
  databases.push(board, object)
  let now = 1_800_000_000
  const clock = () => now
  const sql = fromNodeSqlite(board)
  migrateAgentSchema(sql)
  const agents = new AgentStore(sql, clock)
  agents.create({
    id: 'lister',
    operator,
    privyUserId: 'did:privy:lister',
    name: 'Quill',
    registry: deployment.identity,
    chainId: deployment.chainId,
  })
  agents.bindWallet('lister', 'lister-wallet', key.address)
  agents.bindRegistry('lister', '2013')
  let signed = 0
  const signing = new AgentSigning(
    sql,
    context,
    {
      signTypedData: async (_wallet, typedData) => {
        signed++
        return key.signTypedData(JSON.parse(typedData))
      },
      signAuthorization: async () => {
        throw new Error('unused')
      },
    },
    clock,
  )
  const service = new DirectoryService({
    sql: fromNodeSqlite(object),
    chainId: deployment.chainId,
    identityRegistry: deployment.identity,
    audience,
    agentId: '2013',
    now: clock,
    readIdentity: async () => ({ wallet: key.address, agentURI: 'data:application/json,{}' }),
    verify: async (address, record, signature) =>
      verifyTypedData({ address, ...sdk.directoryTypedData(record), signature }),
  })
  const calls: string[] = []
  const port: DirectoryPort = {
    read: async () => {
      calls.push('read')
      return service.read()
    },
    prepare: async (kind, payload) => {
      calls.push(`prepare:${kind}`)
      return service.prepare(kind, payload)
    },
    submit: async (record, signature) => {
      calls.push(`submit:${record.kind}`)
      return (await service.submit(record, signature)).agent
    },
  }
  const directory = new AgentDirectory({ agents, signing, audience, boardId: 'public', port })
  return {
    directory,
    agents,
    profiles: new AgentProfiles(sql, clock),
    service,
    port,
    calls,
    signedCount: () => signed,
    advance: (seconds: number) => {
      now += seconds
    },
  }
}

describe('a hosted agent listing itself', () => {
  it('preserves the directory quota retry delay and same-key recovery', async () => {
    const f = fixture()
    f.port.read = async () => {
      throw new DirectoryError('rate-limited', 'directory mutation limit reached', 23)
    }
    await expect(f.directory.advertise('lister', 'limited', ad)).rejects.toMatchObject({
      code: 'rate-limited',
      reason: 'directory-rate-limited',
      retry: 'same-key',
      retryAfter: 23,
    })
  })

  it('uses the stored description for first enrollment', async () => {
    const f = fixture()
    f.profiles.update('lister', { description: 'Careful code review' }, 'owner')
    expect((await f.directory.advertise('lister', 'list-1', ad)).profile.description).toBe('Careful code review')
  })

  it('re-enrolls a changed profile and keeps every live ad live, including ten long names', async () => {
    const f = fixture()
    for (let i = 0; i < 10; i++)
      await f.directory.advertise('lister', `list-${i}`, {
        ...ad,
        serviceId: `service-${i}`,
        name: `${i}${'x'.repeat(99)}`,
      })
    const operation = f.agents.begin('lister', 'profile-1', 'public', 'update_profile', { name: 'New name' })
    await f.directory.refreshProfile('lister', operation.id, { name: 'New name', description: 'Current description' })
    const listing = await f.service.read()
    expect(listing.profile).toMatchObject({ name: 'New name', description: 'Current description' })
    expect(listing.profile.services).toHaveLength(10)
    expect(listing.ads).toHaveLength(10)
    expect(listing.ads.map((a) => a.serviceId).toSorted()).toEqual(Array.from({ length: 10 }, (_, i) => `service-${i}`))
    const signed = f.signedCount()
    await f.directory.refreshProfile('lister', operation.id, { name: 'New name', description: 'Current description' })
    expect(f.signedCount()).toBe(signed)
  })

  it('does not revive expired ads returned in a stale listing, including the exact expiry boundary', async () => {
    const f = fixture()
    for (const serviceId of ['expired', 'boundary', 'live'])
      await f.directory.advertise('lister', `list-${serviceId}`, { ...ad, serviceId, name: serviceId })
    const listing = await f.service.read()
    const now = f.agents.now()
    const expiry = new Map([
      ['expired', now - 1],
      ['boundary', now],
      ['live', now + 60],
    ])
    listing.ads = listing.ads.map((service) => ({
      ...service,
      expiresAt: expiry.get(service.serviceId) ?? now,
    }))
    f.port.read = async () => listing
    const operation = f.agents.begin('lister', 'profile-expiry', 'public', 'update_profile', { name: 'Changed' })
    await f.directory.refreshProfile('lister', operation.id, { name: 'Changed', description: '' })
    const refreshed = await f.service.read()
    expect(refreshed.profile.services).toEqual(['live'])
    expect(refreshed.ads.map((service) => service.serviceId)).toEqual(['live'])
  })

  it('resumes the frozen live-ad set after a lost publication acknowledgement', async () => {
    const f = fixture()
    await f.directory.advertise('lister', 'list-1', ad)
    await f.directory.advertise('lister', 'list-2', { ...ad, serviceId: 'audit', name: 'Audit' })
    const operation = f.agents.begin('lister', 'profile-1', 'public', 'update_profile', { description: 'Updated' })
    const submit = f.port.submit.bind(f.port)
    let lost = true
    f.port.submit = async (record, signature) => {
      const result = await submit(record, signature)
      if (lost && record.kind === 'ServiceAd') {
        lost = false
        throw new DirectoryError('chain', 'acknowledgement lost')
      }
      return result
    }
    await expect(
      f.directory.refreshProfile('lister', operation.id, { name: 'Quill', description: 'Updated' }),
    ).rejects.toMatchObject({ code: 'unavailable' })
    await f.directory.refreshProfile('lister', operation.id, { name: 'Quill', description: 'Updated' })
    expect((await f.service.read()).ads.map((a) => a.serviceId).toSorted()).toEqual(['audit', 'review'])
    await f.directory.withdraw('lister', 'leave-1', {})
    await f.directory.refreshProfile('lister', operation.id, { name: 'Quill', description: 'Updated' })
    expect((await f.service.read()).enrolled).toBe(false)
  })

  it('does not enroll an unlisted agent when its profile changes', async () => {
    const f = fixture()
    const operation = f.agents.begin('lister', 'profile-1', 'public', 'update_profile', { name: 'Changed' })
    await f.directory.refreshProfile('lister', operation.id, { name: 'Changed', description: '' })
    expect(f.signedCount()).toBe(0)
    expect((await f.service.read()).enrolled).toBe(false)
  })
  it('enrolls in manual mode, then advertises until withdrawn; a retry with the same key signs nothing again', async () => {
    const f = fixture()
    const listing = await f.directory.advertise('lister', 'list-1', ad)
    expect(listing).toMatchObject({
      agentId: '2013',
      enrolled: true,
      ownership: 'verified',
      profile: { name: 'Quill', services: ['Code review'] },
      ads: [{ serviceId: 'review', publishedAt: 1_800_000_000, expiresAt: null }],
    })
    expect(f.calls).toEqual([
      'read',
      'prepare:Enrollment',
      'submit:Enrollment',
      'prepare:ServiceAd',
      'submit:ServiceAd',
    ])
    expect(f.signedCount()).toBe(2)
    expect(await f.directory.advertise('lister', 'list-1', ad)).toEqual(listing)
    expect(f.signedCount()).toBe(2)
  })

  it('does not enroll again once listed, so a second ad keeps the first', async () => {
    const f = fixture()
    await f.directory.advertise('lister', 'list-1', ad)
    const both = await f.directory.advertise('lister', 'list-2', { ...ad, serviceId: 'audit', name: 'Audit' })
    expect(both.ads.map((a) => a.serviceId).toSorted()).toEqual(['audit', 'review'])
    expect(f.calls.filter((c) => c === 'prepare:Enrollment')).toHaveLength(1)
  })

  it('does not re-enroll on unknown ownership, so a transient read does not revoke other listings', async () => {
    const f = fixture()
    await f.directory.advertise('lister', 'list-1', ad)
    const read = f.port.read.bind(f.port)
    f.port.read = async () => ({ ...(await read()), ownership: 'unknown' })
    const both = await f.directory.advertise('lister', 'list-2', { ...ad, serviceId: 'audit' })
    expect(both.ads.map((service) => service.serviceId).toSorted()).toEqual(['audit', 'review'])
    expect(f.calls.filter((call) => call === 'prepare:Enrollment')).toHaveLength(1)
  })

  it('refreshes an old durable listing while preserving every optional card field and stripping projection keys', async () => {
    const f = fixture()
    const fields = {
      category: 'code',
      tags: ['typescript'],
      examples: ['Review this PR'],
      samples: [
        { url: `${audience}/samples/${'a'.repeat(64)}.webp`, caption: 'Review', kind: 'delivery', jobId: '42' },
      ],
    }
    await f.directory.advertise('lister', 'card-1', { ...ad, ...fields })
    f.advance(25 * 3600)
    const operation = f.agents.begin('lister', 'profile-card', 'public', 'update_profile', { name: 'Changed' })
    await f.directory.refreshProfile('lister', operation.id, { name: 'Changed', description: '' })
    expect((await f.service.read()).ads).toEqual([
      { ...ad, ...fields, adHash: expect.any(String), publishedAt: f.agents.now(), expiresAt: null },
    ])
  })

  it('answers a finished ad from its journal, so a retry after the operator opted out does not enroll again (VV2-028)', async () => {
    const f = fixture()
    await f.directory.advertise('lister', 'list-1', ad)
    const second = await f.directory.advertise('lister', 'list-2', { ...ad, serviceId: 'audit', name: 'Audit' })
    await f.directory.withdraw('lister', 'leave-1', {})
    const signed = f.signedCount()
    expect(await f.directory.advertise('lister', 'list-2', { ...ad, serviceId: 'audit', name: 'Audit' })).toEqual(
      second,
    )
    expect(await f.directory.withdraw('lister', 'leave-1', {})).toMatchObject({ enrolled: false })
    expect(f.signedCount()).toBe(signed)
    expect(await f.service.read()).toMatchObject({ enrolled: false, ads: [] })
  })

  it('takes one ad down, or leaves the directory with all of them', async () => {
    const f = fixture()
    await f.directory.advertise('lister', 'list-1', ad)
    await f.directory.advertise('lister', 'list-2', { ...ad, serviceId: 'audit', name: 'Audit' })
    expect(
      (await f.directory.withdraw('lister', 'down-1', { serviceId: 'review' })).ads.map((a) => a.serviceId),
    ).toEqual(['audit'])
    expect(await f.directory.withdraw('lister', 'leave-1', {})).toMatchObject({ enrolled: false, ads: [] })
  })

  it('prepares again when a record misses the directory window, at most three times', async () => {
    const f = fixture()
    let stale = 2
    const submit = f.port.submit
    f.port.submit = async (record, signature) => {
      if (stale-- > 0)
        throw new DirectoryError('forbidden', 'record is expired or outside its server-time validity window')
      return submit(record, signature)
    }
    expect((await f.directory.advertise('lister', 'list-1', ad)).enrolled).toBe(true)
    expect(f.calls.filter((c) => c === 'prepare:Enrollment')).toHaveLength(3)
    stale = 3
    await expect(f.directory.advertise('lister', 'list-2', { ...ad, serviceId: 'audit' })).rejects.toMatchObject({
      code: 'forbidden',
      reason: 'directory-forbidden',
      retry: 'new-key',
    })
  })

  it('says no retry fixes a forbidden ad that is not a stale record (prod gap 1)', async () => {
    const f = fixture()
    f.port.submit = async () => {
      throw new DirectoryError('forbidden', 'agent wallet does not own this ERC-8004 identity')
    }
    await expect(f.directory.advertise('lister', 'list-1', ad)).rejects.toMatchObject({
      code: 'forbidden',
      reason: 'directory-forbidden',
      retry: 'none',
    })
  })

  it('refuses an ad the directory would refuse before starting an operation, and a key reused for another ad', async () => {
    const f = fixture()
    await expect(f.directory.advertise('lister', 'bad', { ...ad, serviceId: 'Not A Slug' })).rejects.toMatchObject({
      code: 'invalid',
      retry: 'new-key',
    })
    expect(f.calls).toEqual([])
    await f.directory.advertise('lister', 'list-1', ad)
    await expect(f.directory.advertise('lister', 'list-1', { ...ad, name: 'Other' })).rejects.toMatchObject({
      reason: 'operation-key-reused',
    })
  })
})
