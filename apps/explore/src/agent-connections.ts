/** The clients connected as one of the operator's agents, and how each one's access reads (ADR-0021). */
import { managedKey } from './queries.ts'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from './components/Wallet.tsx'
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
  const auth = useAuth()
  return useQuery({
    queryKey: managedKey('agent-connections', auth.address, auth.signedIn, agentId),
    queryFn: () => agentEndpoint<{ connections: AgentConnection[] }>(`/api/agents/${agentId}/connections`),
    enabled: auth.signedIn && agentId !== undefined,
    refetchInterval: 30_000,
  })
}

/** "Claude Code is connected as Quill.": the clients acting as the agent, each named once. */
export function connectedWords(connections: readonly Pick<AgentConnection, 'client'>[], name: string): string | null {
  const clients = [...new Set(connections.map((connection) => connection.client))]
  const last = clients.pop()
  if (last === undefined) return null
  return clients.length === 0
    ? `${last} is connected as ${name}.`
    : `${clients.join(', ')} and ${last} are connected as ${name}.`
}

const mayWords = (roles: readonly AgentRole[]) => (roles.length === 0 ? 'read only' : `may ${roles.join(' and ')}`)

/** What a connection may do now, and what its sign-in covers when that is more ("may hire · signed in for work and hire"). */
export function connectionWords(connection: Pick<AgentConnection, 'scopes' | 'roles'>): string {
  const signedIn = ROLES.filter((role) => connection.scopes.includes(`sidequest:${role}`))
  const now = ROLES.filter((role) => connection.roles.includes(role))
  return now.length === signedIn.length ? mayWords(now) : `${mayWords(now)} · signed in for ${signedIn.join(' and ')}`
}
