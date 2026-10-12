import { describe, expect, it } from 'vitest'
import { approveBranch } from './approve-branch.ts'

describe('approveBranch', () => {
  it('keeps the register-and-connect flow after a refetch flips the agent to active', () => {
    expect(approveBranch('pending', 'active')).toBe('register')
  })

  it('shows the manual Connect button for an agent that was already active', () => {
    expect(approveBranch('active', 'active')).toBe('connect')
  })

  it('decides from the current state until a first state is recorded', () => {
    expect(approveBranch(null, 'pending')).toBe('register')
    expect(approveBranch(null, 'active')).toBe('connect')
  })
})
