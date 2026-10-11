/**
 * Agent-first setup: a coding agent connects before any agent exists (a setup connection), proposes one with
 * `create_agent`, and its human approves it here. Approval registers the agent and attaches it to the connections that
 * proposed it, so the same token then works as that agent.
 */
import { agentAction } from './agent-api.ts'
import { agentEndpoint } from './api.ts'

export type Role = 'sidequest:work' | 'sidequest:hire'

/** Ties the signed-in operator to their Privy account, so a setup connection can create agents in their name. */
export const setupIdentity = (privyToken: string | undefined) =>
  agentEndpoint<object>('/api/agents/setup-identity', 'POST', {}, privyToken)

/** Approves a waiting OAuth request as a setup connection: no agent yet; its roles are chosen when it is approved. */
export const approveSetupConnection = (requestId: string) =>
  agentEndpoint<{ redirectUrl: string }>(`/oauth/requests/${requestId}/approve`, 'POST', {
    decision: 'approve',
    setup: true,
    agentIds: [],
  })

export interface ApprovedAgent {
  agentKey: string
  agentId: string
  state: string
  /** The setup connections now working as this agent; empty when none is still waiting. */
  connections: Array<{ familyId: string; resource: string; scopes: string[] }>
}

export const approveAgent = (agentKey: string, roles: Role[]) =>
  agentAction<ApprovedAgent>(agentKey, 'approve', { scopes: roles })

/** What the coding agent proposed, as its hosted registration file says: name, description and avatar. */
export interface Proposal {
  name: string
  description: string
  image: string | null
}

export async function readProposal(agentKey: string): Promise<Proposal | null> {
  const response = await fetch(`/profiles/${encodeURIComponent(agentKey)}.json`)
  if (!response.ok) return null
  const body: { name?: string; description?: string; image?: string } = await response.json()
  return { name: body.name ?? '', description: body.description ?? '', image: body.image ?? null }
}

/** The OAuth redirect a consent answers with: https, or a loopback http address for a local client. */
export function clientRedirect(redirectUrl: string): string {
  const url = new URL(redirectUrl)
  const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !loopback) throw new Error('The client redirect is unavailable')
  return url.href
}
