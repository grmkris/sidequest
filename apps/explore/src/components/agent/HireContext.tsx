import { useQuery } from '@tanstack/react-query'
import type { AgentApproval } from '../../agent-api.ts'
import { boardApi } from '../../api.ts'
import { localTime } from '../../format.ts'
import { screeningWarning } from '../../screening.ts'
import { deployment } from '../../wallet.ts'
import { Mark } from '../controls.tsx'
import { Details } from '../kit.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'

/**
 * The same frozen brief and request identity on waiting cards and in decision history. A waiting card (`screening`)
 * also says when the screener flagged the brief, so a job no worker can take is questioned before its bond is locked.
 */
export function HireContext({ approval, screening = false }: { approval: AgentApproval; screening?: boolean }) {
  const context = approval.context
  const hire = context?.hire
  if (approval.kind !== 'hire-over-limit') return null
  return (
    <div className="grid min-w-0 gap-3">
      {hire == null ? (
        <p className="text-sm text-destructive-text">
          The exact hire brief is unavailable. Reload the approval before signing.
        </p>
      ) : (
        <>
          <h3 className="text-lg font-semibold text-foreground">{hire.title}</h3>
          {screening && context !== undefined && <HireScreening boardId={context.boardId} taskId={hire.taskId} />}
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{hire.brief}</p>
          <p className="text-sm">
            Creator bond: <TokenAmount value={hire.creatorBond} token={deployment.factory} /> from this agent’s backing.
          </p>
          <Details summary="Acceptance criteria">
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {hire.acceptanceCriteria.map((criterion, i) => (
                <li key={i}>{criterion}</li>
              ))}
            </ul>
          </Details>
          <a
            className="justify-self-start text-sm underline underline-offset-4"
            href={`/offers/${encodeURIComponent(hire.termsHash)}.json`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Read frozen offer
          </a>
          <p className="break-all text-xs text-muted-foreground">
            Task <span className="font-mono">{hire.taskId}</span>
          </p>
        </>
      )}
      {context !== undefined && (
        <p className="break-all text-xs text-muted-foreground">
          Request key <span className="font-mono">{context.operationKey}</span> · Board {context.boardId}
        </p>
      )}
      {approval.created_at !== undefined && (
        <p className="text-xs text-muted-foreground">
          Requested{' '}
          <time dateTime={new Date(approval.created_at * 1000).toISOString()}>{localTime(approval.created_at)}</time>
        </p>
      )}
    </div>
  )
}

/** The screener's flag on this brief, read from the public task; nothing while reading, on failure or when clean. */
function HireScreening({ boardId, taskId }: { boardId: string; taskId: string }) {
  const task = useQuery({
    queryKey: ['hire-screening', boardId, taskId],
    queryFn: () =>
      boardApi(boardId).tool<{ screening?: { verdict: string; reasons: string[] } | null }>('get_task', { taskId }),
    staleTime: 5 * 60_000,
    retry: 1,
  })
  const warning = screeningWarning(task.data?.screening)
  if (warning === null) return null
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-xl bg-muted/60 p-3" role="note">
      <Mark tone={warning.tone} />
      <div className="grid min-w-0 gap-1 text-sm">
        <p className="font-medium text-foreground">Screening: {warning.text}</p>
        {warning.reasons.length > 0 && (
          <ul className="grid list-disc gap-0.5 pl-5 text-ui leading-snug text-muted-foreground">
            {warning.reasons.map((reason) => (
              <li key={reason} className="first-letter:uppercase">
                {reason}
              </li>
            ))}
          </ul>
        )}
        <p className="text-ui text-muted-foreground">
          Advice only. If no worker could take it as written, reject it: a rejected hire publishes and pays nothing.
        </p>
      </div>
    </div>
  )
}
