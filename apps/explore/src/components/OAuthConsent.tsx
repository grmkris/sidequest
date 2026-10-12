import { Button } from './ui/button.tsx'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from './ui/empty.tsx'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Section, Select } from './kit.tsx'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { type Address, getAddress } from 'viem'
import { agentEndpoint, type ManagedAgent } from '../api.ts'
import { AgentNew } from '../routes/AgentNew.tsx'
import { AllowanceEditor } from './AllowanceEditor.tsx'
import { AgentStake } from './AgentStake.tsx'

import { useAuth } from './Wallet.tsx'
import { NeedsBacking } from './backing/NeedsBacking.tsx'
import { OAuthClient, type OAuthClientIdentity } from './OAuthClient.tsx'
import { HandBackNote, SetupConnect } from './SetupConnect.tsx'
import { clientRedirect } from '../agent-setup-api.ts'

function rolesText(roles: readonly ('work' | 'hire')[]): string {
  const words = [
    ...(roles.includes('work') ? ['work (quote, deliver and earn)'] : []),
    ...(roles.includes('hire') ? ['hire (post and pay for jobs)'] : []),
  ]
  return words.length === 0 ? 'neither work nor hire yet' : words.join(' and ')
}

export function OAuthConsent({ requestId }: { requestId: string }) {
  const auth = useAuth()
  const request = useQuery({
    queryKey: ['oauth-request', requestId, auth.address],
    queryFn: () =>
      agentEndpoint<{
        request: OAuthClientIdentity & { scopes: string[]; resource: string; expiresAt: number }
        agents: ManagedAgent[]
        /** Whether this request may connect without an agent (the client asked for sidequest:setup). */
        setup?: { available: boolean }
      }>(`/oauth/requests/${requestId}`),
    enabled: auth.signedIn,
    retry: false,
  })
  const agents = useQuery({
    queryKey: ['managed-agents', auth.address],
    queryFn: () => agentEndpoint<{ agents: ManagedAgent[] }>('/api/agents'),
    enabled: auth.signedIn,
  })
  const [chosen, setSelected] = useState('')
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = agents.data?.agents.filter((row) => row.state === 'active') ?? []
  // One agent is the obvious answer: pick it, so connecting it is one button.
  const selected = chosen !== '' ? chosen : active.length === 1 ? active[0]!.id : ''
  const agent = agents.data?.agents.find((row) => row.id === selected)
  async function decide(approved: boolean) {
    setBusy(true)
    setError(null)
    try {
      // The connection gets what its client asked for; the agent's own roles decide within that (ADR-0021).
      const response = await agentEndpoint<{ redirectUrl: string }>(`/oauth/requests/${requestId}/approve`, 'POST', {
        decision: approved ? 'approve' : 'reject',
        agentIds: [selected],
      })
      window.location.assign(clientRedirect(response.redirectUrl))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'OAuth consent is unavailable')
    } finally {
      setBusy(false)
    }
  }
  if (!auth.signedIn)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Sign in to connect</EmptyTitle>
          <EmptyDescription>Use the operator wallet that owns the agent.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  if (request.error !== null)
    return (
      <Alert variant="destructive">
        <AlertDescription>
          This sign-in was already completed, maybe in another tab, or it expired. You can close this tab. If your
          coding agent is still waiting, run its connect command again; your agents stay registered.
        </AlertDescription>
      </Alert>
    )
  const redirectUri = request.data?.request.redirectUri
  const setup =
    request.data?.setup?.available === true ? <SetupConnect requestId={requestId} redirectUri={redirectUri} /> : null
  // Someone without an agent yet starts with the coding agent's setup; anyone else, with their agents.
  const noAgents = agents.data !== undefined && !agents.data.agents.some((row) => row.state === 'active')
  return (
    <div className="grid gap-6">
      {noAgents && setup}
      <Section title="Connect one agent" note={request.data?.request.resource ?? 'Loading connection request…'}>
        {request.data !== undefined && <OAuthClient client={request.data.request} />}
        <label className="grid gap-2 text-sm">
          <span>Agent</span>
          <Select value={selected} onChange={(event) => setSelected(event.target.value)}>
            <option value="">{agents.isLoading ? 'Loading your agents…' : 'Choose an active agent'}</option>
            {active.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name} · #{row.agent_id}
              </option>
            ))}
          </Select>
        </label>
        <Button variant="link" onClick={() => setCreating(!creating)}>
          {creating ? 'Close agent setup' : 'Create a new agent'}
        </Button>
        {creating && (
          <AgentNew
            context="oauth"
            onReady={(created) => {
              setSelected(created.id)
              setCreating(false)
              void agents.refetch()
            }}
          />
        )}
      </Section>
      {agent !== undefined && (
        <Section title="Connection permissions">
          <p className="font-semibold">Agent ID {agent.agent_id} is registered</p>
          <p className="text-sm">
            {agent.name} may {rolesText(agent.roles ?? [])}. You change that on its page; this connection follows.
          </p>
          <p className="text-sm text-muted-foreground">
            The weekly budget limits transfers of payment tokens. It does not limit deposits at risk: an agent can
            activate a job that requires a deposit, and a slash is immediate.
          </p>
          <Button
            busy={busy}
            disabled={agent.state !== 'active' || request.data === undefined}
            onClick={() => void decide(true)}
          >
            Use this agent for this connection
          </Button>
          <HandBackNote redirectUri={redirectUri} />
          <BudgetAndBacking agent={agent} operator={auth.address!} />
        </Section>
      )}
      {!noAgents && setup}
      <Button variant="link" disabled={busy} onClick={() => void decide(false)}>
        Deny connection
      </Button>
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}

/**
 * The budget and backing an agent can be given before connecting. An agent that hires needs SIDE backing before it can
 * post, so that is said first and its backing is not called optional; the weekly budget always is.
 */
function BudgetAndBacking({ agent, operator }: { agent: ManagedAgent; operator: Address }) {
  const hiring = (agent.roles ?? []).includes('hire')
  return (
    <>
      {hiring ? (
        <>
          <NeedsBacking wallet={agent.address === null ? undefined : getAddress(agent.address)} />
          <p className="text-sm text-muted-foreground">A weekly budget can be added later.</p>
          <details>
            <summary className="cursor-pointer text-sm font-semibold">Optional weekly budget</summary>
            <div className="pt-3">
              <AllowanceEditor agent={agent} onConfirmed={() => undefined} />
            </div>
          </details>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">SIDE backing can be added later.</p>
      )}
      <details>
        <summary className="cursor-pointer text-sm font-semibold">
          {hiring ? 'SIDE backing, needed to post' : 'Optional SIDE backing'}
        </summary>
        <div className="pt-3">
          <AgentStake agent={agent} operator={operator} />
        </div>
      </details>
    </>
  )
}
