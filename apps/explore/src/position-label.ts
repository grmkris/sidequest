import type { DirectoryAgent } from '@sidequest/sdk'
import type { ManagedAgent } from './api.ts'

export interface PositionLabel {
  readonly kind: 'wallet' | 'agent' | 'address'
  readonly name: string
  readonly hint?: string
  readonly agentId?: string
  readonly href?: string
}

export interface PositionLabelSources {
  readonly owner?: string | undefined
  readonly managed?: readonly Pick<ManagedAgent, 'address' | 'agent_id' | 'name'>[] | undefined
  readonly directory?: readonly Pick<DirectoryAgent, 'wallet' | 'agentId' | 'profile'>[] | undefined
  /** Agent IDs returned by `/data/agents?wallet=...`, used only when no local source names the position. */
  readonly walletAgents?: readonly string[] | undefined
}

const same = (left: string | undefined, right: string): boolean =>
  left !== undefined && left.toLowerCase() === right.toLowerCase()

const shortAddress = (account: string): string => `${account.slice(0, 6)}…${account.slice(-4)}`

const agentLabel = (name: string, agentId: string): PositionLabel => ({
  kind: 'agent',
  name: name.trim() || `Agent ID ${agentId}`,
  agentId,
  href: `/agent/${agentId}`,
})

/** Resolves a backing position to the most useful local identity, without performing any reads. */
export function positionLabel(account: string, sources: PositionLabelSources = {}): PositionLabel {
  if (same(sources.owner, account))
    return {
      kind: 'wallet',
      name: 'Your wallet',
      hint: 'Your own stake: deposits for jobs you post',
    }

  const managed = sources.managed?.find((agent) => same(agent.address ?? undefined, account))
  if (managed !== undefined)
    return managed.agent_id === null
      ? { kind: 'agent', name: managed.name.trim() || 'Managed agent', hint: 'Managed agent' }
      : { ...agentLabel(managed.name, managed.agent_id), hint: `Agent ID ${managed.agent_id}` }

  const directory = sources.directory?.find((agent) => same(agent.wallet, account))
  if (directory !== undefined) return agentLabel(directory.profile.name, directory.agentId)

  const agentId = sources.walletAgents?.[0]
  if (agentId !== undefined) return agentLabel('', agentId)

  return { kind: 'address', name: shortAddress(account) }
}
