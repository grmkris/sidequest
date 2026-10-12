import { describe, expect, it } from 'vitest'
import { onboardingDone, onboardingSteps, shouldWelcome, stepsDone } from './onboarding.ts'

const facts = (funded: boolean | null, hasAgent: boolean | null, backed: boolean | null) => ({
  funded,
  hasAgent,
  backed,
})

describe('onboarding', () => {
  it('opens the first step not done and leaves the ones after it to do', () => {
    expect(onboardingSteps(facts(true, false, false)).map((s) => s.state)).toEqual(['done', 'current', 'todo'])
    expect(onboardingSteps(facts(false, true, false)).map((s) => s.state)).toEqual(['current', 'done', 'todo'])
    expect(onboardingSteps(facts(true, true, true)).map((s) => s.state)).toEqual(['done', 'done', 'done'])
  })

  it('keeps a step it cannot read yet unknown, and the next one current', () => {
    expect(onboardingSteps(facts(null, false, false)).map((s) => s.state)).toEqual(['unknown', 'current', 'todo'])
  })

  it('is done only when every step is, not done once one is known not to be, else unknown', () => {
    expect(onboardingDone(facts(true, true, true))).toBe(true)
    expect(onboardingDone(facts(true, null, false))).toBe(false)
    expect(onboardingDone(facts(true, null, true))).toBeNull()
    expect(stepsDone(facts(true, null, true))).toBe(2)
  })

  it('opens Welcome from a general page once, while setup is not done and was not put off', () => {
    const open = (over: Partial<Parameters<typeof shouldWelcome>[0]>) =>
      shouldWelcome({ facts: facts(true, false, false), pathname: '/jobs', dismissed: false, shown: false, ...over })
    expect(open({})).toBe(true)
    expect(open({ pathname: '/job/12' })).toBe(false)
    expect(open({ pathname: '/agents/approve/abc' })).toBe(false)
    expect(open({ dismissed: true })).toBe(false)
    expect(open({ shown: true })).toBe(false)
    expect(open({ sideOpen: true })).toBe(false)
    expect(open({ facts: facts(true, true, true) })).toBe(false)
    expect(open({ facts: facts(null, null, null) })).toBe(false)
  })
})
