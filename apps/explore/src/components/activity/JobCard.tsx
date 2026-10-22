/**
 * A job's card, opened from its row: a delivered job shows the work, who paid whom, the receipt and the transaction
 * that paid it; a job under way says who hired whom and what is due when; an open request or listing says what it may
 * pay and how long it stays open. Every card ends at the job's own page. Everything here is public: chain facts and
 * the board's recorded offer and deliverable.
 */
import { Check, CircleAlert, ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import { type FeedJob, jobCardKind, posterParty, trackOf } from '../../activity-feed.ts'
import { currentBoardId } from '../../api.ts'
import { type RowDelivery, useRowDelivery } from '../../delivery-preview.ts'
import { previewPlan } from '../../delivery-plan.ts'
import { KIND, checkState, deliveryHref, deliveryWhere } from '../../delivery.ts'
import { jobTarget, rowCountdown, titleOf } from '../../job-list.ts'
import { cn } from '../../lib/cn.ts'
import { paidTx, receiptMoney } from '../../receipt.ts'
import { stage } from '../../wallet.ts'
import { AgentLink } from '../agent/AgentChip.tsx'
import { CardAction, useCardFrame } from '../CardLink.tsx'
import { DeliveryPreview } from '../delivery/DeliveryPreview.tsx'
import { TxLink, textLinkClass } from '../kit.tsx'
import { RollingCountdown } from '../RollingCountdown.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'
import { Skeleton } from '../ui/skeleton.tsx'
import { WalletLink } from '../WalletLink.tsx'
import { StepTrack } from './StepTrack.tsx'

/** A label, a dotted leader and a value, like a printed receipt's line. */
function Leader({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <span aria-hidden className="min-w-4 flex-1 translate-y-[-0.2em] border-b border-dotted border-foreground/25" />
      <dd className="shrink-0 font-medium tabular-nums">{children}</dd>
    </div>
  )
}

/** Who paid or hired whom: the poster (its agent, else its wallet), a drawn arrow, the hired agent; or who posted it. */
function Parties({ job }: { job: FeedJob }) {
  const poster = posterParty(job)
  if (job.workerAgent === null && poster === null) return null
  const verb = job.bucket === 'paid' ? 'paid' : 'hired'
  const posterLink =
    poster === null ? null : 'agent' in poster ? (
      <AgentLink id={poster.agent} orb />
    ) : (
      <WalletLink address={poster.wallet} />
    )
  if (job.workerAgent === null)
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui">
        <span className="text-muted-foreground">Posted by</span>
        {posterLink}
      </p>
    )
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui">
      {posterLink}
      <span aria-hidden className="flex items-center text-muted-foreground">
        <span className="w-4 border-t border-current" />
        <span className="px-1 text-xs">{verb}</span>
        <span className="w-3 border-t border-current" />
        <span className="-ml-0.5">▸</span>
      </span>
      <span className="sr-only">{verb}</span>
      <AgentLink id={job.workerAgent} orb />
    </p>
  )
}

const CHECK = {
  ok: { text: 'Checked at submit', className: 'text-success-text' },
  failed: { text: 'Check at submit failed', className: 'text-destructive-text' },
  unchecked: { text: 'Not checked', className: 'text-muted-foreground' },
} as const

/** Where the delivery lives (a link when it has a web address) and the board's check at submit, a line each. */
function DeliveryLines({ delivery }: { delivery: RowDelivery }) {
  const d = delivery.deliverable.descriptor
  const href = deliveryHref(d)
  const check = checkState(delivery.deliverable.check)
  const where = deliveryWhere(d)
  return (
    <div className="grid gap-1 text-xs">
      <p className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-muted-foreground">{KIND[d.kind]}</span>
        {href === null ? (
          <span className="min-w-0 truncate font-mono">{where}</span>
        ) : (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className={cn(textLinkClass, 'inline-flex min-w-0 items-center gap-1')}
          >
            <span className="truncate font-mono">{where}</span>
            <ExternalLink aria-hidden className="size-3 shrink-0" />
          </a>
        )}
      </p>
      {check !== null && (
        <p className="flex min-w-0 items-center gap-1.5" title={delivery.deliverable.check?.detail}>
          <span className={cn('inline-flex shrink-0 items-center gap-1', CHECK[check].className)}>
            {check === 'ok' ? (
              <Check aria-hidden className="size-3" strokeWidth={3} />
            ) : (
              <CircleAlert aria-hidden className="size-3" />
            )}
            {CHECK[check].text}
          </span>
          <span className="min-w-0 truncate text-muted-foreground">{delivery.deliverable.check?.detail}</span>
        </p>
      )}
    </div>
  )
}

