/**
 * A new account's three steps — fund the wallet, create an agent, back it — read from what the chain and the board say
 * rather than from flags, so an account that already has a backed agent is set up however it got there. Welcome opens
 * by itself once per tab after signing in from a general page, never over a page someone came to act on, and not again
 * after "Finish later".
 */
export type OnboardingStep = 'fund' | 'agent' | 'back'

export const ONBOARDING_STEPS: readonly OnboardingStep[] = ['fund', 'agent', 'back']

/** Each fact is null while unknown. */
export interface OnboardingFacts {
  /** The wallet holds anything (gas, SIDE or a payment token) or already backs something. */
  funded: boolean | null
  /** The operator has an agent. */
  hasAgent: boolean | null
  /** The operator backs an agent (not just their own wallet). */
  backed: boolean | null
}

export type OnboardingState = 'done' | 'current' | 'todo' | 'unknown'

const FACT: Record<OnboardingStep, keyof OnboardingFacts> = { fund: 'funded', agent: 'hasAgent', back: 'backed' }

/** Each step's state: done once its fact holds; the first step not done is current, the ones after it to do. */
export function onboardingSteps(facts: OnboardingFacts): Array<{ step: OnboardingStep; state: OnboardingState }> {
  let current = false
  return ONBOARDING_STEPS.map((step) => {
    const fact = facts[FACT[step]]
    if (fact === true) return { step, state: 'done' as const }
    if (fact === null) return { step, state: 'unknown' as const }
    const state = current ? ('todo' as const) : ('current' as const)
    current = true
    return { step, state }
  })
}

/** true when every step is done, false when one is known not to be, null while that is unknown. */
export function onboardingDone(facts: OnboardingFacts): boolean | null {
  const values = Object.values(facts)
  if (values.every((v) => v === true)) return true
  return values.some((v) => v === false) ? false : null
}

export const stepsDone = (facts: OnboardingFacts) => Object.values(facts).filter((v) => v === true).length

/** The general pages Welcome may open over; anywhere else, someone came to do something there. */
const WELCOME_FROM: ReadonlySet<string> = new Set(['/', '/jobs', '/services', '/account'])

export function shouldWelcome(input: {
  facts: OnboardingFacts
  pathname: string
  /** "Finish later" was pressed for this wallet. */
  dismissed: boolean
  /** Welcome already opened in this tab for this wallet. */
  shown: boolean
  /** The SIDE sheet is on screen (someone signing in to buy SIDE): Welcome waits rather than taking the page. */
  sideOpen?: boolean
}): boolean {
  return (
    onboardingDone(input.facts) === false &&
    WELCOME_FROM.has(input.pathname) &&
    !input.dismissed &&
    !input.shown &&
    input.sideOpen !== true
  )
}

const laterKey = (address: string) => `sq:welcome-later:${address.toLowerCase()}`
const shownKey = (address: string) => `sq:welcome-shown:${address.toLowerCase()}`

function read(storage: () => Storage, key: string): boolean {
  try {
    return storage().getItem(key) !== null
  } catch {
    return false
  }
}

function write(storage: () => Storage, key: string) {
  try {
    storage().setItem(key, '1')
  } catch {
    // Private windows refuse storage; Welcome may then open again.
  }
}

export const welcomeDismissed = (address: string) => read(() => window.localStorage, laterKey(address))
export const dismissWelcome = (address: string) => write(() => window.localStorage, laterKey(address))
export const welcomeShown = (address: string) => read(() => window.sessionStorage, shownKey(address))
export const markWelcomeShown = (address: string) => write(() => window.sessionStorage, shownKey(address))
