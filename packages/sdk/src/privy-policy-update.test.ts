import { expect, test, vi } from 'vitest'
import { authorityPolicy } from '../scripts/privy/policy.ts'
import { updateRoutinePolicy, type CutoverState } from '../scripts/privy/sidequest-cutover.ts'
import { canonical } from '../scripts/privy/policy-document.ts'
import { createHash } from 'node:crypto'

const hash = (value: Record<string, unknown>) => createHash('sha256').update(canonical(value)).digest('hex')
test('policy update journals its target, verifies readback and reconciles a lost PATCH response', async () => {
  const desired = authorityPolicy('admin', 'monad-testnet')
  const old = structuredClone(desired)
  const condition = old.rules
    .find((rule) => rule.name === 'Allow Delegation')!
    .conditions.find((item) => item.field === 'delegate')!
  condition.operator = 'eq'
  condition.value = (condition.value as string[])[0]!
  let live: Record<string, unknown> = { ...old, id: 'policy' }
  const state: CutoverState = {
    version: 2,
    appId: 'app',
    adminId: 'admin',
    adminPublicKey: 'admin-public',
    legacyPolicyId: 'old-policy',
    legacyPolicySha256: '0'.repeat(64),
    legacySignerId: 'old-signer',
    legacySignerPublicKey: 'old-public',
    originalAppSecretSha256: '0'.repeat(64),
    desiredPolicySha256: hash(old),
    routinePrivateKey: 'routine-private',
    routinePublicKey: 'routine-public',
    routine: { id: 'routine', key: 'create-routine', startedAt: '2026-10-07' },
    policy: { id: 'policy', key: 'create-policy', startedAt: '2026-10-07' },
    verifiedAt: '2026-10-07',
  }
  const persisted: CutoverState[] = []
  const api = {
    checked: vi.fn(async (method: string, route: string, body?: Record<string, unknown>) => {
      if (route === '/key_quorums/admin')
        return {
          id: 'admin',
          authorization_threshold: 1,
          authorization_keys: [{ public_key: 'admin-public' }],
          user_ids: [],
          key_quorum_ids: [],
        }
      if (route === '/key_quorums/routine')
        return {
          id: 'routine',
          authorization_threshold: 1,
          authorization_keys: [{ public_key: 'routine-public' }],
          user_ids: [],
          key_quorum_ids: [],
        }
      if (method === 'PATCH') {
        expect(persisted.at(-1)?.policyUpdate?.targetSha256).toBe(hash(desired))
        live = { ...live, rules: body!.rules }
        throw new Error('lost response')
      }
      return live
    }),
  }
  const input = {
    api,
    network: 'monad-testnet' as const,
    state,
    adminId: 'admin',
    adminPublicKey: 'admin-public',
    sign: async () => 'signature',
    persist: (next: CutoverState) => persisted.push(structuredClone(next)),
  }
  await expect(updateRoutinePolicy(input)).rejects.toThrow('lost response')
  expect(state.desiredPolicySha256).toBe(hash(old))
  await expect(updateRoutinePolicy(input)).resolves.toEqual({
    name: desired.name,
    appId: 'app',
    adminId: 'admin',
    signerId: 'routine',
    policyId: 'policy',
  })
  expect(state.desiredPolicySha256).toBe(hash(desired))
  expect(state.policyUpdate).toBeUndefined()
  expect(api.checked.mock.calls.filter(([method]) => method === 'PATCH')).toHaveLength(1)
})
