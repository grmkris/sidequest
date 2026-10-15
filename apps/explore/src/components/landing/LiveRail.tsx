import NumberFlow from '@number-flow/react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatUnits } from 'viem'
import { useBlockNumber } from 'wagmi'
import { tokenInfo } from '../../format.ts'
import { cn } from '../../lib/cn.ts'
import { statsQuery } from '../../queries.ts'
import { approxUsd, usdPerUnit, usdValue, useSideUsd } from '../../usd.ts'
import { useToken } from '../../useTokens.ts'
import { chain, deployment, firstParty } from '../../wallet.ts'
import { useActivityFeed } from '../activity/useActivityFeed.ts'
import { useAgentName } from '../agent/AgentChip.tsx'
import { AgentOrb } from '../agent/AgentOrb.tsx'
import { usePrefersReducedMotion } from '../agent/shader-budget.ts'
import { BoardLink, boardRoutes } from '../BoardLink.tsx'
import { Ago } from '../Time.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'
import { paidFormat } from './live-format.ts'
import { type Payer, RAIL_HOLD_MS, type Settlement, paidTotal, railTurns, settlementsOf } from './live-rail.ts'

/**
 * The board, live, above the services: the chain's newest block, the latest settlements one at a time (who earned
 * what, from whom, for which job), and what agents have been paid in all. Chain facts only; before anything has
 * settled it shows the block alone.
 */
export function LiveRail() {
  const { events } = useActivityFeed()
  const settlements = useMemo(() => settlementsOf(events, firstParty), [events])
  return (
    <section
      aria-label={`Live on ${chain.name}`}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 rounded-2xl bg-card px-4 py-1.5 text-ui shadow-chip sm:flex sm:py-1"
    >
      <BlockTick />
      {settlements.length > 0 && <SettlementTicker settlements={settlements} />}
      <PaidTotal />
      <Link
        to="/jobs"
        className="inline-flex min-h-10 shrink-0 items-center gap-1 font-medium text-muted-foreground transition-colors duration-(--dur-fast) max-sm:col-start-2 max-sm:row-start-1 sm:ms-auto [@media(hover:hover)]:hover:text-foreground"
      >
        All activity
        <ArrowUpRight aria-hidden="true" className="size-3.5" />
      </Link>
    </section>
  )
}

/** The newest block, read every two seconds; each new number rolls in, never counted through. */
function BlockTick() {
  const block = useBlockNumber({ chainId: chain.id, watch: { pollingInterval: 2_000 } })
  return (
    <p className="inline-flex shrink-0 items-center gap-2" title={`${chain.name}'s newest block`}>
      <span className="live-dot" aria-hidden="true" />
      <span className="text-muted-foreground">{chain.name}</span>
      {block.data === undefined ? (
        <span className="text-muted-foreground">reading…</span>
      ) : (
        <NumberFlow value={Number(block.data)} prefix="#" className="font-medium tabular-nums" />
      )}
    </p>
  )
}

/** One settlement at a time, the next every few seconds; it holds still while read, and for reduced motion. */
function SettlementTicker({ settlements }: { settlements: Settlement[] }) {
  const reducedMotion = usePrefersReducedMotion()
  const [held, setHeld] = useState(false)
  const [index, setIndex] = useState(0)
  const turned = useRef(false)
  const turns = railTurns({ count: settlements.length, reducedMotion, held })
  useEffect(() => {
    if (!turns) return
    const timer = setInterval(() => {
      turned.current = true
      setIndex((i) => (i + 1) % settlements.length)
    }, RAIL_HOLD_MS)
    return () => clearInterval(timer)
  }, [turns, settlements.length])
  const shown = settlements[index % settlements.length]!
  return (
    <div
      className="min-w-0 max-sm:col-span-2 max-sm:row-start-2 sm:flex-1 sm:border-s sm:ps-4"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <SettlementLine key={shown.key} settlement={shown} enter={turned.current} />
    </div>
  )
}

function SettlementLine({ settlement: s, enter }: { settlement: Settlement; enter: boolean }) {
  const name = useAgentName(s.agentId)
  const sideUsd = useSideUsd()
  const usd = usdValue(BigInt(s.amount), tokenInfo(s.token).decimals, usdPerUnit(s.token, sideUsd))
  return (
    <BoardLink
      target={boardRoutes().job(s.jobId)}
      className={cn(
        'flex min-h-10 min-w-0 items-center gap-2 rounded-md underline-offset-4 [@media(hover:hover)]:hover:underline',
        enter && 'landing-rail-enter',
      )}
    >
      <AgentOrb agentId={s.agentId} size="sm" />
      <span className="min-w-0 flex-1 text-pretty line-clamp-2 sm:line-clamp-1">
        <span className="font-medium">{name ?? `Agent #${s.agentId}`}</span> earned{' '}
        <TokenAmount value={s.amount} token={s.token} static className="font-medium" />
        {usd !== undefined && <span className="text-muted-foreground"> ({approxUsd(usd)})</span>}
        <PayerText payer={s.payer} related={s.related} /> for “{s.title}”
      </span>
      <span className="shrink-0 text-muted-foreground">
        <Ago at={s.at} />
      </span>
    </BoardLink>
  )
}

function PayerText({ payer, related }: { payer: Payer | null; related: boolean }) {
  if (payer === null) return null
  if (payer === 'sidequest')
    return (
      <span title={related ? 'Sidequest posted this job, and one of its own agents did it.' : undefined}>
        {' '}
        from Sidequest
      </span>
    )
  if ('agent' in payer) return <PayerAgent id={payer.agent} />
  return <> from {`${payer.wallet.slice(0, 6)}…${payer.wallet.slice(-4)}`}</>
}

function PayerAgent({ id }: { id: string }) {
  return <> from {useAgentName(id) ?? `Agent #${id}`}</>
}

/** What agents have been paid in all, and for how many jobs; nothing until the board has paid out. */
function PaidTotal() {
  const stats = useQuery(statsQuery()).data
  const total = stats === undefined ? null : paidTotal(stats.paidOut, deployment.factory)
  const read = useToken(total?.token)
  const meta = read === 'reading' || read === 'none' ? undefined : read
  if (stats === undefined || total === null || meta === undefined) return null
  const amount = Number(formatUnits(total.amount, meta.decimals))
  return (
    <p className="hidden shrink-0 items-baseline gap-1 sm:inline-flex sm:border-s sm:ps-4">
      <NumberFlow value={amount} format={paidFormat(amount)} className="font-medium tabular-nums" />
      <span className="text-muted-foreground">
        {meta.symbol} paid for {stats.completed.toLocaleString('en-US')} {stats.completed === 1 ? 'job' : 'jobs'}
      </span>
    </p>
  )
}
