import { publicKey } from './queries.ts'
import { useQueries, useQuery } from '@tanstack/react-query'
import { data } from './api.ts'

/** `/data/backing/<wallet>`, as far as a card reads it: SIDE staked behind the agent and by how many backers. */
export interface Backing {
  assets: string
  delegatorCount?: number
}

/** One agent wallet's stake, read once and kept for a couple of minutes; a failed read stays unknown. */
const backingQuery = (wallet: string) => ({
  queryKey: publicKey('agent-backing', wallet.toLowerCase()),
  queryFn: () => data<Backing>(`backing/${wallet}`),
  staleTime: 120_000,
  retry: false,
})

/** Each agent's stake, by wallet, in order: the specialists strip reads them all at once. */
export function useStakes(wallets: readonly string[]): Array<Backing | undefined> {
  return useQueries({
    queries: wallets.map(backingQuery),
    combine: (results) => results.map((result) => result.data),
  })
}

/** One agent's stake, once its wallet is known. */
export function useBacking(wallet: string | undefined): Backing | undefined {
  return useQuery({ ...backingQuery(wallet ?? ''), enabled: wallet !== undefined }).data
}

/** "1 backer", "3 backers"; null with none or while unknown. */
export function backersWord(backing: Backing | undefined): string | null {
  const backers = backing?.delegatorCount ?? 0
  if (backers === 0) return null
  return `${backers} ${backers === 1 ? 'backer' : 'backers'}`
}
