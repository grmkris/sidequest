/**
 * The agent's record in one strip of figures: how its work went (success, earned), how its hiring went (posted, paid
 * out) and its time (how fast it delivers, since when), then its ratings and bonds as one line of chips. Money is gross
 * in the strip; pressing or hovering it shows gross, Sidequest's fee and net per token.
 */
import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { CircleCheck, CircleX, Flame, RotateCcw, TriangleAlert } from 'lucide-react'
import { type MoneyLine, moneyLines, sinceDay, success } from '../../agent-stats.ts'
import { formatNumber, relative, span, tokenInfo } from '../../format.ts'
import { type AgentRecord, type MoneyTotals, ratings, times } from '../../routes/Agent.tsx'
import { useTokenList } from '../../useTokens.ts'
import { Stat } from '../kit.tsx'
import { StaticTokens, TokenAmount } from '../token/TokenAmount.tsx'
import { TokenIcon } from '../token/TokenIcon.tsx'
import { Popover, PopoverContent } from '../ui/popover.tsx'

/** Gross in the strip (the largest token, "+N" for the rest), the per-token breakdown on press or hover. */
function MoneyFigure({
  label,
  totals,
  net,
}: {
  label: string
  totals: Record<string, MoneyTotals> | undefined
  net: string
}) {
  const { lines, all } = moneyLines(totals, 1)
  if (all.length === 0) return <Stat label={label} value="None" />
  const more = all.length - lines.length
  return (
    <Stat
      label={label}
      value={
        <Popover>
          <PopoverPrimitive.Trigger
            openOnHover
            delay={250}
            className="-mx-1 cursor-pointer rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [@media(hover:hover)]:hover:bg-muted/60"
          >
            <StaticTokens>
              {lines.map((line) => (
                <TokenAmount key={line.token} value={line.gross} token={line.token} />
              ))}
            </StaticTokens>
          </PopoverPrimitive.Trigger>
          <PopoverContent side="bottom" align="start" className="w-80">
            <Breakdown lines={all} net={net} />
          </PopoverContent>
        </Popover>
      }
      sub={more > 0 ? `+${more} more · before Sidequest's fee` : "Before Sidequest's fee"}
    />
  )
}

const n = (value: string, token: string) => formatNumber(BigInt(value), tokenInfo(token).decimals)

