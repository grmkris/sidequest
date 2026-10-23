import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { agentEndpoint, type ManagedAgent } from '../../api.ts'
import { agentAction } from '../../agent-api.ts'
import { connectionWords, useAgentConnections } from '../../agent-connections.ts'
import { relative } from '../../format.ts'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Button } from '../ui/button.tsx'
import { ManageCard } from './ManageCards.tsx'
import { ConfirmButton } from '../Sheet.tsx'
import { WorkloadPolicies } from './WorkloadPolicies.tsx'

type Role = 'work' | 'hire'

const errorText = (failure: unknown, fallback: string) => (failure instanceof Error ? failure.message : fallback)

/**
 * What the agent may do (ADR-0021). Every client connected as it follows at once; turning a role off stops new work of
 * that kind, while jobs it already committed to can still be finished.
 */
function RolesCard({ agent }: { agent: ManagedAgent }) {
  const queries = useQueryClient()
  const held = agent.roles ?? ['work', 'hire']
  const [ticked, setTicked] = useState<Record<Role, boolean>>({
    work: held.includes('work'),
    hire: held.includes('hire'),
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed = (['work', 'hire'] as const).some((role) => ticked[role] !== held.includes(role))
  async function save() {
    setBusy(true)
    setError(null)
    try {
      await agentAction(agent.id, 'roles', { roles: (['work', 'hire'] as const).filter((role) => ticked[role]) })
      // Each connection's access follows the roles at once.
      await Promise.all([
        queries.invalidateQueries({ queryKey: ['managed-agents'] }),
        queries.invalidateQueries({ queryKey: ['agent-connections'] }),
      ])
    } catch (failure) {
      setError(errorText(failure, 'The roles could not be saved'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <ManageCard
      title="What it may do"
      note="Turning a role off stops new work of that kind at once; jobs it already took on or posted can still finish."
    >
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={ticked.work}
          onChange={(event) => setTicked({ ...ticked, work: event.target.checked })}
        />
        Get hired: quote, deliver and earn
      </label>
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={ticked.hire}
          onChange={(event) => setTicked({ ...ticked, hire: event.target.checked })}
        />
        Hire other agents
      </label>
      <Button busy={busy} disabled={!changed} className="justify-self-start" onClick={() => void save()}>
        Save
      </Button>
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </ManageCard>
  )
}

/** Every client connected as this agent, with one Disconnect each; disconnecting ends its access and its events. */
function ConnectionsCard({ agent }: { agent: ManagedAgent }) {
  const connections = useAgentConnections(agent.id)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function disconnect(id: string) {
    setBusy(id)
    setError(null)
    try {
      await agentEndpoint(`/api/agents/${agent.id}/connections/${id}/disconnect`, 'POST')
      await connections.refetch()
    } catch (failure) {
      setError(errorText(failure, 'The connection could not be ended'))
    } finally {
      setBusy(null)
    }
  }
  const rows = connections.data?.connections ?? []
  return (
    <ManageCard title="Connected clients" note="Client names are chosen by each client, so they are not verified.">
      {connections.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading connections…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No coding agent is connected as {agent.name}.</p>
      ) : (
        <ul className="grid gap-3">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-3">
              <div className="grid min-w-0 gap-0.5 text-sm">
                <span className="font-medium [overflow-wrap:anywhere]">{row.client}</span>
                <span className="text-muted-foreground">
                  {connectionWords(row)} · since {relative(row.createdAt)} ·{' '}
                  {row.lastUsedAt === null ? 'not used yet' : `last used ${relative(row.lastUsedAt)}`}
                </span>
              </div>
              <ConfirmButton
                variant="outline"
                size="sm"
                busy={busy === row.id}
                disabled={busy !== null}
                title={`Disconnect ${row.client}?`}
                description={`It stops acting as ${agent.name} at once and hears no more events. To use it again, connect it from the client.`}
                confirm="Disconnect"
                onConfirm={() => void disconnect(row.id)}
              >
                Disconnect
              </ConfirmButton>
            </li>
          ))}
        </ul>
      )}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </ManageCard>
  )
}

/** The agent's access on its Manage tab: its roles, and the clients acting as it. */
export function AccessCards({ agent }: { agent: ManagedAgent }) {
  return (
    <>
      <RolesCard agent={agent} />
      <ConnectionsCard agent={agent} />
      <WorkloadPolicies agent={agent} />
    </>
  )
}
