/**
 * A quote request's terms, calmer than a list of equal rows (UX-08): its dates as one timeline, what each side puts at
 * risk side by side, and how it is paid, delivered and who asked. Budget and "posted by" sit in the hero above; the
 * tags under the title.
 */
import type { ReactNode } from 'react'
import { parseEther } from 'viem'
import { cn } from '../../lib/cn.ts'
import { localTime, relative } from '../../format.ts'
import { deployment } from '../../wallet.ts'
import { AgentLabel } from '../agent/AgentChip.tsx'
import { AgentOrb } from '../agent/AgentOrb.tsx'
import { WalletLink } from '../WalletLink.tsx'
import { BondHorizonNotice } from '../BondHorizonNotice.tsx'
import { useNow } from '../Time.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'
import { Badge } from '../ui/badge.tsx'

export interface TermsStep {
  label: string
  at: number
}

/** Which step is next: the first still ahead of `now`, or none once all have passed. */
export const nextStep = (steps: readonly TermsStep[], now: number): number => steps.findIndex((s) => s.at > now)

export function RequestTerms({
  steps,
  creatorBond,
  workerBond,
  paidIn,
  deliverAs,
  checks,
  requester,
  requesterAgent,
  you,
}: {
  steps: readonly TermsStep[]
  /** Deposits in whole SIDE, as the request states them. */
  creatorBond: string
  workerBond: string
  paidIn: ReactNode
  deliverAs: readonly string[]
  checks: readonly string[]
  requester: string
  requesterAgent: string | null
  you: boolean
}) {
  return (
    // A container: in the request page's side column the dates stack, as they do on a phone.
    <div className="@container grid rounded-2xl bg-card shadow-stock [&>*+*]:border-t [&>*+*]:border-border/70">
      <DeadlineSteps steps={steps} />
      <div className="grid gap-3 p-4">
        <span className="text-ui text-muted-foreground">What's at stake</span>
        <StakePair creator={parseEther(creatorBond)} worker={parseEther(workerBond)} />
        <span className="text-ui leading-snug text-muted-foreground">
          <BondHorizonNotice bonded={Number(creatorBond) > 0 || Number(workerBond) > 0} tone="rule" />
        </span>
      </div>
      <dl className="grid gap-3 p-4 text-sm">
        <Fact label="Paid in">{paidIn}</Fact>
        <Fact label="Deliver as">
          <span className="flex flex-wrap justify-end gap-1.5">
            {deliverAs.map((kind) => (
              <Badge key={kind} variant="neutral">
                {kind}
              </Badge>
            ))}
            {checks.map((check) => (
              <Badge key={check} variant="info" className="font-mono">
                {check}
              </Badge>
            ))}
          </span>
        </Fact>
        <Fact label="Requester">
          <span className="inline-flex min-w-0 items-center justify-end gap-2">
            {requesterAgent !== null ? (
              <>
                <AgentOrb agentId={requesterAgent} size="sm" />
                <span className="font-medium">
                  <AgentLabel id={requesterAgent} />
                </span>
              </>
            ) : (
              <WalletLink address={requester} />
            )}
            {you && <Badge variant="info">You</Badge>}
          </span>
        </Fact>
      </dl>
    </div>
  )
}

/** The request's dates as one line of steps: passed ones muted, the next one marked, each with its date and distance. */
function DeadlineSteps({ steps }: { steps: readonly TermsStep[] }) {
  const now = useNow()
  const next = nextStep(steps, now)
  return (
    <ol className="grid gap-3 p-4 @lg:grid-cols-3">
      {steps.map((step, i) => {
        const passed = step.at <= now
        return (
          <li
            key={step.label}
            className={cn('grid grid-cols-[auto_1fr] content-start gap-x-2.5 gap-y-0.5', passed && 'opacity-60')}
          >
            <span
              aria-hidden
              className={cn(
                'mt-1.5 size-2.5 rounded-full',
                i === next ? 'bg-primary ring-4 ring-primary/20' : passed ? 'bg-muted-foreground' : 'bg-border',
              )}
            />
            <span className={cn('text-sm', i === next ? 'font-medium' : 'text-muted-foreground')}>
              {step.label}
              {i === next && <span className="sr-only"> (next)</span>}
            </span>
            <span />
            <span className="text-ui tabular-nums text-muted-foreground">
              {localTime(step.at)} · {relative(step.at, now)}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** What each side puts at risk, in SIDE base units, side by side; shared by a request's terms and its job's details. */
export function StakePair({ creator, worker }: { creator: bigint | null; worker: bigint | null }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Stake who="The requester" value={creator} />
      <Stake who="The agent" value={worker} />
    </div>
  )
}

function Stake({ who, value }: { who: string; value: bigint | null }) {
  return (
    <div className="grid gap-0.5 rounded-xl bg-muted/40 px-3 py-2.5">
      <span className="text-base font-semibold tabular-nums">
        {value === null ? '—' : <TokenAmount value={value} token={deployment.factory} />}
      </span>
      <span className="text-ui text-muted-foreground">{who}</span>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right [overflow-wrap:anywhere]">{children}</dd>
    </div>
  )
}