function Breakdown({ lines, net }: { lines: MoneyLine[]; net: string }) {
  return (
    <div className="grid gap-2">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted-foreground">
            <th className="pb-1 text-left font-normal">Token</th>
            <th className="pb-1 text-right font-normal">Gross</th>
            <th className="pb-1 text-right font-normal">Fee</th>
            <th className="pb-1 text-right font-normal">Net</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {lines.map((line) => (
            <tr key={line.token}>
              <td className="py-0.5 pr-2 whitespace-nowrap">
                <TokenIcon token={line.token} className="mr-1.5" />
                {tokenInfo(line.token).symbol}
              </td>
              <td className="py-0.5 text-right">{n(line.gross, line.token)}</td>
              <td className="py-0.5 text-right text-muted-foreground">{n(line.fee, line.token)}</td>
              <td className="py-0.5 text-right font-medium">{n(line.net, line.token)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground">Gross is the reward and any bonus. {net}</p>
    </div>
  )
}

/** `owner`: its operator, whose Needs you already lists the overdue jobs, so the warning is not repeated. */
export function HeroStats({ record, now, owner = false }: { record: AgentRecord; now: number; owner?: boolean }) {
  const a = record.agent
  useTokenList([...Object.keys(record.work?.earned ?? a.earned), ...Object.keys(record.hiring?.paidOut ?? {})])
  const took = a.jobs
  const posted = record.hiring?.posted ?? 0
  const s = success(a)
  // An older API has no gross/fee/net split: its earnings are what reached the wallet.
  const earned =
    record.work?.earned ??
    Object.fromEntries(Object.entries(a.earned).map(([token, v]) => [token, { gross: v, fee: '0', net: v }]))
  const overdue = record.jobs.filter(
    (j) => j.status === 'active' && j.delivery_deadline !== null && j.delivery_deadline < now,
  )
  const bondAtStake = overdue.some((j) => j.worker_bond !== null && j.worker_bond !== '0')
  const t = record.time
  return (
    <section aria-label="Record" className="grid gap-3">
      <dl className="flex flex-wrap gap-y-4 border-y border-border py-4 [&>*]:border-s [&>*]:border-border [&>*]:px-6 [&>*:first-child]:border-s-0 [&>*:first-child]:ps-1">
        {took > 0 &&
          (s.rate !== null ? (
            <Stat label="Success" value={`${Math.round(s.rate * 100)} %`} sub={`${s.paid} of ${s.settled} paid`} />
          ) : (
            <Stat
              label="Paid"
              value={s.settled === 0 ? 'None' : `${s.paid} of ${s.settled}`}
              sub={s.settled === 0 ? 'None settled yet' : 'Settled jobs'}
            />
          ))}
        {took > 0 && <MoneyFigure label="Earned" totals={earned} net="Net is what reached the agent's wallet." />}
        {posted > 0 && (
          <Stat
            label="Posted"
            value={posted}
            sub={(record.hiring?.open ?? 0) > 0 ? `${record.hiring?.open} open` : 'None open'}
          />
        )}
        {posted > 0 && (
          <MoneyFigure label="Paid out" totals={record.hiring?.paidOut} net="Net is what its workers received." />
        )}
        {t?.medianTurnaroundSeconds != null && (
          <Stat label="Delivers in" value={span(t.medianTurnaroundSeconds)} sub={`median of ${t.turnarounds}`} />
        )}
        {t?.activeSince != null && (
          <Stat
            label="Since"
            value={sinceDay(t.activeSince, now)}
            {...(t.lastActive === null ? {} : { sub: `active ${relative(t.lastActive, now)}` })}
          />
        )}
      </dl>

      {overdue.length > 0 && !owner && (
        <div role="status" className="flex items-start gap-3 rounded-xl bg-warning/14 px-4 py-3 text-sm leading-snug">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-text" />
          <p>
            <span className="font-medium">Needs attention:</span>{' '}
            {overdue.length === 1 ? 'one job it took is' : `${overdue.length} jobs it took are`} past the delivery
            deadline with nothing delivered. Anyone can close {overdue.length === 1 ? 'it' : 'them'}; the creator gets
            the reward back
            {bondAtStake ? ' and the deposit at risk goes to the treasury' : ''}.
          </p>
        </div>
      )}

      <Reputation record={record} />
    </section>
  )
}

/** The evaluators' ratings and what happened to its deposits, on one line; nothing before its first settled job. */
function Reputation({ record }: { record: AgentRecord }) {
  const rated = ratings(record.agent.feedback)
  const returned = record.bonds.returned ?? 0
  const burned = record.bonds.burned ?? 0
  if (rated.length === 0 && returned === 0 && burned === 0) return null
  return (
    <ul aria-label="Ratings" className="flex flex-wrap gap-x-4 gap-y-1.5 px-1 text-ui">
      {rated.map((r) => (
        <li key={r.tag} className="inline-flex items-center gap-1.5">
          {r.good ? (
            <CircleCheck aria-hidden className="size-3.5 text-success-text" />
          ) : (
            <CircleX aria-hidden className="size-3.5 text-destructive-text" />
          )}
          <span>
            <span className="tabular-nums font-medium">{r.count}</span> {r.words}
          </span>
        </li>
      ))}
      {returned > 0 && (
        <li className="inline-flex items-center gap-1.5 text-muted-foreground">
          <RotateCcw aria-hidden className="size-3.5" />
          Deposit returned {times(returned)}
        </li>
      )}
      {burned > 0 && (
        <li className="inline-flex items-center gap-1.5 text-destructive-text">
          <Flame aria-hidden className="size-3.5" />
          Deposit sent to the treasury {times(burned)}
        </li>
      )}
    </ul>
  )
}
