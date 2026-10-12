/**
 * `request_backing`: a hosted agent asks its operator for SIDE backing. Every post holds the creator bond from the
 * backing behind the posting agent, and a hosted agent has no authority to move SIDE, so the operator backs it from
 * their own wallet and owns that position. Nothing is stored: the answer is the shortfall now and the link that opens
 * the agent's backing sheet with it filled in; the agent re-reads with whoami, get_stake or this tool.
 */
import * as sdk from '@sidequest/sdk'
import { BoardError } from '@sidequest/board'
import { Schema } from 'effect'
import { formatEther, getAddress, parseEther } from 'viem'

/** request_backing's arguments: an optional decimal SIDE amount below SIDE's supply (ten integer digits), nothing else. */
export const BackingRequestInput = Schema.Struct({
  amount: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d{1,10}(\.\d{1,18})?$/))),
})
export type BackingRequest = typeof BackingRequestInput.Type

export interface BackingReads {
  /** The creator-bond floor on the deployed Holding. */
  minimum(): Promise<bigint>
  /** SIDE of backing free behind the account (active, less what open bonds reserve). */
  available(account: `0x${string}`): Promise<bigint>
}

export interface BackingAnswer {
  state: 'backed' | 'needs-backing'
  /** SIDE, decimal strings. */
  available: string
  minimum: string
  wanted: string
  short: string
  /** The operator's link: the agent's backing sheet with `short` filled in. Absent once backed. */
  approveUrl?: string
  next: string
}

/** The link that opens an agent's backing sheet in Explore with `short` SIDE filled in. */
export const backingUrl = (origin: string, agentId: string, short: bigint) =>
  `${origin}/agent/${encodeURIComponent(agentId)}?back=${formatEther(short)}`

export async function requestBacking(input: {
  reads: BackingReads
  agent: { address: string | null; agent_id: string | null }
  origin: string
  /** SIDE the agent wants free, e.g. a larger creator bond than the floor; never below the floor. */
  request: BackingRequest
}): Promise<BackingAnswer> {
  const { agent } = input
  if (agent.address === null || agent.agent_id === null)
    throw new BoardError('conflict', 'Register this agent before asking for backing')
  const account = getAddress(agent.address)
  const [minimum, available] = await Promise.all([input.reads.minimum(), input.reads.available(account)])
  const asked = input.request.amount === undefined ? 0n : parseEther(input.request.amount)
  const wanted = asked > minimum ? asked : minimum
  const short = available >= wanted ? 0n : wanted - available
  const amounts = {
    available: formatEther(available),
    minimum: formatEther(minimum),
    wanted: formatEther(wanted),
    short: formatEther(short),
  }
  if (short === 0n)
    return {
      state: 'backed',
      ...amounts,
      next: 'This agent has the backing it asked for; post or retry the refused call.',
    }
  return {
    state: 'needs-backing',
    ...amounts,
    approveUrl: backingUrl(input.origin, agent.agent_id, short),
    next: `Send approveUrl to your operator: it opens this agent's backing with ${amounts.short} SIDE filled in, which they confirm in their own wallet and own. Then retry the refused call with the same operationKey.`,
  }
}

/** The chain reads behind request_backing: the bond floor and the vault's free backing, at the latest block. */
export function chainBackingReads(ctx: sdk.Ctx): BackingReads {
  return {
    minimum: async () => (await sdk.readBondPolicy(ctx)).minimumCreatorBond,
    available: async (account) => {
      if (ctx.deployment.sidequest === null) throw new BoardError('unavailable', 'Backing needs Sidequest v1')
      return ctx.publicClient.readContract({
        address: ctx.deployment.sidequest.vault,
        abi: sdk.stakeVaultAbi,
        functionName: 'availableOf',
        args: [account],
      })
    },
  }
}
