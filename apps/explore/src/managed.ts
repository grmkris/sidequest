/**
 * The operator's managed agents and the decisions they wait on, shared by the sidebar, My agents and each agent's
 * page. Same query keys as before, so every view reads one cache. Only a signed-in operator has any; the server
 * scopes both lists to the session's operator.
 */
import { managedKey } from './queries.ts'
import { type UseQueryResult, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { type AgentLiveness, agentStatus } from './agent-orb.ts'
import { agentEndpoint, type ManagedAgent } from './api.ts'
import type { AgentApproval } from './agent-api.ts'
import { type LinkTarget, boardRoutes } from './components/BoardLink.tsx'
import { useAuth } from './components/Wallet.tsx'
import { writesOpen } from './wallet.ts'

/** The operator's private records: shown only while the board session is live, forgotten once it is not. */
const PRIVATE = [['managed-agents'], ['managed-approvals'], ['managed-agent-status']] as const

/**
 * A disabled query keeps its last data, so a signed-out or expired session would still show the operator's agents and
 * decisions. Without a live session there is no data, and the cached copies are dropped (VV2-014).
 */
function usePrivate<T>(query: UseQueryResult<T>, live: boolean): UseQueryResult<T> {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!live) for (const queryKey of PRIVATE) queryClient.removeQueries({ queryKey })
  }, [live, queryClient])
  return live ? query : ({ ...query, data: undefined } as UseQueryResult<T>)
}

export function useManagedAgents() {
  const auth = useAuth()
  const query = useQuery({
    queryKey: managedKey('managed-agents', auth.address, auth.signedIn),
    queryFn: () => agentEndpoint<{ agents: ManagedAgent[] }>('/api/agents'),
    // Before a network's launch there are no managed agents to read.
    enabled: auth.signedIn && writesOpen,
    refetchInterval: 15_000,
  })
  return usePrivate(query, auth.signedIn && writesOpen)
}

export function useManagedApprovals() {
  const auth = useAuth()
  const query = useQuery({
    queryKey: managedKey('managed-approvals', auth.address, auth.signedIn),
    queryFn: () => agentEndpoint<{ approvals: AgentApproval[] }>('/api/approvals'),
    // Before a network's launch there are no managed agents to read.
    enabled: auth.signedIn && writesOpen,
    refetchInterval: 15_000,
  })
  return usePrivate(query, auth.signedIn && writesOpen)
}

/** Decisions still waiting, per managed agent (its server id). The list holds every status; only `pending` waits. */
export function pendingByAgent(approvals: readonly Pick<AgentApproval, 'agent_id' | 'status'>[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const approval of approvals)
    if (approval.status === 'pending') out.set(approval.agent_id, (out.get(approval.agent_id) ?? 0) + 1)
  return out
}

/** The managed agent behind a public agent number, when the signed-in operator runs it. */
export function ownedAgent(agents: readonly ManagedAgent[] | undefined, agentId: string): ManagedAgent | undefined {
  return agents?.find((agent) => agent.agent_id !== null && String(agent.agent_id) === agentId)
}

/**
 * The operator's own agent behind a public number, only from a list the board has just confirmed: a failed read (an
 * expired or revoked session) keeps React Query's last data, which is no longer authority (VV2-014).
 */
export function ownerOf(
  query: { isSuccess: boolean; data?: { agents: ManagedAgent[] } | undefined },
  agentId: string,
): ManagedAgent | undefined {
  return query.isSuccess ? ownedAgent(query.data?.agents, agentId) : undefined
}

export const useOwnedAgent = (agentId: string) => ownerOf(useManagedAgents(), agentId)

/** Where a managed agent lives: its page on this board once it has an Agent ID, its resumed setup until then. */
export const agentHome = (agent: Pick<ManagedAgent, 'id' | 'agent_id'>, routes = boardRoutes()): LinkTarget =>
  agent.agent_id === null ? { to: '/agents/new', search: { resume: agent.id } } : routes.agent(String(agent.agent_id))

/** A managed agent's orb: live within ten minutes of its last MCP call, otherwise idle. */
export const managedLiveness = (agent: Pick<ManagedAgent, 'last_activity_at'>, now: number): AgentLiveness =>
  agentStatus({ working: false, lastMcpCallAt: agent.last_activity_at, now })
