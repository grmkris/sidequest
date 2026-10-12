/** Select scoped grants, read real allowance availability and compose the atomic hire entries. */
import * as sdk from '@sidequest/sdk'
import { type Address, type Hex, decodeFunctionData, encodeFunctionData, erc20Abi, parseAbi } from 'viem'
import { GrantStore, type GrantRow } from './grants.ts'
import { checkGrantCall, type GrantCall } from './grant-calls.ts'
import type { NamedSponsorEntry } from './sponsor.ts'
import { AgentFailure } from './agent-failure.ts'
import { requireBacking, requireCreatorBond } from './sidequest.ts'

const periodAvailableAbi = parseAbi([
  'function getAvailableAmount(bytes32 hash,address manager,bytes terms) view returns (uint256,bool,uint256)',
])
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()

export interface HireApprovalRequest {
  token: Address
  amount: string
  publish: Hex
  reason: 'unknown-token' | 'allowance-unavailable'
}

export interface ApprovedAgentAction {
  allowanceHash?: Hex
  approvalHash?: Hex
  unstakeHash?: Hex
}

function publishedReward(
  ctx: sdk.GrantContext,
  call: GrantCall,
): { token: Address; reward: bigint; creatorBond: bigint; workerBond: bigint } | undefined {
  if (!same(call.to, ctx.stack.holding)) return undefined
  try {
    const decoded = decodeFunctionData({ abi: sdk.sidequestHoldingAbi, data: call.data as Hex })
    return decoded.functionName === 'publish' ? decoded.args[0] : undefined
  } catch {
    return undefined
  }
}

function executionCall(execution: sdk.Execution): GrantCall {
  return { to: execution.target, data: execution.callData, value: execution.value.toString() }
}

function canonical(ctx: sdk.GrantContext, spec: sdk.GrantSpec, call: GrantCall): GrantCall {
  return executionCall(checkGrantCall(ctx, spec, call).execution)
}

function exactApproval(ctx: sdk.GrantContext, call: GrantCall, token: Address, amount: bigint): boolean {
  const expected = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ctx.stack.holding, amount] })
  return (
    same(call.to, token) &&
    same(call.data, expected) &&
    (call.value ?? '0') === '0' &&
    (call.chainId === undefined || call.chainId === ctx.deployment.chainId)
  )
}

export async function allowanceAvailable(ctx: sdk.Ctx, grants: GrantStore, row: GrantRow): Promise<bigint> {
  const spec = grants.spec(row.delegation_hash)
  if (row.status !== 'live' || row.signature === null || (await sdk.isDisabled(ctx, row.delegation_hash))) return 0n
  if (spec.kind === 'allowance-once') return (await sdk.callsMade(ctx, row.delegation_hash)) === 0n ? spec.amount : 0n
  if (spec.kind !== 'allowance' && spec.kind !== 'gas-allowance') return 0n
  const caveat = grants
    .signed(row.delegation_hash)
    .caveats.find((item) => same(item.enforcer, ctx.deployment.delegation.enforcers.erc20PeriodTransfer))
  if (caveat === undefined) throw new Error('Allowance is missing its period caveat')
  const [available] = await ctx.publicClient.readContract({
    address: ctx.deployment.delegation.enforcers.erc20PeriodTransfer,
    abi: periodAvailableAbi,
    functionName: 'getAvailableAmount',
    args: [row.delegation_hash, ctx.deployment.delegation.manager, caveat.terms],
  })
  return available
}

/**
 * The most one live weekly-budget grant from its operator could still fund for a hosted agent in a token. A hosted
 * publish draws the whole reward from one such grant (see hireEntries), never from the agent's own wallet.
 */
export async function bestAllowanceAvailable(
  ctx: sdk.Ctx,
  grants: GrantStore,
  agent: { address: Address; operator: Address },
  token: Address,
  now: number,
): Promise<bigint> {
  let best = 0n
  for (const row of liveGrants(grants, agent.operator, agent.operator, now)) {
    if (!same(row.delegate, agent.address)) continue
    const spec = grants.spec(row.delegation_hash)
    if (
      spec.kind !== 'allowance' ||
      !same(spec.delegator, agent.operator) ||
      !same(spec.agent, agent.address) ||
      !same(spec.token, token)
    )
      continue
    const available = await allowanceAvailable(ctx, grants, row)
    if (available > best) best = available
  }
  return best
}

function liveGrants(grants: GrantStore, wallet: Address, operator: Address, now: number): GrantRow[] {
  return grants.list(wallet).filter((row) => row.status === 'live' && row.expires_at > now && same(row.owner, operator))
}

function oneGrant(rows: readonly GrantRow[], kind: sdk.GrantKind, hash?: Hex): GrantRow {
  const row =
    hash === undefined
      ? rows.find((item) => item.kind === kind)
      : rows.find((item) => item.kind === kind && same(item.delegation_hash, hash))
  if (row === undefined)
    throw new AgentFailure(
      'unavailable',
      `No live ${kind} grant covers this agent action; it renews on retry`,
      'grant-missing',
      'same-key',
      60,
    )
  return row
}

