/**
 * The SIDE behind an agent, for anyone, in one row: total backing, how many back it and the worker fee it pays, with
 * how far it is from the next (lower) fee tier. Details unfold in place — the
 * split between active, reserved, available and leaving, the top backers, the viewer's own position and the risks.
 * Backing it is the page header's action.
 */
import type { ReactNode } from 'react'
import type { Address } from 'viem'
import { tierProgress } from '../../agent-stats.ts'
import { useIndexedBacking } from '../../delegation-query.ts'
import { sidequest } from '../../sidequest.ts'
import { percent } from '../../stake.ts'
import { deployed } from '../../wallet.ts'
import { DELEGATION_RISK } from '../DelegationPositions.tsx'
import { Address as AddressText, LoadingRows, Section } from '../kit.tsx'
import { Countdown, useNow } from '../Time.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'
import { Disclosure } from '../ui/disclosure.tsx'
import { Meter } from '../ui/meter.tsx'

function Figure({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="grid min-w-0 content-start gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-base leading-tight font-semibold tracking-tight">{value}</dd>
    </div>
  )
}

function Line({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-4 border-t border-border/70 py-1.5 text-sm first:border-t-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-right">{children}</span>
    </div>
  )
}

export function BackingStrip({ wallet, viewer }: { wallet: Address; viewer: Address | undefined }) {
  const read = useIndexedBacking(wallet, viewer)
  const now = useNow()
  if (!deployed) return null
  const factory = sidequest.factory
  const snapshot = read.data
  return (
    <Section title="Backing">
      {read.isPending ? (
        <LoadingRows rows={2} />
      ) : read.isError || snapshot === undefined ? (
        <p className="px-1 text-ui text-muted-foreground">
          This agent&apos;s backing can&apos;t be read right now; it retries.
        </p>
      ) : (
        <div className="grid gap-3 rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10">
          <dl className="flex flex-wrap gap-x-8 gap-y-3">
            <Figure value={<TokenAmount value={snapshot.backing.assets} token={factory} />} label="Total backing" />
            <Figure value={snapshot.delegatorCount} label={snapshot.delegatorCount === 1 ? 'Backer' : 'Backers'} />
            <Figure value={percent(snapshot.backing.tier.feeBps)} label="Worker fee" />
          </dl>
          {snapshot.backing.tier.nextThreshold === null ? (
            <p className="text-xs text-muted-foreground">It pays the lowest fee.</p>
          ) : (
            <Meter
              value={tierProgress(snapshot.backing.active, snapshot.backing.tier) * 100}
              aria-label="Progress to the next fee tier"
              className="gap-1.5"
            >
              <span className="text-xs text-muted-foreground">
                <TokenAmount value={snapshot.backing.tier.needed} token={factory} /> more active backing drops its fee
                to {percent(snapshot.backing.tier.nextFeeBps!)}
              </span>
            </Meter>
          )}
          <Disclosure summary="Details" className="-mx-1">
            <div className="grid gap-4 px-1 pt-2 pb-1">
              <div>
                <Line label="Active">
                  <TokenAmount value={snapshot.backing.active} token={factory} />
                </Line>
                <Line label="Reserved by live jobs">
                  <TokenAmount value={snapshot.backing.reserved} token={factory} />
                </Line>
                <Line label="Available for new deposits at risk">
                  <TokenAmount value={snapshot.backing.available} token={factory} />
                </Line>
                <Line label="Leaving">
                  <TokenAmount value={snapshot.backing.queued} token={factory} />
                </Line>
              </div>
              {snapshot.topDelegators.length > 0 && (
                <div className="grid gap-1">
                  <h3 className="text-xs font-medium text-muted-foreground">Top backers</h3>
                  {snapshot.topDelegators.map((position) => (
                    <div
                      key={position.delegator}
                      className="flex min-h-9 items-center gap-3 border-t border-border/70 py-1 text-sm first:border-t-0"
                    >
                      <AddressText
                        value={position.delegator}
                        you={viewer !== undefined && position.delegator.toLowerCase() === viewer.toLowerCase()}
                      />
                      <span className="tabular-nums ml-auto text-right">
                        <TokenAmount value={position.value} token={factory} />
                        <span className="block text-xs text-muted-foreground">
                          {percent(position.shareBps)} of backing
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {snapshot.position !== null && (
                <div className="grid gap-1 rounded-lg bg-muted p-3">
                  <p className="text-xs font-medium text-muted-foreground">Your position</p>
                  <p className="tabular-nums font-semibold">
                    <TokenAmount value={snapshot.position.value} token={factory} /> ·{' '}
                    {percent(snapshot.position.shareBps)}
                  </p>
                  {snapshot.position.queuedShares > 0n && (
                    <p className="text-sm text-muted-foreground">
                      <TokenAmount value={snapshot.position.queued} token={factory} /> leaving ·{' '}
                      {snapshot.position.unlockAt > now ? (
                        <Countdown to={snapshot.position.unlockAt} />
                      ) : snapshot.backing.assets - snapshot.position.queued < snapshot.backing.reserved ? (
                        'Waiting for deposits at risk to clear'
                      ) : (
                        'Ready to withdraw'
                      )}
                    </p>
                  )}
                </div>
              )}
              <p className="text-xs leading-relaxed text-muted-foreground">{DELEGATION_RISK}</p>
            </div>
          </Disclosure>
        </div>
      )}
    </Section>
  )
}
