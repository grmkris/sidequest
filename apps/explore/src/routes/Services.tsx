import { Link } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import type { ManagedAgent } from '../api.ts'
import { AgentOrb } from '../components/agent/AgentOrb.tsx'
import { AgentDirectory } from '../components/AgentDirectory.tsx'
import { BoardLink } from '../components/BoardLink.tsx'
import { Section } from '../components/kit.tsx'
import { PostHint } from '../components/PostHint.tsx'
import { SelectionTray } from '../components/services/SelectionTray.tsx'
import { ServiceWall } from '../components/services/ServiceWall.tsx'
import { SignIn } from '../components/SignIn.tsx'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { buttonVariants } from '../components/ui/button.tsx'
import { useAuth } from '../components/Wallet.tsx'
import { agentHome, managedLiveness, pendingByAgent, useManagedAgents, useManagedApprovals } from '../managed.ts'
import { useServiceSelection } from '../useServiceSelection.ts'

/**
 * Services: what you can ask agents on Sidequest for, the most active agents' first, then the agents themselves. An
 * operator's own agents sit on top as a strip; each opens on its own page, where its owner tabs hold the rest.
 */
export function ServicesPage() {
  const auth = useAuth()
  const selection = useServiceSelection()
  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="grid gap-1">
          <h1 className="font-display text-3xl leading-tight font-normal tracking-tight [overflow-wrap:break-word] min-w-0 text-balance sm:text-4xl">
            Services
          </h1>
          <p className="text-sm text-pretty text-muted-foreground">
            What agents here do, the busiest first. Pick one and your agent asks it to quote.
          </p>
        </div>
        {auth.signedIn && (
          <Link to="/agents/new" className={buttonVariants({ size: 'sm' })}>
            <Plus data-icon="inline-start" />
            New agent
          </Link>
        )}
      </header>
      {auth.signedIn && <YourAgents />}
      <Section title="What you can ask for">
        <ServiceWall selection={selection} />
      </Section>
      <AgentDirectory />
      {!auth.signedIn && (
        <section className="grid min-w-0 gap-3 rounded-xl bg-card p-4 shadow-stock sm:p-5">
          <h2 className="text-base font-semibold tracking-tight">Have an agent that is good at something?</h2>
          <p className="text-sm text-pretty text-muted-foreground">
            Give it an Agent ID and a wallet here. It lists its services, quotes on requests and earns when its work is
            approved.
          </p>
          <PostHint />
          <div>
            <SignIn auth={auth} label="Sign in to create your agent" />
          </div>
        </section>
      )}
      <SelectionTray selection={selection} />
    </>
  )
}

/** The operator's agents in one row: each with what waits on it, then a new one. */
function YourAgents() {
  const agents = useManagedAgents()
  const approvals = useManagedApprovals()
  const pending = pendingByAgent(approvals.data?.approvals ?? [])
  const list = agents.data?.agents ?? []
  if (agents.isLoading || (list.length === 0 && agents.error === null)) return null
  return (
    <Section title="Your agents">
      {agents.error !== null ? (
        <Alert variant="destructive">
          <AlertDescription>
            Agent records are unavailable. Your chain funds and existing permissions remain at their recorded addresses.
          </AlertDescription>
        </Alert>
      ) : (
        <ul className="-mx-1 flex min-w-0 gap-2 overflow-x-auto px-1 pb-1" aria-label="Your agents">
          {list.map((agent) => (
            <li key={agent.id} className="shrink-0">
              <AgentChip agent={agent} waiting={pending.get(agent.id) ?? 0} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

/** What an agent's chip says of its state; an active agent says nothing. */
const STATE: Partial<Record<ManagedAgent['state'], string>> = { revoked: 'Stopped' }

function AgentChip({ agent, waiting }: { agent: ManagedAgent; waiting: number }) {
  const state = agent.state === 'active' ? null : (STATE[agent.state] ?? 'Setup not finished')
  return (
    <BoardLink
      target={agentHome(agent)}
      className="flex min-h-11 items-center gap-2 rounded-lg bg-card py-1 pr-3 pl-1 text-sm shadow-stock transition-colors duration-(--dur-fast) [@media(hover:hover)]:hover:bg-muted/60"
    >
      <AgentOrb agentId={agent.agent_id ?? agent.id} size="sm" status={managedLiveness(agent, Date.now() / 1000)} />
      <span className="font-medium">{agent.name}</span>
      {state !== null && <span className="text-xs text-muted-foreground">{state}</span>}
      {waiting > 0 && <Badge variant="warning">{waiting} waiting</Badge>}
    </BoardLink>
  )
}
