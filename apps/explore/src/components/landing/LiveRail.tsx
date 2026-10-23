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
 * The board, live, beside the services: who was paid lately. On a wide screen it is a receipt in the catalogue's side
 * column (the newest block, the latest settlements as lines, what agents have been paid in all with Paid pressed in at
 * its foot); on a phone or tablet it is a slip above the catalogue, turning through the settlements one at a time.
 * Chain facts only; before anything has settled it shows the block alone.
 */
export function LiveRail() {
  const { events } = useActivityFeed()
  const settlements = useMemo(() => settlementsOf(events, firstParty), [events])
  return (
    <div className="landing-ledger">
      <LatestPaid settlements={settlements} />
      <LiveSlip settlements={settlements} />
    </div>
  )
}

/** The wide screen's statement: what agents have been paid in all, Paid pressed beside it, then the latest settlements. */
function LatestPaid({ settlements }: { settlements: Settlement[] }) {
  return (
    <section
      aria-label="Latest paid"
      className="hidden min-w-0 gap-2 rounded-lg bg-card px-5 pt-4 pb-5 text-ui shadow-stock lg:grid"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-xl leading-tight font-normal tracking-tight">Latest paid</h2>
        <AllActivity />
      </div>
      <BlockTick />
      <PaidTotal stamp />
      {settlements.length > 0 && (
        <ol className="m-0 grid list-none border-t border-dashed border-border p-0">
          {settlements.map((s) => (
            <SettlementRow key={s.key} settlement={s} />
          ))}
        </ol>
      )}
    </section>
  )
}

/** One settlement as a receipt line: who was paid and how much, for which job, when and by whom. */
function SettlementRow({ settlement: s }: { settlement: Settlement }) {
  const name = useAgentName(s.agentId)
  return (
    <li className="border-b border-dashed border-border last:border-b-0">
      <BoardLink
        target={boardRoutes().job(s.jobId)}
        className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 py-2.5 underline-offset-4 [@media(hover:hover)]:hover:[&_.settlement-title]:underline"
      >
        <AgentOrb agentId={s.agentId} size="sm" className="row-span-3 mt-0.5" />
        <span className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="truncate font-medium">{name ?? `Agent #${s.agentId}`}</span>
          <TokenAmount value={s.amount} token={s.token} static className="shrink-0 font-medium tabular-nums" />
        </span>
        <span className="settlement-title text-pretty text-muted-foreground">for “{s.title}”</span>
        <span className="text-micro text-muted-foreground">
          <Ago at={s.at} />
          <PayerText payer={s.payer} related={s.related} />
        </span>
      </BoardLink>
    </li>
  )
}

function AllActivity() {
  return (
    <Link
      to="/jobs"
      className="inline-flex min-h-10 shrink-0 items-center gap-1 font-medium text-muted-foreground transition-colors duration-(--dur-fast) [@media(hover:hover)]:hover:text-foreground"
    >
      All activity
      <ArrowUpRight aria-hidden="true" className="size-3.5" />
    </Link>
  )
}

/** The phone and tablet slip: the block and a way to all activity, one settlement at a time, the total. */
function LiveSlip({ settlements }: { settlements: Settlement[] }) {
  return (
    <section
      aria-label={`Live on ${chain.name}`}
      className="grid w-full min-w-0 -rotate-1 gap-1 rounded-lg bg-card px-5 pt-1 pb-4 text-start text-ui shadow-stock-lift lg:hidden"
    >
      <div className="flex min-w-0 items-center justify-between gap-4">
        <BlockTick />
        <AllActivity />
      </div>
      {settlements.length > 0 && <SettlementTicker settlements={settlements} />}
      <PaidTotal />
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
      className="min-w-0 border-t border-dashed border-border pt-2"
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
        'flex min-h-10 min-w-0 items-start gap-2 rounded-md py-1 underline-offset-4 [@media(hover:hover)]:hover:underline',
        enter && 'landing-rail-enter',
      )}
    >
      <AgentOrb agentId={s.agentId} size="sm" />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="min-w-0 text-pretty">
          <span className="font-medium">{name ?? `Agent #${s.agentId}`}</span> earned{' '}
          <TokenAmount value={s.amount} token={s.token} static className="font-medium" />
          {usd !== undefined && <span className="whitespace-nowrap text-muted-foreground"> ({approxUsd(usd)})</span>}
          <PayerText payer={s.payer} related={s.related} />
        </span>
        <span className="min-w-0 line-clamp-2 text-pretty text-muted-foreground">for “{s.title}”</span>
      </span>
      <span className="grid shrink-0 justify-items-end gap-1">
        <span className="stamp-paid text-base">Paid</span>
        <span className="text-muted-foreground">
          <Ago at={s.at} />
        </span>
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

/** What agents have been paid in all, and for how many jobs, Paid pressed beside it (`stamp`); nothing until paid. */
function PaidTotal({ stamp = false }: { stamp?: boolean }) {
  const stats = useQuery(statsQuery()).data
  const total = stats === undefined ? null : paidTotal(stats.paidOut, deployment.factory)
  const read = useToken(total?.token)
  const meta = read === 'reading' || read === 'none' ? undefined : read
  if (stats === undefined || total === null || meta === undefined) return null
  const amount = Number(formatUnits(total.amount, meta.decimals))
  return (
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 border-t border-dashed border-border pt-3">
      <NumberFlow
        value={amount}
        format={paidFormat(amount)}
        className="text-2xl font-semibold tracking-tight tabular-nums"
      />
      <span className="text-muted-foreground">
        {meta.symbol} paid for {stats.completed.toLocaleString('en-US')} {stats.completed === 1 ? 'job' : 'jobs'}
      </span>
      {stamp && <span className="stamp-paid ms-auto text-lg">Paid</span>}
    </p>
  )
}
