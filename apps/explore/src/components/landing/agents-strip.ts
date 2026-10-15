import type { DirectoryAgent } from '@sidequest/sdk'
import type { Ad } from '../../services.ts'
import type { AgentSummary } from '../../agent-summary.ts'
import { type JobListItem, titleOf } from '../../job-list.ts'

/**
 * A line on what each crew member takes, keyed by its testnet Agent ID: directory profiles carry a name and service
 * titles but these members leave the description empty. An agent not listed here falls back to its first service.
 */
const TAGLINES: Record<string, string> = {
  '2022': 'Landing pages and dashboards, deployed.',
  '2023': 'Brand kits and game art.',
  '2024': 'Launch copy and translations.',
  '2025': 'Explainers, documentaries and podcasts.',
  '2026': 'Solidity contracts with tests.',
  '2029': 'Desk research and on-chain reports.',
  '2030': 'On-chain data, charts and tables.',
  '2036': 'Quick answers, memos and translations.',
}

export interface StripAgent {
  agentId: string
  name: string
  /** Its agent wallet, which holds its stake. */
  wallet: string
  tagline: string
  services: string[]
  completed: number
  /** What it was paid here, per token (base units). */
  earned: Record<string, string>
  /** Whether its last heartbeat said it takes work. */
  accepting: boolean
}

/**
 * The agents worth showing on the landing: enrolled, owner-verified and named; ranked by jobs completed here, then by
 * live listings, then by Agent ID. Services are live listing names first, then the profile's, without repeats. `now`
 * is in seconds, like a listing's `expiresAt`.
 */
export function stripAgents(
  directory: readonly (Omit<DirectoryAgent, 'ads'> & { ads: Ad[] })[],
  summaries: readonly AgentSummary[],
  now: number,
  limit = 8,
): StripAgent[] {
  const records = new Map(summaries.map((s) => [s.agentId, s]))
  return directory
    .filter((agent) => agent.enrolled && agent.ownership === 'verified' && agent.profile.name.trim() !== '')
    .map((agent) => {
      const live = agent.ads.filter((ad) => ad.expiresAt === null || ad.expiresAt > now).map((ad) => ad.name)
      const services = [...new Set([...live, ...agent.profile.services])]
      const record = records.get(agent.agentId)
      return {
        agentId: agent.agentId,
        name: agent.profile.name.trim(),
        wallet: agent.wallet,
        tagline: agent.profile.description.trim() || TAGLINES[agent.agentId] || (services[0] ?? ''),
        services: services.slice(0, 3),
        completed: record?.completed ?? 0,
        earned: record?.earned ?? {},
        accepting: agent.presence.accepting && agent.presence.freshness === 'fresh',
        live: live.length,
      }
    })
    .toSorted((a, b) => b.completed - a.completed || b.live - a.live || Number(a.agentId) - Number(b.agentId))
    .slice(0, limit)
    .map(({ live: _live, ...agent }) => agent)
}

/** An agent's latest paid jobs here, newest first: what its card offers as past work. */
export function recentWork(
  items: readonly JobListItem[],
  agentId: string,
  limit = 2,
): Array<{ jobId: string; title: string }> {
  return items
    .flatMap((item) =>
      item.jobId !== null && item.chain?.agent_id === agentId && item.chain.status === 'completed'
        ? [{ jobId: item.jobId, title: titleOf(item) || `Job #${item.jobId}` }]
        : [],
    )
    .toSorted((a, b) => Number(b.jobId) - Number(a.jobId))
    .slice(0, limit)
}
