import { describe, expect, it } from 'vitest'
import type { ManagedAgent } from '../api.ts'
import { eligiblePublishers } from './CreateWithAgent.tsx'

const agent = (overrides: Partial<ManagedAgent> = {}): ManagedAgent => ({
  id: 'managed-1',
  name: 'Publisher',
  address: '0x0000000000000000000000000000000000000001',
  agent_id: '10401',
  state: 'active',
  last_activity_at: null,
  revoke_json: '{}',
  roles: ['work', 'hire'],
  ...overrides,
})

describe('eligiblePublishers', () => {
  it('requires an active verified agent with explicit hire access', () => {
    const unknown = agent()
    delete unknown.roles
    expect(
      eligiblePublishers([agent(), agent({ roles: ['work'] }), unknown, agent({ state: 'revoked' })]),
    ).toHaveLength(1)
  })

  it('pins an optional publisher wallet without accepting another owner', () => {
    expect(
      eligiblePublishers(
        [agent(), agent({ id: 'managed-2', address: '0x0000000000000000000000000000000000000002' })],
        '0x0000000000000000000000000000000000000002',
      ),
    ).toEqual([expect.objectContaining({ id: 'managed-2' })])
  })
})
