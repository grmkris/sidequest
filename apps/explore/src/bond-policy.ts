/**
 * The creator-bond floor and how far an agent is from it. Every post holds at least `minimumCreatorBond` of SIDE
 * backing behind the posting agent (10 SIDE on testnet, 10,000 on mainnet), read from the deployed Holding, never
 * written down here.
 */
import * as sdk from '@sidequest/sdk'
import { useQuery } from '@tanstack/react-query'
import { stakeContext } from './stake-context.ts'
import { deployed, deployment } from './wallet.ts'

/** The deployed bond policy; it changes only with a redeploy, so it is read rarely. */
export function useBondPolicy() {
  return useQuery({
    queryKey: ['bond-policy', deployment.stacks.main.holding],
    queryFn: () => sdk.readBondPolicy(stakeContext()),
    enabled: deployed,
    staleTime: 10 * 60_000,
    retry: false,
  })
}

export interface PostingReadiness {
  minimum: bigint
  available: bigint
  /** SIDE still to add before the agent can post; zero once it can. */
  short: bigint
  ready: boolean
}

/** Whether `available` backing covers the bond floor, and by how much it falls short. */
export function postingReadiness(available: bigint, minimum: bigint): PostingReadiness {
  const short = available >= minimum ? 0n : minimum - available
  return { minimum, available, short, ready: short === 0n }
}
