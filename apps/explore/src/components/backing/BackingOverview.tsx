/**
 * The top of Account › Backing: the wallet's SIDE in one line (what is leaving or ready to withdraw only when there is
 * some), what backing does in one sentence, and the one thing a person comes here to do: back an agent. Backing their
 * own wallet happens by itself when they post a job; the risks are shown where a backing is confirmed.
 */
import NumberFlow from '@number-flow/react'
import { Bot } from 'lucide-react'
import type { ReactNode } from 'react'
import { formatEther } from 'viem'
import { type SummaryEntry, backingSummary } from '../../backing-summary.ts'
import { Stat, textLinkClass } from '../kit.tsx'
import { Countdown, useNow } from '../Time.tsx'
import { Button } from '../ui/button.tsx'

const side = (value: bigint) => Number(formatEther(value))

/** A SIDE figure that rolls to its new value. */
function Figure({ value, label, hint }: { value: bigint; label: string; hint?: ReactNode }) {
  return (
    <Stat
      label={label}
      value={
        <>
          <NumberFlow value={side(value)} format={{ maximumFractionDigits: 2 }} />
          <span className="ml-1 text-xs font-normal text-muted-foreground">SIDE</span>
        </>
      }
      sub={hint}
    />
  )
}

export function BackingOverview({
  positions,
  wallet,
  owner,
  disabled,
  onBackAgent,
}: {
  positions: readonly SummaryEntry[]
  /** SIDE in the signed-in wallet. */
  wallet: bigint
  owner: string
  disabled: boolean
  onBackAgent: () => void
}) {
  const summary = backingSummary(positions, wallet, owner, useNow())
  const leaving = summary.leaving + summary.held
  return (
    <section aria-label="Your SIDE" className="grid gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          <Figure value={summary.wallet} label="In your wallet" />
          <Figure value={summary.active} label="Backing" />
          {leaving > 0n && (
            <Figure
              value={leaving}
              label="Leaving"
              hint={
                summary.nextUnlock === null ? undefined : (
                  <>
                    next in <Countdown to={summary.nextUnlock} />
                  </>
                )
              }
            />
          )}
          {summary.ready > 0n && <Figure value={summary.ready} label="Ready to withdraw" hint="Withdraw below" />}
        </dl>
        <Button disabled={disabled} onClick={onBackAgent} className="max-sm:w-full">
          <Bot data-icon="inline-start" />
          Back an agent
        </Button>
      </div>
      <p className="text-xs text-pretty text-muted-foreground">
        SIDE behind an agent covers its deposits and lowers its fee; bad work is slashed from it.{' '}
        <a href="/docs/concepts/bonds-and-staking" className={textLinkClass}>
          How backing works
        </a>
      </p>
    </section>
  )
}