async function hireEntries(
  ctx: sdk.Ctx,
  grants: GrantStore,
  agent: { address: Address; operator: Address },
  rows: readonly GrantRow[],
  call: GrantCall,
  approved: ApprovedAgentAction,
  now: number,
): Promise<{ entries: NamedSponsorEntry[]; approval?: HireApprovalRequest }> {
  const publish = publishedReward(ctx, call)!
  await requireCreatorBond(ctx, publish.creatorBond)
  await requireBacking(ctx, agent.address, publish.creatorBond, 'creator')
  const work = oneGrant(rows, 'agent-work')
  const checkedPublish = canonical(ctx, grants.spec(work.delegation_hash), call)
  const known = ctx.deployment.rewardTokens.some((token) => same(token, publish.token))
  if (!known && approved.approvalHash === undefined)
    return {
      entries: [],
      approval: {
        token: publish.token,
        amount: publish.reward.toString(),
        publish: call.data as Hex,
        reason: 'unknown-token',
      },
    }
  const approval =
    approved.approvalHash === undefined
      ? oneGrant(rows, 'agent-approve')
      : oneGrant(rows, 'agent-approve-once', approved.approvalHash)
  const approvalSpec = grants.spec(approval.delegation_hash)
  const approve = canonical(ctx, approvalSpec, {
    to: publish.token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ctx.stack.holding, publish.reward] }),
    value: '0',
  })
  let allowance: GrantRow | undefined
  const candidates = liveGrants(grants, agent.operator, agent.operator, now).filter((row) =>
    same(row.delegate, agent.address),
  )
  for (const row of candidates) {
    const spec = grants.spec(row.delegation_hash)
    if (approved.allowanceHash !== undefined && !same(row.delegation_hash, approved.allowanceHash)) continue
    if (spec.kind !== 'allowance' && spec.kind !== 'allowance-once') continue
    if (approved.allowanceHash === undefined && spec.kind !== 'allowance') continue
    if (!same(spec.delegator, agent.operator) || !same(spec.agent, agent.address) || !same(spec.token, publish.token))
      continue
    if (spec.kind === 'allowance-once' && spec.amount !== publish.reward) continue
    if ((await allowanceAvailable(ctx, grants, row)) >= publish.reward) {
      allowance = row
      break
    }
  }
  if (allowance === undefined)
    return {
      entries: [],
      approval: {
        token: publish.token,
        amount: publish.reward.toString(),
        publish: call.data as Hex,
        reason: 'allowance-unavailable',
      },
    }
  if (approvalSpec.kind === 'agent-approve-once') grants.approvedHire(agent.operator, approvalSpec, call.data as Hex)
  const pull = sdk.redeemCallsCalldata(grants.signed(allowance.delegation_hash), [
    sdk.advanceExecution(publish.token, agent.address, publish.reward),
  ])
  return {
    entries: [
      {
        grant: work.delegation_hash,
        calls: [
          canonical(ctx, grants.spec(work.delegation_hash), {
            to: ctx.deployment.delegation.manager,
            data: pull,
            value: '0',
          }),
        ],
      },
      { grant: approval.delegation_hash, calls: [approve] },
      { grant: work.delegation_hash, calls: [checkedPublish] },
    ],
  }
}

/** A publish always receives pull + approve + publish, even when the board omitted an already-sufficient ERC20 approval. */
export async function mapAgentCalls(
  ctx: sdk.Ctx,
  grants: GrantStore,
  agent: { address: Address; operator: Address },
  calls: readonly GrantCall[],
  now: number,
  approved: ApprovedAgentAction = {},
): Promise<{ entries: NamedSponsorEntry[]; approval?: HireApprovalRequest }> {
  const rows = liveGrants(grants, agent.address, agent.operator, now)
  const entries: NamedSponsorEntry[] = []
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index]!
    const next = calls[index + 1]
    const nextPublish = next === undefined ? undefined : publishedReward(ctx, next)
    if (nextPublish !== undefined && exactApproval(ctx, call, nextPublish.token, nextPublish.reward)) continue
    if (publishedReward(ctx, call) !== undefined) {
      const hire = await hireEntries(ctx, grants, agent, rows, call, approved, now)
      if (hire.approval !== undefined) return hire
      entries.push(...hire.entries)
      continue
    }
    const kinds: sdk.GrantKind[] = approved.unstakeHash === undefined ? ['agent-work', 'agent-sweep'] : ['unstake']
    let matched: NamedSponsorEntry | undefined
    for (const kind of kinds) {
      const row = rows.find(
        (item) => item.kind === kind && (kind !== 'unstake' || item.delegation_hash === approved.unstakeHash),
      )
      if (row === undefined) continue
      try {
        matched = { grant: row.delegation_hash, calls: [canonical(ctx, grants.spec(row.delegation_hash), call)] }
        break
      } catch {
        // Try only the other explicit routine template; no fallback broadens authority.
      }
    }
    if (matched === undefined)
      throw new AgentFailure(
        'forbidden',
        'Call is outside this agent action and grant policy',
        'outside-policy',
        'none',
      )
    entries.push(matched)
  }
  if (entries.length === 0 || entries.length > 8)
    throw new AgentFailure('invalid', 'Agent action requires 1-8 sponsored entries', 'batch-size', 'none')
  return { entries }
}
