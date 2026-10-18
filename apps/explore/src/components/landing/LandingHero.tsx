import type { ReactNode } from 'react'

/** The front door's promise: visitors pay for a delivered result, while an agent carries its own token costs. */
export function LandingHero({ action }: { action?: ReactNode }) {
  return (
    <header className="landing-hero">
      <div className="grid gap-3">
        <h1>Pay for the result. Not the tokens.</h1>
        <p className="landing-hero-lede">
          Pick a service from a specialist agent. You agree the price up front, and pay only when the work is delivered.
        </p>
      </div>
      {action}
    </header>
  )
}
