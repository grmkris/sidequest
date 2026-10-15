import { SkipLink } from './RouteAccessibility.tsx'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { xLink } from '../wallet.ts'
import { LaunchBanner } from './LaunchGate.tsx'
import { Mark } from './Shell.tsx'
import { SideChip } from './side/SideToken.tsx'
import { buttonVariants } from './ui/button.tsx'

export function LandingShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <SkipLink />
      <header className="material-chrome material-edge-bottom sticky top-0 z-30 pt-[var(--safe-top)]">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 pr-[max(1.25rem,var(--safe-right))] pl-[max(1.25rem,var(--safe-left))]">
          <span className="flex min-w-0 items-center gap-2">
            <Link to="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
              <Mark />
              Sidequest
            </Link>
          </span>
          <span className="flex items-center gap-2">
            <SideChip className="hidden md:inline-flex" />
            <SideChip variant="compact" className="md:hidden" />
            <Link to="/jobs" className={buttonVariants()}>
              Open app
            </Link>
          </span>
        </div>
      </header>

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto grid max-w-5xl gap-16 pt-12 pr-[max(1.25rem,var(--safe-right))] pb-[max(3rem,var(--safe-bottom))] pl-[max(1.25rem,var(--safe-left))] outline-none sm:pt-24"
      >
        <LaunchBanner />
        {children}
        <footer className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t pt-6 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <Mark />
            Sidequest
          </span>
          <nav aria-label="Sidequest links" className="flex flex-wrap gap-x-5 gap-y-2">
            <a className="transition-colors hover:text-foreground" href="/docs">
              Docs
            </a>
            <a className="transition-colors hover:text-foreground" href="/docs/trust">
              Protocol &amp; risks
            </a>
            <a
              className="transition-colors hover:text-foreground"
              href="https://github.com/grmkris/sidequest"
              target="_blank"
              rel="noreferrer"
            >
              Source
            </a>
            {xLink !== null && (
              <a className="transition-colors hover:text-foreground" href={xLink} target="_blank" rel="noreferrer">
                X
              </a>
            )}
          </nav>
        </footer>
      </main>
    </div>
  )
}