/** The delivery: its picture or glyph on top, its line and check below; a placeholder while it is read. */
function useDelivery(job: FeedJob) {
  const delivered = job.item.chain?.deliverable != null
  const read = useRowDelivery(job, delivered)
  if (!delivered) return { visual: null, line: null }
  if (read.isPending) return { visual: <Skeleton className="aspect-[16/9] w-full rounded-none" />, line: null }
  const delivery = read.data ?? null
  const descriptor = delivery?.deliverable.descriptor ?? null
  const plan = previewPlan({
    jobId: job.item.jobId,
    stage,
    deliverable: descriptor,
    preview: delivery?.preview ?? null,
  })
  return {
    visual: <DeliveryPreview plan={plan} deliverable={descriptor} />,
    line: delivery === null ? null : <DeliveryLines delivery={delivery} />,
  }
}

/** The money as a receipt: reward, the agent's share or pay, the fee. */
function Money({ job }: { job: FeedJob }) {
  const chain = job.item.chain
  const money = receiptMoney(chain, job.bucket === 'paid')
  if (money.length === 0) return null
  return (
    <dl className="m-0 grid gap-1 font-mono text-xs">
      {money.map((line) => (
        <Leader key={line.label} label={line.label}>
          <TokenAmount value={line.value} token={chain?.token} static />
        </Leader>
      ))}
    </dl>
  )
}

/** An open request's or listing's terms: what it may pay, how long it stays open and, for a request, how many quoted. */
function OpenTerms({ job }: { job: FeedJob }) {
  const { request, chain } = job.item
  const countdown = rowCountdown(job.phase)
  const quotes = request?.quotesCount ?? 0
  return (
    <dl className="m-0 grid grid-cols-3 gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-ui">
      <div className="grid min-w-0 gap-0.5">
        <dt className="text-xs text-muted-foreground">{request === undefined ? 'Reward' : 'Up to'}</dt>
        <dd className="min-w-0 truncate font-medium tabular-nums">
          {request?.budget !== undefined ? (
            <TokenAmount value={request.budget.max} token={request.budget.token} static />
          ) : chain?.reward != null ? (
            <TokenAmount value={chain.reward} token={chain.token} static />
          ) : (
            'Open'
          )}
        </dd>
      </div>
      <div className="grid min-w-0 gap-0.5">
        <dt className="text-xs text-muted-foreground">{request === undefined ? 'Waiting' : 'Quotes'}</dt>
        <dd className="min-w-0 truncate font-medium tabular-nums">{request === undefined ? 'For an agent' : quotes}</dd>
      </div>
      <div className="grid min-w-0 gap-0.5">
        <dt className="text-xs text-muted-foreground">{countdown === null ? 'Status' : countdown.verb}</dt>
        <dd className="min-w-0 truncate font-medium tabular-nums">
          {countdown === null ? (
            (job.phase?.label ?? 'Closed')
          ) : (
            <RollingCountdown to={countdown.to} passed={countdown.passed} />
          )}
        </dd>
      </div>
    </dl>
  )
}

/** What is due next on a job under way, and when. */
function Due({ job }: { job: FeedJob }) {
  const countdown = rowCountdown(job.phase)
  if (countdown === null) return null
  return (
    <p className="flex items-baseline gap-1 text-ui">
      <span className="text-muted-foreground">{countdown.verb}</span>
      <RollingCountdown to={countdown.to} passed={countdown.passed} />
    </p>
  )
}

/** The foot: a paid stamp with its transaction, else where the job stands; and the job's page. */
function Foot({ job }: { job: FeedJob }) {
  const paid = job.bucket === 'paid'
  const tx = paidTx(job.steps)
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-dashed border-border pt-3">
      {paid ? (
        <span className="flex items-center gap-2">
          <span className="stamp-paid">Paid</span>
          <TxLink hash={tx} />
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">{job.phase?.label ?? ''}</span>
      )}
      <CardAction target={jobTarget(job.item, currentBoardId())}>
        {job.item.jobId === null ? 'Open request' : 'Open job'}
      </CardAction>
    </div>
  )
}

export function JobCard({ job }: { job: FeedJob }) {
  const { inSheet } = useCardFrame()
  const kind = jobCardKind(job)
  const delivery = useDelivery(job)
  const brief = job.item.request?.brief ?? job.item.task?.brief ?? ''
  return (
    <div className={cn('grid', inSheet && 'gap-3')}>
      {delivery.visual !== null && (
        <div
          className={cn(
            'overflow-hidden border-border/70',
            inSheet ? 'rounded-lg ring-1 ring-foreground/10' : 'rounded-t-xl border-b',
          )}
        >
          {delivery.visual}
        </div>
      )}
      <div className={cn('grid gap-3', !inSheet && 'p-3.5')}>
        {/* A sheet's title already names the job. */}
        {!inSheet && <p className="leading-snug font-medium">{titleOf(job.item) || `Job #${job.item.jobId ?? ''}`}</p>}
        <Parties job={job} />
        {kind === 'open' && <OpenTerms job={job} />}
        {kind === 'underway' && <Due job={job} />}
        {kind !== 'delivered' && brief !== '' && (
          <p className="line-clamp-3 text-ui text-pretty text-muted-foreground">{brief}</p>
        )}
        {kind !== 'open' && <Money job={job} />}
        <StepTrack stops={trackOf(job)} />
        {delivery.line}
        <Foot job={job} />
      </div>
    </div>
  )
}
