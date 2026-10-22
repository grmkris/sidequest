/**
 * An agent's decided approvals, newest answer first: one line each — what was asked, how much, the answer, when — that
 * opens to the detail (cadence and recipient of a permission, whether the operator narrowed it, the job an executed hire
 * published, the operation id). The waiting ones are full cards above this list, not part of it.
 */
import { ChevronRight } from 'lucide-react'
import type { AgentApproval } from '../../agent-api.ts'
import { approvalAnchor } from '../../owner-route.ts'
import { type ApprovalLine, approvalLine, jobOfLine } from '../../approval-view.ts'
import { localTime, relative } from '../../format.ts'
import type { RecordJob } from '../../routes/Agent.tsx'
import { BoardLink, boardRoutes } from '../BoardLink.tsx'
import { Section } from '../kit.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'
import { Badge } from '../ui/badge.tsx'
import { HireContext } from './HireContext.tsx'

const OUTCOME: Record<ApprovalLine['status'], { words: string; variant: 'success' | 'info' | 'neutral' | 'warning' }> =
  {
    executed: { words: 'Done', variant: 'success' },
    approved: { words: 'Approved', variant: 'info' },
    rejected: { words: 'Rejected', variant: 'neutral' },
    pending: { words: 'Waiting', variant: 'warning' },
  }

export function PastApprovals({
  approvals,
  factory,
  posted,
  focus = null,
}: {
  approvals: readonly AgentApproval[]
  factory: string
  posted: readonly RecordJob[] | undefined
  focus?: string | null
}) {
  if (approvals.length === 0) return null
  return (
    <Section title={`Past · ${approvals.length}`}>
      <div className="overflow-hidden rounded-xl bg-card shadow-stock">
        {approvals.map((approval) => {
          const line = approvalLine(approval, factory)
          const job = jobOfLine(line, posted)
          const outcome = OUTCOME[line.status]
          const at = line.decidedAt ?? line.createdAt
          return (
            <details
              key={approval.id}
              id={approvalAnchor(approval.id)}
              open={approval.id === focus || undefined}
              data-focus={approval.id === focus || undefined}
              className="group/past scroll-mt-24 border-t border-border/70 first:border-t-0 data-focus:bg-muted/50"
            >
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-4 py-2 text-sm select-none [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  aria-hidden
                  className="size-4 shrink-0 text-muted-foreground transition-transform duration-(--dur-fast) group-open/past:rotate-90"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{line.title}</span>
                  {approval.context !== undefined && approval.kind === 'hire-over-limit' && (
                    <span className="block break-all text-xs text-muted-foreground">
                      {approval.context.operationKey}
                    </span>
                  )}
                </span>
                {line.amount !== null && (
                  <TokenAmount value={line.amount.value} token={line.amount.token} static className="font-medium" />
                )}
                <Badge variant={outcome.variant}>{outcome.words}</Badge>
                {at !== null && (
                  <time
                    dateTime={new Date(at * 1000).toISOString()}
                    title={localTime(at)}
                    className="hidden w-20 shrink-0 text-right text-xs text-muted-foreground sm:block"
                  >
                    {relative(at)}
                  </time>
                )}
              </summary>
              <div className="grid gap-1.5 px-11 pb-3 text-sm text-muted-foreground">
                <HireContext approval={approval} />
                {line.detail !== null && <p>{line.detail}</p>}
                {line.adjusted && <p>You narrowed this request before granting it.</p>}
                {job !== undefined && (
                  <p>
                    Published{' '}
                    <BoardLink
                      target={boardRoutes(job.board_id ?? 'public').job(job.job_id)}
                      className="text-foreground underline decoration-foreground/30 underline-offset-4"
                    >
                      job #{job.job_id}
                    </BoardLink>
                  </p>
                )}
                {at !== null && <p className="sm:hidden">{localTime(at)}</p>}
                <p className="font-mono text-micro break-all">Operation {approval.operation_id}</p>
              </div>
            </details>
          )
        })}
      </div>
    </Section>
  )
}
