/** The deployed staking context shared by Explore's SDK reads and transaction preparation. */
import type { Ctx } from '@sidequest/sdk'
import { createPublicClient, http } from 'viem'
import { type SidequestContracts, sidequest } from './sidequest.ts'
import { chain, deployment } from './wallet.ts'

// Stake cards issue several independent reads in the same tick (pool, position,
// schedule and policy). Multicall3 turns that group into one eth_call while
// preserving the caller-supplied block number for a consistent snapshot.
const publicClient = createPublicClient({ chain, batch: { multicall: true }, transport: http() })

export function stakeContext(contracts: SidequestContracts = sidequest): Ctx {
  return {
    publicClient,
    deployment: { ...deployment, sidequest: { ...deployment.sidequest, ...contracts } },
    stack: deployment.stacks.main,
  }
}
