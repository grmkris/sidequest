/** Flat account calls: operator funding is redeemed by the agent, and work runs from its own account. */
import * as sdk from '@sidequest/sdk'
import {
  type Address,
  type Hex,
  decodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  isHex,
  encodeFunctionData,
} from 'viem'
import { type ApprovedAgentAction, type HireApprovalRequest, allowanceAvailable } from './agent-call-mapper.ts'
import { type AgentCallScope, agentSweepAbi, checkAgentBatch } from './agent-calls.ts'
import { AgentFailure } from './agent-failure.ts'
import type { GrantRow } from './grants.ts'
import { requireBacking, requireCreatorBond } from './sidequest.ts'

export interface AgentBatchScope extends AgentCallScope {
  readonly context: sdk.Ctx
}
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()

function liveOperatorGrants(scope: AgentBatchScope): GrantRow[] {
  return scope.grants
    .list(scope.agent.operator)
    .filter(
      (row) =>
        row.status === 'live' &&
        row.signature !== null &&
        row.expires_at > scope.now &&
        same(row.owner, scope.agent.operator) &&
        same(row.delegate, scope.agent.address),
    )
}

function redemption(scope: AgentBatchScope, row: GrantRow, token: Address, amount: bigint): sdk.Call {
  return {
    to: scope.context.deployment.delegation.manager,
    value: 0n,
    data: sdk.redeemCallsCalldata(scope.grants.signed(row.delegation_hash), [
      sdk.advanceExecution(token, scope.agent.address, amount),
    ]),
  }
}

function flatCall(scope: AgentBatchScope, tx: sdk.TxRequest): sdk.Call {
  if (
    !isAddress(tx.to) ||
    !isHex(tx.data) ||
    (tx.value ?? '0') !== '0' ||
    (tx.chainId !== undefined && tx.chainId !== scope.context.deployment.chainId)
  )
    throw new AgentFailure('forbidden', 'Call is outside this agent chain and value policy', 'outside-policy', 'none')
  return { to: getAddress(tx.to), data: tx.data, value: 0n }
}

function publishParams(scope: AgentBatchScope, call: sdk.Call) {
  if (!same(call.to, scope.context.stack.holding) || call.data.slice(0, 10) !== sdkPublishSelector()) return undefined
  const decoded = decodeFunctionData({ abi: sdk.sidequestHoldingAbi, data: call.data })
  return decoded.functionName === 'publish' ? decoded.args[0] : undefined
}

function sdkPublishSelector(): Hex {
  // The configured ABI supplies the selector; no contract address is embedded here.
  const fn = sdk.sidequestHoldingAbi.find((entry) => entry.type === 'function' && entry.name === 'publish')!
  return toFunctionSelector(fn)
}
import { toFunctionSelector } from 'viem'

async function rewardAllowance(scope: AgentBatchScope, token: Address, amount: bigint, approved: ApprovedAgentAction) {
  for (const row of liveOperatorGrants(scope)) {
    const spec = scope.grants.spec(row.delegation_hash)
    if (spec.kind !== 'allowance' && spec.kind !== 'allowance-once') continue
    if (
      approved.allowanceHash === undefined ? spec.kind !== 'allowance' : row.delegation_hash !== approved.allowanceHash
    )
      continue
    if (
      !same(spec.token, token) ||
      spec.start > scope.now ||
      (spec.kind === 'allowance-once' && spec.amount !== amount)
    )
      continue
    if ((await allowanceAvailable(scope.context, scope.grants, row)) >= amount) return row
  }
  return undefined
}

async function hire(scope: AgentBatchScope, call: sdk.Call, approved: ApprovedAgentAction): Promise<AgentBatch> {
  const params = publishParams(scope, call)!
  await requireCreatorBond(scope.context, params.creatorBond)
  await requireBacking(scope.context, scope.agent.address, params.creatorBond, 'creator')
  const known = scope.context.deployment.rewardTokens.some((token) => same(token, params.token))
  const request = { token: params.token, amount: params.reward.toString(), publish: call.data }
  if (!known && approved.approvalHash === undefined)
    return { calls: [], approval: { ...request, reason: 'unknown-token' } }
  if (approved.approvalHash !== undefined) {
    const spec = scope.grants.spec(approved.approvalHash)
    if (
      spec.kind !== 'agent-approve-once' ||
      !same(spec.delegator, scope.agent.address) ||
      spec.operationId !== scope.operationId
    )
      throw new AgentFailure('forbidden', 'Hire approval differs from this operation', 'outside-policy', 'none')
    scope.grants.approvedHire(scope.agent.operator, spec, call.data)
  }
  const allowance = await rewardAllowance(scope, params.token, params.reward, approved)
  if (allowance === undefined) return { calls: [], approval: { ...request, reason: 'allowance-unavailable' } }
  return {
    calls: [
      redemption(scope, allowance, params.token, params.reward),
      sdk.approveCall(params.token, scope.context.stack.holding, params.reward),
      call,
    ],
  }
}

