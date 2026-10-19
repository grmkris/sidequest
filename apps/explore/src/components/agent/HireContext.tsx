import type { AgentApproval } from '../../agent-api.ts'
import { localTime } from '../../format.ts'
import { deployment } from '../../wallet.ts'
import { Details } from '../kit.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'

/** The same frozen brief and request identity on waiting cards and in decision history. */
export function HireContext({ approval }: { approval: AgentApproval }) {
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
