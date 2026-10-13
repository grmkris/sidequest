import { readFileSync } from 'node:fs'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { authorityPolicy } from './policy.ts'
import { sidequestPolicyPlan } from './cutover-policy.ts'
import {
  assertFreshPolicy,
  assertQuorum,
  createSeparateAuthority,
  devAuthorityEnv,
  publicKey,
  type CutoverState,
} from './sidequest-cutover.ts'
import { canonical } from './policy-document.ts'
const hash = (v: string) => createHash('sha256').update(v).digest('hex')
const archived = JSON.parse(
  readFileSync(
    new URL('../../../../contracts/config/archive/pre-sidequest-monad-testnet.json', import.meta.url),
    'utf8',
  ),
)
function key() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  }
}
const quorum = (id: string, public_key: string) => ({
  id,
  authorization_threshold: 1,
  authorization_keys: [{ public_key }],
  user_ids: [],
  key_quorum_ids: [],
})
function fixture() {
  const desired = authorityPolicy('admin', 'monad-testnet')
  const legacy = {
    ...structuredClone(desired),
    id: 'legacy-policy',
    created_at: 1,
    rules: desired.rules.map((rule, i) => ({ ...structuredClone(rule), id: `rule-${i}` })),
  }
  legacy.name = 'Hireling v2 Monad testnet routine signer'
  legacy.rules[0]!.conditions[1]!.value = archived.deployment.main.holding
  legacy.rules[1]!.conditions[1]!.value = archived.deployment.core
  legacy.rules[2]!.conditions[1]!.value = archived.deployment.core
  legacy.rules[3]!.conditions[2]!.value = archived.roles.relay
  const plan = sidequestPolicyPlan(legacy, desired, {
    holding: archived.deployment.main.holding,
    core: archived.deployment.core,
    relay: archived.roles.relay,
  })
  const fresh = key(),
    old = key()
  const state: CutoverState = {
    version: 2,
    appId: 'app',
    adminId: 'admin',
    adminPublicKey: 'admin-public-key',
    legacyPolicyId: 'legacy-policy',
    legacyPolicySha256: plan.legacyPolicySha256,
    legacySignerId: 'legacy-routine',
    legacySignerPublicKey: old.publicKey,
    originalAppSecretSha256: hash('old-app-secret'),
    desiredPolicySha256: hash(canonical(plan.create)),
    routinePrivateKey: fresh.privateKey,
    routinePublicKey: fresh.publicKey,
  }
  const calls: { method: string; route: string; body?: Record<string, unknown>; idempotencyKey?: string }[] = []
  const snapshots: CutoverState[] = []
  const api = {
    checked: async (
      method: string,
      route: string,
      body?: Record<string, unknown>,
      _sign?: undefined,
      idempotencyKey?: string,
    ): Promise<Record<string, unknown>> => {
      calls.push({ method, route, ...(body ? { body } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) })
      if (method === 'POST') {
        expect(snapshots.at(-1)?.[route === '/key_quorums' ? 'routine' : 'policy']?.startedAt).toBe('now')
        return { id: route === '/key_quorums' ? 'fresh-routine' : 'fresh-policy' }
      }
      if (route === '/key_quorums/fresh-routine') return quorum('fresh-routine', fresh.publicKey)
      if (route === '/key_quorums/legacy-routine') return quorum('legacy-routine', old.publicKey)
      if (route === '/policies/fresh-policy')
        return { ...structuredClone(plan.create), id: 'fresh-policy', created_at: 2 }
      if (route === '/policies/legacy-policy') return structuredClone(legacy)
      throw new Error('unexpected test route')
    },
  }
  const input = {
    api,
    state,
    plan,
    appId: 'app',
    adminId: 'admin',
    adminPublicKey: 'admin-public-key',
    appSecret: 'replacement-app-secret',
    persist: (value: CutoverState) => {
      snapshots.push(structuredClone(value))
    },
    now: () => 'now',
    operationId: () => 'operation',
  }
  return { state, plan, legacy, fresh, old, quorum, calls, snapshots, api, input }
}
describe('isolated Sidequest dev authority cutover', () => {
  it('persists intents before POST, verifies readback and never mutates legacy authority', async () => {
    const f = fixture(),
      original = structuredClone(f.legacy)
    expect(await createSeparateAuthority(f.input)).toEqual({
      signerId: 'fresh-routine',
      policyId: 'fresh-policy',
      verifiedAt: 'now',
    })
    expect(f.calls.filter((c) => c.method === 'POST')).toEqual([
      {
        method: 'POST',
        route: '/key_quorums',
        body: {
          display_name: 'Sidequest dev routine Monad testnet',
          public_keys: [f.fresh.publicKey],
          authorization_threshold: 1,
        },
      },
      { method: 'POST', route: '/policies', body: f.plan.create, idempotencyKey: 'operation' },
    ])
    expect(f.calls.every((c) => ['GET', 'POST'].includes(c.method))).toBe(true)
    expect(f.calls.some((c) => c.route.includes('wallets'))).toBe(false)
    expect(f.legacy).toEqual(original)
    expect(devAuthorityEnv(f.state)).toContain("PRIVY_POLICY_ID='fresh-policy'")
    expect(devAuthorityEnv(f.state)).not.toContain('APP_SECRET')
  })
  it('refuses the original credential before creation', async () => {
    const f = fixture()
    await expect(createSeparateAuthority({ ...f.input, appSecret: 'old-app-secret' })).rejects.toThrow(
      'Replacement app secret required',
    )
    expect(f.calls).toEqual([])
  })
  it('holds a lost quorum creation response without posting again', async () => {
    const f = fixture()
    f.api.checked = async (method, route) => {
      f.calls.push({ method, route })
      throw new Error('network unavailable')
    }
    await expect(createSeparateAuthority(f.input)).rejects.toThrow('network unavailable')
    expect(f.snapshots).toHaveLength(1)
    await expect(createSeparateAuthority(f.input)).rejects.toThrow('Unresolved routine creation')
    expect(f.calls).toHaveLength(1)
  })
  it('holds a lost policy creation response with its original operation key', async () => {
    const f = fixture(),
      original = f.api.checked
    f.api.checked = async (...args) => {
      if (args[0] === 'POST' && args[1] === '/policies') {
        f.calls.push({ method: args[0], route: args[1] })
        throw new Error('lost policy response')
      }
      return original(...args)
    }
    await expect(createSeparateAuthority(f.input)).rejects.toThrow('lost policy response')
    await expect(createSeparateAuthority(f.input)).rejects.toThrow('Unresolved policy creation')
    expect(f.calls.filter((c) => c.method === 'POST' && c.route === '/policies')).toHaveLength(1)
    expect(f.state.policy?.key).toBe('operation')
    expect(() => devAuthorityEnv(f.state)).toThrow('Only verified')
  })
  it('resumes saved IDs through GETs only and refuses rule drift', async () => {
    const f = fixture()
    await createSeparateAuthority(f.input)
    f.calls.length = 0
    await createSeparateAuthority(f.input)
    expect(f.calls.every((c) => c.method === 'GET')).toBe(true)
    const drift = { ...structuredClone(f.plan.create), id: 'fresh-policy' }
    drift.rules[5]!.conditions[3]!.value = '999999999'
    expect(() => assertFreshPolicy(drift, 'fresh-policy', f.plan)).toThrow('exact reviewed policy')
    expect(() => assertFreshPolicy(f.legacy, 'legacy-policy', f.plan)).toThrow()
  })
  it('holds changed legacy policy before exporting the dev overlay', async () => {
    const f = fixture(),
      original = f.api.checked
    f.api.checked = async (...args) => {
      const result = await original(...args)
      if (args[1] === '/policies/legacy-policy') result.owner_id = 'changed'
      return result
    }
    await expect(createSeparateAuthority(f.input)).rejects.toThrow('Legacy policy changed')
    expect(f.state.verifiedAt).toBeUndefined()
    expect(() => devAuthorityEnv(f.state)).toThrow()
  })
  it.each([
    'appId',
    'adminId',
    'adminPublicKey',
    'originalAppSecretSha256',
    'legacyPolicySha256',
    'desiredPolicySha256',
    'routinePublicKey',
  ] as const)('refuses frozen %s drift', async (field) => {
    const f = fixture()
    f.state[field] = 'changed'
    await expect(createSeparateAuthority(f.input)).rejects.toThrow('inputs changed')
    expect(f.calls).toEqual([])
  })
  it('checks quorum ID, threshold, exact key and additional owners', () => {
    const f = fixture(),
      valid = f.quorum('fresh-routine', f.fresh.publicKey)
    expect(() => assertQuorum(valid, 'fresh-routine', f.fresh.publicKey)).not.toThrow()
    for (const changed of [
      { ...valid, id: 'other' },
      { ...valid, authorization_threshold: 0 },
      { ...valid, authorization_keys: [{ public_key: f.old.publicKey }] },
      { ...valid, user_ids: ['human'] },
      { ...valid, key_quorum_ids: ['quorum'] },
      { ...valid, authorization_keys: [...valid.authorization_keys, ...valid.authorization_keys] },
    ])
      expect(() => assertQuorum(changed, 'fresh-routine', f.fresh.publicKey)).toThrow()
    expect(publicKey(f.fresh.privateKey)).toBe(f.fresh.publicKey)
  })
})
