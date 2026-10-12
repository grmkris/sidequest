/**
 * Welcome's two ways in: it opens by itself once per tab, after signing in from a general page, while setup is not
 * done and was not put off; and a "Finish setup" pill shows how far setup is, wherever the account is shown.
 */
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import type { Address } from 'viem'
import { cn } from '../../lib/cn.ts'
import {
  ONBOARDING_STEPS,
  markWelcomeShown,
  onboardingDone,
  shouldWelcome,
  stepsDone,
  welcomeDismissed,
  welcomeShown,
} from '../../onboarding.ts'
import { useSideSheet } from '../side/SideToken.tsx'
import { useOnboardingFacts } from './useOnboardingFacts.ts'

/** Opens Welcome when it should; renders nothing. Mount it only for a signed-in operator. */
export function WelcomeOpener({ address }: { address: Address }) {
  const facts = useOnboardingFacts(address)
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const side = useSideSheet()
  const open = shouldWelcome({
    facts,
    pathname,
    dismissed: welcomeDismissed(address),
    shown: welcomeShown(address),
    sideOpen: side?.showing === true,
  })
  useEffect(() => {
    if (!open) return
    markWelcomeShown(address)
    void navigate({ to: '/welcome' })
  }, [open, address, navigate])
  return null
}

/** "Finish setup · 1 of 3", linking Welcome, while setup is not done. */
export function SetupPill({ address, className }: { address: Address; className?: string }) {
  const facts = useOnboardingFacts(address)
  if (onboardingDone(facts) !== false) return null
  return (
    <Link
      to="/welcome"
      className={cn(
        'inline-flex min-h-9 items-center gap-2 rounded-full bg-primary/12 px-3 text-sm font-medium text-primary transition-colors duration-(--dur-fast) [@media(hover:hover)]:hover:bg-primary/20',
        className,
      )}
    >
      Finish setup
      <span className="text-xs tabular-nums opacity-80">
        {stepsDone(facts)} of {ONBOARDING_STEPS.length}
      </span>
    </Link>
  )
}
