import { cn } from '../lib/cn.ts'
import { isMainnet, otherNetwork } from '../wallet.ts'
import { Badge } from './ui/badge.tsx'

/*
 * How testnet marks itself (mainnet carries no marker), and the switch between them. Each network has its own origin,
 * its own jobs, agents and SIDE, so the switch opens the other origin's front page rather than the same path.
 */

/** Mainnet | Testnet: this network, and a link to the other's Explore. Hidden while the config names no other. */
export function NetworkSwitch({ className }: { className?: string }) {
  if (otherNetwork === null) return null
  const here = (
    <span aria-current="page" className="rounded-full bg-background px-2.5 py-1 text-foreground shadow-xs">
      {isMainnet ? 'Mainnet' : 'Testnet'}
    </span>
  )
  const there = (
    <a
      href={otherNetwork.href}
      className="rounded-full px-2.5 py-1 text-muted-foreground transition-colors [@media(hover:hover)]:hover:text-foreground"
    >
      {otherNetwork.label}
    </a>
  )
  return (
    <nav
      aria-label="Network"
      className={cn('inline-flex w-fit rounded-full bg-muted p-0.5 text-xs font-medium', className)}
    >
      {isMainnet ? here : there}
      {isMainnet ? there : here}
    </nav>
  )
}

/** "TESTNET" beside the brand. */
export function TestnetTag({ className }: { className?: string }) {
  if (isMainnet) return null
  return (
    <Badge variant="warning" className={cn('text-micro font-semibold uppercase tracking-wide', className)}>
      Testnet
    </Badge>
  )
}

/**
 * A 2px amber edge across the top of the window, just under the status bar in an installed app. At 2px it stays under
 * Safari 26's 3px threshold for sampling the status bar's tint, so the clock area keeps the page colour.
 */
export function TestnetEdge() {
  if (isMainnet) return null
  return <div aria-hidden className="pointer-events-none fixed inset-x-0 top-(--safe-top) z-40 h-0.5 bg-warning" />
}
