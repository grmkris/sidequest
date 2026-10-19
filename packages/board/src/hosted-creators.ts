/**
 * What the public quote-request list may learn about hosted posters, read where they are kept (the sponsor object):
 * the agent ID behind a wallet, and the most one live weekly-budget grant can still fund in a token. No operator,
 * grant or approval data leaves this function.
 */
import type * as sdk from '@sidequest/sdk'
import { type Address, getAddress } from 'viem'
import { bestAllowanceAvailable } from './agent-call-mapper.ts'
import { AgentStore } from './agents.ts'
import { GrantStore } from './grants.ts'
import type { Sql } from './store.ts'

export interface HostedCreatorQuery {
  readonly addresses: readonly Address[]
  readonly allowances: readonly { readonly address: Address; readonly token: Address }[]
}

export interface HostedCreatorFacts {
  /** Only the queried wallets that are active hosted agents. */
  agents: { address: Address; agentId: string }[]
  /** Only for hosted agents: what one grant could still fund, in base units. */
  allowances: { address: Address; token: Address; available: string }[]
}

export async function hostedCreatorFacts(
  sql: Sql,
  ctx: sdk.Ctx,
  query: HostedCreatorQuery,
  now: number,
): Promise<HostedCreatorFacts> {
  const wallets = [...query.addresses, ...query.allowances.map((a) => a.address)]
  const rows = new AgentStore(sql, () => now).activeByAddress(ctx.deployment.chainId, ctx.deployment.identity, wallets)
  const hosted = (address: Address) => rows.find((r) => r.address.toLowerCase() === address.toLowerCase())
  const grants = new GrantStore(sql, ctx)
  const allowances: HostedCreatorFacts['allowances'] = []
  for (const { address, token } of query.allowances) {
    const agent = hosted(address)
    if (agent === undefined) continue
    const available = await bestAllowanceAvailable(
      ctx,
      grants,
      { address: getAddress(address), operator: getAddress(agent.operator) },
      getAddress(token),
      now,
    )
    allowances.push({ address: getAddress(address), token: getAddress(token), available: available.toString() })
  }
  return { agents: rows.map((r) => ({ address: getAddress(r.address), agentId: r.agent_id })), allowances }
}

/** A hosted agent's wallet and the operator that runs it. */
export interface HostedOperator {
  readonly address: Address
  readonly operator: Address
}

/**
 * Board-internal authorization facts: which of these wallets are active hosted agents, and who operates each. Used
 * only to decide access (an operator reading its agent's applicants, an operator's agents applying to each other's
 * tasks); a board never returns them to a caller. At most 90 wallets.
 */
export function hostedOperatorFacts(
  sql: Sql,
  deployment: Pick<sdk.Deployment, 'chainId' | 'identity'>,
  addresses: readonly Address[],
  now: number,
): HostedOperator[] {
  return new AgentStore(sql, () => now)
    .activeByAddress(deployment.chainId, deployment.identity, addresses)
    .map((r) => ({ address: getAddress(r.address), operator: getAddress(r.operator) }))
}
