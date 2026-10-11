import { type Address, getAddress } from 'viem'
import type { ManagedAgent } from '../../api.ts'
import { useBondPolicy } from '../../bond-policy.ts'
import { useBacking, useDelegations } from '../../delegation-query.ts'
import { useManagedAgents } from '../../managed.ts'
import type { OnboardingFacts } from '../../onboarding.ts'
import { sidequest } from '../../sidequest.ts'
import { useWalletBalances } from '../../wallet-balances.ts'
import { deployed } from '../../wallet.ts'

type ReadyAgent = ManagedAgent & { address: string; agent_id: string }
const ready = (a: ManagedAgent): a is ReadyAgent => a.address !== null && a.agent_id !== null

/** The operator's newest agent that has its wallet and Agent ID: the one Welcome's third step backs. */
export const newestAgent = (agents: readonly ManagedAgent[]) => agents.findLast(ready)

/** An agent without recorded roles keeps the default, work and hire (ADR-0021). */
export const hires = (agent: Pick<ManagedAgent, 'roles'>) => agent.roles === undefined || agent.roles.includes('hire')

/** Whether the operator backs some agent other than their own wallet; null while unknown. */
function backsAnyAgent(positions: ReturnType<typeof useDelegations>['data'], owner: string): boolean | null {
  if (positions === undefined) return null
  return positions.positions.some(
    ({ position }) => position.activeShares > 0n && position.account.toLowerCase() !== owner,
  )
}

/** A hiring agent is backed at the creator-bond floor; any other step-3 agent by any position. Null while unknown. */
export function backedFact(input: {
  agent: ReadyAgent | undefined
  backsAny: boolean | null
  active: bigint | undefined
  minimum: bigint | undefined
}): boolean | null {
  if (input.agent === undefined || !hires(input.agent)) return input.backsAny
  if (input.active === undefined || input.minimum === undefined) return null
  return input.active >= input.minimum
}

/**
 * What the chain and the board say about a signed-in operator's setup: whether the wallet holds anything, whether
 * they have an agent with its Agent ID, and whether they back it. An agent that hires is backed only once its active
 * backing reaches the creator-bond floor, since every post holds that much from it; one that only works is backed
 * by any position (a position in a wallet other than their own).
 */
export function useOnboardingFacts(address: Address): OnboardingFacts {
  const { rows } = useWalletBalances(address)
  const agents = useManagedAgents()
  const positions = useDelegations(sidequest, address, deployed)
  const policy = useBondPolicy()
  const agent = newestAgent(agents.data?.agents ?? [])
  const agentBacking = useBacking(agent === undefined ? undefined : getAddress(agent.address))
  const backsAny = backsAnyAgent(positions.data, address.toLowerCase())
  const backed = backedFact({
    agent,
    backsAny,
    active: agentBacking.data?.backing.active,
    minimum: policy.data?.minimumCreatorBond,
  })
  const holds = rows.some((r) => (r.value ?? 0n) > 0n)
  const reading = rows.some((r) => r.status === 'loading')
  return {
    funded: holds || backsAny === true ? true : reading ? null : false,
    hasAgent: agents.data === undefined ? null : agents.data.agents.some((a) => a.agent_id !== null),
    backed,
  }
}
