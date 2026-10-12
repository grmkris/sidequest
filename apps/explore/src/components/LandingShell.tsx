import { SkipLink } from './RouteAccessibility.tsx'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn.ts'
import { deployed, deployment, explorer, getSideLink, xLink } from '../wallet.ts'
import { CopyButton, shortAddress } from './kit.tsx'
import { LaunchBanner } from './LaunchGate.tsx'
import { NetworkSwitch, TestnetEdge, TestnetTag } from './NetworkCue.tsx'
import { Mark } from './Shell.tsx'
import { buttonVariants } from './ui/button.tsx'

/** The SIDE contract address, linked to the explorer and copyable: what a visitor checks before buying. */
function SideAddress({ address, className }: { address: string; className?: string }) {
  return (
    <span
      className={cn(
        'items-center gap-1.5 rounded-full border py-0.5 pr-0.5 pl-3 font-mono text-xs text-muted-foreground',
        className,
      )}
    >
      <span className="font-sans font-semibold text-foreground">SIDE</span>
      <a
        href={explorer('address', address)}
        target="_blank"
        rel="noreferrer"
        title={address}
        className="transition-colors hover:text-foreground"
      >
        {shortAddress(address)}
      </a>
      <CopyButton value={address} label="Copy SIDE contract address" className="size-7" />
    </span>
  )
}

/**
 * The public front door: a translucent bar with the brand, the SIDE contract address, Buy (or "Get SIDE" on its
 * launcher) and "Open app"; the page; and a footer of links (the documentation, the protocol and its risks, the source,
 * X), SIDE's address again on a phone, and the network switch.
 */
export function LandingShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <SkipLink />
      <TestnetEdge />
      <header className="material-chrome material-edge-bottom sticky top-0 z-30 pt-[var(--safe-top)]">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 pr-[max(1.25rem,var(--safe-right))] pl-[max(1.25rem,var(--safe-left))]">
          <span className="flex min-w-0 items-center gap-2">
            <Link to="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
              <Mark />
              Sidequest
            </Link>
            <TestnetTag />
          </span>
          <span className="flex items-center gap-2">
            {deployed && <SideAddress address={deployment.factory} className="hidden md:inline-flex" />}
            {getSideLink !== null ? (
              <a
                href={getSideLink}
                target="_blank"
                rel="noreferrer"
                className={cn(buttonVariants({ variant: 'outline' }), 'hidden sm:inline-flex')}
              >
                Get SIDE
              </a>
            ) : (
              <Link to="/account" className={cn(buttonVariants({ variant: 'outline' }), 'hidden sm:inline-flex')}>
                Buy SIDE
              </Link>
            )}
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
          {deployed && <SideAddress address={deployment.factory} className="inline-flex md:hidden" />}
          <NetworkSwitch />
        </footer>
      </main>
    </div>
  )
}
