import { describe, expect, it } from 'vitest'
import { parseEther } from 'viem'
import type { ManagedAgent } from '../../api.ts'
import { backedFact, hires } from './useOnboardingFacts.ts'

type ReadyAgent = ManagedAgent & { address: string; agent_id: string }

const agent = (roles?: ManagedAgent['roles']): ReadyAgent => ({
  id: 'a1',
  name: 'Goblin Demo',
  address: '0x0000000000000000000000000000000000000001',
  agent_id: '2197',
  state: 'active',
  last_activity_at: null,
  revoke_json: '{}',
  ...(roles === undefined ? {} : { roles }),
})

const minimum = parseEther('10')

describe('hires', () => {
  it('keeps the default roles, work and hire, when none are recorded', () => {
    expect(hires(agent())).toBe(true)
    expect(hires(agent(['work', 'hire']))).toBe(true)
    expect(hires(agent(['work']))).toBe(false)
  })
})

describe('backedFact', () => {
  it('needs the creator-bond floor behind an agent that hires', () => {
    expect(backedFact({ agent: agent(['hire']), backsAny: true, active: parseEther('4'), minimum })).toBe(false)
    expect(backedFact({ agent: agent(['hire']), backsAny: true, active: minimum, minimum })).toBe(true)
  })

  it('is unknown for a hiring agent until both its backing and the floor are read', () => {
    expect(backedFact({ agent: agent(), backsAny: true, active: undefined, minimum })).toBeNull()
    expect(backedFact({ agent: agent(), backsAny: true, active: minimum, minimum: undefined })).toBeNull()
  })

  it('takes any position for an agent that only works, or before there is an agent', () => {
    expect(backedFact({ agent: agent(['work']), backsAny: true, active: 0n, minimum })).toBe(true)
    expect(backedFact({ agent: undefined, backsAny: false, active: undefined, minimum })).toBe(false)
  })
})