function sweepCalls(scope: AgentBatchScope, call: sdk.Call): readonly sdk.Call[] {
  const sweep = scope.context.deployment.agentSweep
  if (sweep === null || scope.agent.agent_id === null)
    throw new AgentFailure(
      'unavailable',
      'AgentSweep is not configured for this agent',
      'sweep-unavailable',
      'same-key',
    )
  const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data })
  if (decoded.functionName !== 'transfer' || !same(decoded.args[0], scope.agent.operator))
    throw new AgentFailure('forbidden', 'Sweep must pay this agent operator', 'outside-policy', 'none')
  return [
    sdk.approveCall(call.to, sweep, decoded.args[1]),
    {
      to: sweep,
      value: 0n,
      data: encodeFunctionData({
        abi: agentSweepAbi,
        functionName: 'sweep',
        args: [call.to, BigInt(scope.agent.agent_id), decoded.args[1]],
      }),
    },
  ]
}

export interface AgentBatch {
  readonly calls: readonly sdk.Call[]
  readonly approval?: HireApprovalRequest
}

/** Preserve the prepared action, replacing relay envelopes and earnings transfers with account calls. */
export async function buildAgentBatch(
  scope: AgentBatchScope,
  transactions: readonly sdk.TxRequest[],
  approved: ApprovedAgentAction = {},
): Promise<AgentBatch> {
  const input = transactions.map((tx) => flatCall(scope, tx))
  const calls: sdk.Call[] = []
  for (let index = 0; index < input.length; index++) {
    const call = input[index]!
    const next = input[index + 1]
    const nextPublish = next === undefined ? undefined : publishParams(scope, next)
    if (
      nextPublish !== undefined &&
      same(call.to, nextPublish.token) &&
      same(call.data, sdk.approveCall(call.to, scope.context.stack.holding, nextPublish.reward).data)
    )
      continue
    if (publishParams(scope, call) !== undefined) {
      const result = await hire(scope, call, approved)
      if (result.approval !== undefined) return result
      calls.push(...result.calls)
    } else if (call.data.slice(0, 10) === '0xa9059cbb') calls.push(...sweepCalls(scope, call))
    else calls.push(call)
  }
  // Evidence is produced by the board's frozen submit preparation, never by caller-supplied calldata.
  if (scope.evidenceCall !== undefined) calls.push(scope.evidenceCall)
  checkAgentBatch({ ...scope, agentSweep: scope.context.deployment.agentSweep }, calls)
  return { calls }
}

export function gasBudgetRequired(): AgentFailure {
  return new AgentFailure(
    'conflict',
    'Add a gas budget: the operator must sign a live USDC gas allowance for this agent',
    'gas-budget-required',
    'after-operator',
  )
}

/** Even an already funded agent must have a live operator gas budget before new operations. */
export async function requireGasBudget(scope: AgentBatchScope): Promise<void> {
  for (const row of liveOperatorGrants(scope)) {
    const spec = scope.grants.spec(row.delegation_hash)
    if (
      spec.kind === 'gas-allowance' &&
      spec.start <= scope.now &&
      same(spec.token, scope.context.deployment.aa!.gasToken) &&
      !(await sdk.isDisabled(scope.context, row.delegation_hash))
    )
      return
  }
  throw gasBudgetRequired()
}

/**
 * Called by buildUserOp for both its estimate ceiling and its final bound. The float is topped up to twice the
 * per-operation ceiling, not twice this operation's bound: on mainnet the paymaster charged a submit 0.034 USDC while
 * its bound said 0.007, so a float sized from the bound skipped the pull and the charge failed in postOp
 * (`TransferFromFailed`, 14 Oct). Below the full top-up, a smaller pull still serves when it covers twice the bound.
 */
export async function withGasFloat(
  scope: AgentBatchScope,
  calls: readonly sdk.Call[],
  maxCost: bigint,
): Promise<readonly sdk.Call[]> {
  const aa = scope.context.deployment.aa!
  const balance = await scope.context.publicClient.readContract({
    address: aa.gasToken,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [scope.agent.address],
  })
  const floor = 2n * (maxCost > aa.maxCostPerOp ? maxCost : aa.maxCostPerOp)
  if (balance >= floor) return calls
  const want = floor - balance
  const need = 2n * maxCost > balance ? 2n * maxCost - balance : 0n
  for (const row of liveOperatorGrants(scope)) {
    const spec = scope.grants.spec(row.delegation_hash)
    if (spec.kind !== 'gas-allowance' || spec.start > scope.now || !same(spec.token, aa.gasToken)) continue
    const available = await allowanceAvailable(scope.context, scope.grants, row)
    const amount = available < want ? available : want
    if (amount > 0n && amount >= need) return [redemption(scope, row, aa.gasToken, amount), ...calls]
  }
  // No budget left for a top-up, and the bound says the balance covers this operation: send it as before.
  if (need === 0n) return calls
  throw new AgentFailure(
    'conflict',
    'Add to the gas budget: its available USDC does not cover this operation',
    'gas-budget-exhausted',
    'after-operator',
  )
}
