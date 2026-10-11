import { Button } from './ui/button.tsx'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from './ui/empty.tsx'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Section, Select } from './kit.tsx'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { agentEndpoint, type ManagedAgent } from '../api.ts'
import { AgentNew } from '../routes/AgentNew.tsx'
import { AllowanceEditor } from './AllowanceEditor.tsx'
import { AgentStake } from './AgentStake.tsx'

import { useAuth } from './Wallet.tsx'
import { OAuthClient, type OAuthClientIdentity } from './OAuthClient.tsx'
import { SetupConnect } from './SetupConnect.tsx'
import { clientRedirect } from '../agent-setup-api.ts'

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
  const [selected, setSelected] = useState('')
  const [creating, setCreating] = useState(false)
  const [work, setWork] = useState(true)
  const [hire, setHire] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const agent = agents.data?.agents.find((row) => row.id === selected)
  async function decide(approved: boolean) {
    setBusy(true)
    setError(null)
    try {
      // An agent connection never carries setup: that scope only lets a coding agent create one.
      const scopes =
        request.data?.request.scopes.filter((scope) =>
          scope === 'sidequest:work' ? work : scope === 'sidequest:hire' ? hire : scope !== 'sidequest:setup',
        ) ?? []
      const response = await agentEndpoint<{ redirectUrl: string }>(`/oauth/requests/${requestId}/approve`, 'POST', {
        decision: approved ? 'approve' : 'reject',
        agentIds: [selected],
        scopes,
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
          This connection request is unavailable or expired. Restart authentication from your coding client; your saved
          agent remains registered.
        </AlertDescription>
      </Alert>
    )
  const setup =
    request.data?.setup?.available === true ? (
      <SetupConnect requestId={requestId} requested={request.data.request.scopes} />
    ) : null
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
            <option value="">Choose an active agent</option>
            {agents.data?.agents
              .filter((row) => row.state === 'active')
              .map((row) => (
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
            onReady={(created, role) => {
              setSelected(created.id)
              setWork(role !== 'hire')
              setHire(role !== 'work')
              setCreating(false)
              void agents.refetch()
            }}
          />
        )}
      </Section>
      {agent !== undefined && (
        <Section title="Connection permissions">
          <p className="font-semibold">Agent ID {agent.agent_id} is registered</p>
          {request.data?.request.scopes.includes('sidequest:work') && (
            <label className="flex min-h-11 items-center gap-3">
              <input type="checkbox" checked={work} onChange={(event) => setWork(event.target.checked)} />
              <span>
                Work · apply, quote, activate, deliver and dispute; manage stake, earnings, permissions and payments
              </span>
            </label>
          )}
          {request.data?.request.scopes.includes('sidequest:hire') && (
            <label className="flex min-h-11 items-center gap-3">
              <input type="checkbox" checked={hire} onChange={(event) => setHire(event.target.checked)} />
              <span>Hire · post, select, accept and reject</span>
            </label>
          )}
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
          <p className="text-sm text-muted-foreground">Weekly budget and SIDE backing can be added later.</p>
          {hire && request.data?.request.scopes.includes('sidequest:hire') && (
            <details>
              <summary className="cursor-pointer text-sm font-semibold">Optional weekly budget</summary>
              <div className="pt-3">
                <AllowanceEditor agent={agent} onConfirmed={() => undefined} />
              </div>
            </details>
          )}
          <details>
            <summary className="cursor-pointer text-sm font-semibold">Optional SIDE backing</summary>
            <div className="pt-3">
              <AgentStake agent={agent} operator={auth.address!} />
            </div>
          </details>
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
