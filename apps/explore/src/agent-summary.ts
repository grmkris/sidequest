/** Every agent's job record here, from chain facts: jobs, paid, lost, earnings. */
import { publicKey } from './queries.ts'
import { useQuery } from '@tanstack/react-query'
import { data } from './api.ts'
import { amount } from './format.ts'

export interface AgentSummary {
  agentId: string
  jobs: number
  completed: number
  inProgress: number
  lost: number
  earned: Record<string, string>
  feedback: Record<string, number>
  lastBlock: number
}

export const useAgents = () =>
  useQuery({
    queryKey: publicKey('data-agents'),
    queryFn: () => data<{ agents: AgentSummary[] }>('agents'),
    refetchInterval: 30_000,
  })

/** Earnings as "45 mUSD" plus how many other tokens. */
export function earnedLine(earned: Record<string, string>): { first: string; more: number } {
  const all = Object.entries(earned).map(([token, v]) => amount(v, token))
  return { first: all[0] ?? '—', more: Math.max(0, all.length - 1) }
}
