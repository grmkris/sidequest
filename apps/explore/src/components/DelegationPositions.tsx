import { cn } from '../lib/cn.ts'
import { useQuery } from '@tanstack/react-query'
import { Badge } from './ui/badge.tsx'
import { Button } from './ui/button.tsx'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from './ui/empty.tsx'
import { Address as AddressText, Section, textLinkClass } from './kit.tsx'
import { BoardLink, boardRoutes } from './BoardLink.tsx'
import type { Address } from 'viem'
import type { BackedPosition } from '../delegation-query.ts'
import { formatNumber } from '../format.ts'
import { percent } from '../stake.ts'
import { Countdown, useNow } from './Time.tsx'
import { TokenAmount } from './token/TokenAmount.tsx'
import { deployment } from '../wallet.ts'
import { data } from '../api.ts'
import { positionLabel, type PositionLabelSources } from '../position-label.ts'
import { AgentOrb } from './agent/AgentOrb.tsx'
import { Monogram } from './Wallet.tsx'

export const factoryValue = (value: bigint) => `${formatNumber(value, 18)} SIDE`

export const walletAgentsKey = (account: string) => [
  'data-agents-wallet',
  deployment.chainId,
  deployment.identity,
  account.toLowerCase(),
]

export const DELEGATION_RISK =
  'If the agent is slashed for bad work, everyone backing it loses the same share. Your SIDE stays at risk until you withdraw. Leaving starts the configured unstake period (3 days on the fresh testnet clocks; 14 days in production); open jobs secured against the backing remain slashable during that period.'

type Status = 'lost' | 'leaving' | 'bonded' | 'ready' | 'active' | 'exited'

/** Where a position stands: leaving and waiting out the unstake period, held by live deposits, ready, active or out. */
function statusOf({ position, backing }: BackedPosition, now: number): Status {
  const queued = position.queuedShares > 0n
  if (position.staleGeneration) return 'lost'
  if (queued && position.unlockAt > now) return 'leaving'
  if (queued && backing.assets - position.queued < backing.reserved) return 'bonded'
  if (queued) return 'ready'
  return position.shares > 0n ? 'active' : 'exited'
}

const CHIP: Record<Exclude<Status, 'active'>, { text: string; variant: 'warning' | 'success' | 'neutral' }> = {
  lost: { text: 'Lost in a full slash', variant: 'neutral' },
  leaving: { text: 'Leaving', variant: 'neutral' },
  bonded: { text: 'Held by live deposits', variant: 'warning' },
  ready: { text: 'Ready to withdraw', variant: 'success' },
  exited: { text: 'Exited', variant: 'neutral' },
}

/**
 * The wallet's backing positions, one line each: who it backs, how much and what share of that backing, the fee it
 * pays and what its backers get, and where the position stands when it is not simply active. Adding or leaving opens
 * the backing form; cancelling a leave and withdrawing are right on the line when they apply.
 */
export function DelegationPositions({
  positions,
  sources,
  disabled,
  onEdit,
  onCancel,
  onWithdraw,
}: {
  positions: BackedPosition[]
  sources: PositionLabelSources
  disabled: boolean
  onEdit: (account: Address, mode: 'add' | 'leave') => void
  onCancel: (account: Address) => void
  onWithdraw: (account: Address) => void
}) {
  const now = useNow()
  return (
    <Section title="My positions">
      {positions.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No positions yet</EmptyTitle>
            <EmptyDescription>Back an agent and the position shows here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="m-0 flex list-none flex-col overflow-hidden rounded-xl bg-card p-0 shadow-stock">
          {positions.map((entry) => (
            <PositionRow
              key={entry.position.account}
              entry={entry}
              status={statusOf(entry, now)}
              sources={sources}
              disabled={disabled}
              onEdit={onEdit}
              onCancel={onCancel}
              onWithdraw={onWithdraw}
            />
          ))}
        </ul>
      )}
    </Section>
  )
}

function PositionRow({
  entry: { position, backing },
  status,
  sources,
  disabled,
  onEdit,
  onCancel,
  onWithdraw,
}: {
  entry: BackedPosition
  status: Status
  sources: PositionLabelSources
  disabled: boolean
  onEdit: (account: Address, mode: 'add' | 'leave') => void
  onCancel: (account: Address) => void
  onWithdraw: (account: Address) => void
}) {
  const queued = position.queuedShares > 0n
  const facts = [`${percent(position.shareBps)} of its backing`, `${percent(backing.tier.feeBps)} fee`]
  return (
    <li
      aria-label={`Position in ${positionLabel(position.account, sources).name}`}
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/70 px-4 py-2.5 first:border-t-0"
    >
      <div className="grid min-w-0 flex-1 basis-56 gap-0.5">
        <PositionIdentity account={position.account} sources={sources} />
        <p className="pl-7 text-xs text-muted-foreground tabular-nums">
          {facts.join(' · ')}
          {queued && (
            <>
              {' · '}
              {factoryValue(position.queued)} leaving
              {status === 'leaving' && (
                <>
                  , <Countdown to={position.unlockAt} /> left
                </>
              )}
            </>
          )}
        </p>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {status !== 'active' && <Badge variant={CHIP[status].variant}>{CHIP[status].text}</Badge>}
        <span className="text-sm font-semibold tabular-nums">
          <TokenAmount value={position.value} token={deployment.factory} />
        </span>
        {queued && status !== 'ready' && (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onCancel(position.account)}>
            Cancel leaving
          </Button>
        )}
        {status === 'ready' && (
          <Button size="sm" disabled={disabled} onClick={() => onWithdraw(position.account)}>
            Withdraw
          </Button>
        )}
        <Button variant="secondary" size="sm" disabled={disabled} onClick={() => onEdit(position.account, 'add')}>
          Manage
        </Button>
      </div>
    </li>
  )
}

function PositionIdentity({ account, sources }: { account: Address; sources: PositionLabelSources }) {
  const local = positionLabel(account, sources)
  const walletAgents = useQuery({
    queryKey: walletAgentsKey(account),
    queryFn: () => data<{ agents: string[] }>(`agents?wallet=${encodeURIComponent(account)}`),
    enabled: local.kind === 'address',
    staleTime: 5 * 60_000,
  })
  const label = positionLabel(account, { ...sources, walletAgents: walletAgents.data?.agents })
  return (
    <div className="flex min-w-0 items-center gap-2">
      {label.kind === 'agent' ? <AgentOrb agentId={label.agentId ?? account} size="sm" /> : <Monogram seed={account} />}
      <span className="min-w-0">
        {label.agentId !== undefined ? (
          <BoardLink
            target={boardRoutes().agent(label.agentId)}
            className={cn(textLinkClass, 'flex min-h-8 min-w-0 items-center text-sm font-medium')}
          >
            <span className="truncate">{label.name}</span>
          </BoardLink>
        ) : label.kind === 'address' ? (
          <AddressText value={account} />
        ) : (
          <span className="block truncate text-sm font-medium">{label.name}</span>
        )}
      </span>
    </div>
  )
}
