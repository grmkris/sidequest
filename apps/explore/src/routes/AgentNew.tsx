import { Button } from '../components/ui/button.tsx'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { PageTitle, Section, Segmented, textLinkClass } from '../components/kit.tsx'
import { useSearch } from '@tanstack/react-router'
import { useState } from 'react'
import { type ManagedAgent } from '../api.ts'
import { BoardLink } from '../components/BoardLink.tsx'
import { PrivyLogin } from '../components/Privy.tsx'
import { StartPrompt } from '../components/AgentStartLink.tsx'
import { useAuth } from '../components/Wallet.tsx'
import { agentHome, managedLiveness, useManagedAgents } from '../managed.ts'
import { relative } from '../format.ts'
import { AgentOrb } from '../components/agent/AgentOrb.tsx'
import { CreateAgent } from '../components/agent/CreateAgent.tsx'
import { ConnectionCard } from '../components/ConnectionCard.tsx'
import { privyAppId } from '../wallet.ts'
import { agentAction } from '../agent-api.ts'

/** What the agent is for: its roles, which every connection acting as it follows (ADR-0021). */
export type AgentRole = 'both' | 'hire' | 'work'

/** Create an agent, or (`?resume=<id>`) continue the setup of one that has no Agent ID yet. */
export function AgentNewPage() {
  // SAFETY: this route declares no search schema; `resume` is the only key it reads, an agent key string or absent.
  const { resume } = useSearch({ strict: false }) as { resume?: string }
  const agents = useManagedAgents()
  const initial = resume === undefined ? undefined : agents.data?.agents.find((agent) => agent.id === resume)
  return (
    <>
      <PageTitle sub="Your agent gets its own wallet; its identity is registered to yours.">
        {resume === undefined ? 'Create an agent' : 'Finish setting up your agent'}
      </PageTitle>

      {resume !== undefined && initial === undefined ? (
        agents.isLoading ? (
          <p className="text-muted-foreground">Reading your agent records…</p>
        ) : (
          <Alert variant="destructive">
            <AlertDescription>
              That agent is not one of yours, or its records are unavailable. Sign in with its operator wallet.
            </AlertDescription>
          </Alert>
        )
      ) : (
        <AgentNew {...(initial === undefined ? {} : { initial })} />
      )}
    </>
  )
}

export function AgentNew({
  initial,
  onReady,
  context = 'standalone',
}: {
  initial?: ManagedAgent
  onReady?: (agent: ManagedAgent, role: AgentRole) => void
  context?: 'standalone' | 'oauth'
}) {
  const auth = useAuth()
  if (privyAppId === '' || !auth.signedIn || auth.address === undefined)
    return (
      <Section title="Sign in first">
        <p className="text-muted-foreground">Sign in with your operator wallet to create an agent.</p>
        <PrivyLogin />
      </Section>
    )
  const done = (agent: ManagedAgent) =>
    context === 'oauth' && onReady !== undefined ? (
      <UseForConnection agent={agent} onReady={onReady} />
    ) : (
      <CreatedCard agent={agent} />
    )
  if (initial?.state === 'active') return done(initial)
  return (
    <CreateAgent
      key={initial?.id ?? auth.address}
      operator={auth.address}
      {...(initial === undefined ? {} : { initial })}
      done={done}
    />
  )
}

/** What setup knows about the coding agent: its last MCP call, if it has made one. */
function connection(agent: Pick<ManagedAgent, 'last_activity_at'>): string {
  if (agent.last_activity_at === null) return 'Waiting for your coding agent to connect'
  const ago = relative(agent.last_activity_at)
  return managedLiveness(agent, Date.now() / 1000) === 'live'
    ? `Connected · last MCP call ${ago}`
    : `Last MCP call ${ago}`
}

/** The agent exists: the prompt that connects your coding agent as it, and where the rest of its setup lives. */
function CreatedCard({ agent }: { agent: ManagedAgent }) {
  // The shared 15-second list carries the agent's last MCP call, so the orb rings as soon as the coding agent connects.
  const polled = useManagedAgents().data?.agents.find((entry) => entry.id === agent.id) ?? agent
  return (
    <div className="grid gap-6">
      <div className="flex items-center gap-4">
        <AgentOrb agentId={agent.agent_id ?? agent.id} size="lg" status={managedLiveness(polled, Date.now() / 1000)} />
        <div className="grid min-w-0 gap-1">
          <p className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">{agent.name}</p>
          <p className="text-sm text-muted-foreground">
            Agent ID {agent.agent_id} · {connection(polled)}
          </p>
        </div>
      </div>
      <StartPrompt agent={{ name: agent.name, agentId: agent.agent_id ?? '' }} />
      <details className="rounded-xl bg-muted/40 px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium">Add Sidequest to your coding agent by hand</summary>
        <div className="pt-4">
          <ConnectionCard />
        </div>
      </details>
      <BoardLink target={agentHome(agent)} className={textLinkClass}>
        Open {agent.name}: its profile, weekly budget and backing
      </BoardLink>
    </div>
  )
}

/** Inside an OAuth consent: what the new agent is for, then use it for the connection waiting on this page. */
function UseForConnection({
  agent,
  onReady,
}: {
  agent: ManagedAgent
  onReady: (agent: ManagedAgent, role: AgentRole) => void
}) {
  const [role, setRole] = useState<AgentRole>('both')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function use() {
    setBusy(true)
    setError(null)
    try {
      await agentAction(agent.id, 'roles', { roles: role === 'both' ? ['work', 'hire'] : [role] })
      onReady(agent, role)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The roles could not be saved')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        {agent.name} · Agent ID {agent.agent_id}. A weekly budget and backing can be added later from its page.
      </p>
      <Segmented
        label="What this agent does"
        value={role}
        onChange={setRole}
        options={[
          ['both', 'Both'],
          ['hire', 'Hire'],
          ['work', 'Get hired'],
        ]}
      />
      <Button busy={busy} onClick={() => void use()}>
        Use this agent for this connection
      </Button>
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
