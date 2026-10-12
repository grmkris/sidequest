import { useState } from 'react'
import { Schema } from 'effect'
import { agentEndpoint, type ManagedAgent } from '../../api.ts'
import type { AgentApproval } from '../../agent-api.ts'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Badge } from '../ui/badge.tsx'
import { Button } from '../ui/button.tsx'
import { Section } from '../kit.tsx'
import { ConfirmButton } from '../Sheet.tsx'

const Request = Schema.Struct({ role: Schema.Literals(['work', 'hire']), reason: Schema.optionalKey(Schema.String) })

const WHAT: Record<'work' | 'hire', { ask: string; risk: string }> = {
  work: {
    ask: 'take and deliver jobs',
    risk: 'Its worker bonds come from its SIDE backing, and bad delivery can be slashed at once.',
  },
  hire: {
    ask: 'hire other agents',
    risk: 'It pays within its weekly budget; deposits it reserves when posting are not capped by that budget.',
  },
}

/**
 * An agent asks for a role (ADR-0021). Allowing it adds the role at once, and every client connected as the agent
 * follows; the agent's request is answered without being run again.
 */
export function RoleApproval({
  approval,
  agent,
  refresh,
}: {
  approval: AgentApproval
  agent: ManagedAgent
  refresh: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  let request: Schema.Schema.Type<typeof Request> | null = null
  try {
    request = Schema.decodeUnknownSync(Request)(JSON.parse(approval.request_json))
  } catch {
    request = null
  }
  async function decide(approved: boolean) {
    setBusy(true)
    setError(null)
    try {
      await agentEndpoint(`/api/approvals/${approval.id}/decide`, 'POST', { approved })
      await refresh()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The decision did not go through')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title={`${agent.name} · Role request`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xl font-semibold">
          {request === null ? 'An unreadable request' : `Let it ${WHAT[request.role].ask}`}
        </p>
        <Badge variant={approval.status === 'pending' ? 'warning' : 'neutral'}>{approval.status}</Badge>
      </div>
      {request?.reason !== undefined && (
        <p className="text-sm text-muted-foreground">
          Its reason, in its own words: <q className="text-foreground">{request.reason}</q>
        </p>
      )}
      {request !== null && <p className="text-sm text-muted-foreground">{WHAT[request.role].risk}</p>}
      {approval.status === 'pending' && request !== null && (
        <div className="flex flex-wrap gap-2">
          <Button busy={busy} onClick={() => void decide(true)}>
            Allow
          </Button>
          <ConfirmButton
            disabled={busy}
            title={`Decline ${agent.name}'s request?`}
            description={`${agent.name} keeps the roles it has and is told you said no. It can ask again.`}
            confirm="Decline"
            onConfirm={() => void decide(false)}
          >
            Decline
          </ConfirmButton>
        </div>
      )}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </Section>
  )
}
