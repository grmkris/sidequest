/** The clients connected as one of the operator's agents, and how each one's access reads (ADR-0021). */
import { useQuery } from '@tanstack/react-query'
import { agentEndpoint } from './api.ts'

type AgentRole = 'work' | 'hire'

export interface AgentConnection {
  id: string
  client: string
  resource: string
  /** What its client signed in for: the most it can do, whatever the agent's roles allow. */
  scopes: string[]
  /** What it may do now: the roles its sign-in covers and the agent holds. */
  roles: AgentRole[]
  createdAt: number
  lastUsedAt: number | null
}

const ROLES = ['work', 'hire'] as const

export function useAgentConnections(agentId: string | undefined) {
  return useQuery({
    queryKey: ['agent-connections', agentId],
    queryFn: () => agentEndpoint<{ connections: AgentConnection[] }>(`/api/agents/${agentId}/connections`),
    enabled: agentId !== undefined,
    refetchInterval: 30_000,
  })
}

const mayWords = (roles: readonly AgentRole[]) => (roles.length === 0 ? 'read only' : `may ${roles.join(' and ')}`)

/** What a connection may do now, and what its sign-in covers when that is more ("may hire · signed in for work and hire"). */
export function connectionWords(connection: Pick<AgentConnection, 'scopes' | 'roles'>): string {
  const signedIn = ROLES.filter((role) => connection.scopes.includes(`sidequest:${role}`))
  const now = ROLES.filter((role) => connection.roles.includes(role))
  return now.length === signedIn.length ? mayWords(now) : `${mayWords(now)} · signed in for ${signedIn.join(' and ')}`
}
