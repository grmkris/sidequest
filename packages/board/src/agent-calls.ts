/** Application scope checks for each flat call signed by the hosted account. */
import * as sdk from '@sidequest/sdk'
import {
  type Address,
  type Hex,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  toFunctionSelector,
} from 'viem'
import { checkGrantCall } from './grant-calls.ts'
import { decodeGrantBatch } from './hire-batch.ts'
import type { GrantStore } from './grants.ts'

export const agentSweepAbi = parseAbi(['function sweep(address token,uint256 agentId,uint256 amount)'])
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const REDEEM = toFunctionSelector('redeemDelegations(bytes[],bytes32[],bytes[])')
export interface AgentCallScope {
  readonly context: sdk.GrantContext
  readonly grants: GrantStore
  readonly agent: { readonly address: Address; readonly operator: Address; readonly agent_id: string | null }
  readonly operationId: Hex
  readonly now: number
  readonly agentSweep?: Address | null
  /** Exact attestation call frozen by the evidence preparation, never supplied by the MCP caller. */
  readonly evidenceCall?: sdk.Call
}

function routine(scope: AgentCallScope, call: sdk.Call) {
  return checkGrantCall(
    scope.context,
    { kind: 'agent-work', delegator: scope.agent.address, start: scope.now, salt: 0n },
    { to: call.to, data: call.data, value: call.value.toString() },
  )
}

function approval(scope: AgentCallScope, call: sdk.Call): string {
  const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data })
  if (decoded.functionName !== 'approve') throw new Error('Only bounded approvals are allowed')
  const [spender, amount] = decoded.args
  const encoded = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] })
  if (!same(encoded, call.data)) throw new Error('Noncanonical approval calldata')
  const { aa } = scope.context.deployment
  if (
    aa?.paymaster !== null &&
    aa?.paymaster !== undefined &&
    same(spender, aa.paymaster) &&
    same(call.to, aa.gasToken)
  ) {
    if (amount > aa.standingApproval) throw new Error('Gas approval exceeds the standing cap')
    return 'gas-approve'
  }
  if (!same(spender, scope.context.stack.holding)) throw new Error('Approval spender is outside agent policy')
  return 'approve'
}

function sweep(scope: AgentCallScope, call: sdk.Call): string {
  const decoded = decodeFunctionData({ abi: agentSweepAbi, data: call.data })
  const [token, agentId, amount] = decoded.args
  if (agentId.toString() !== scope.agent.agent_id) throw new Error('Sweep requires this agent ID')
  const d = scope.context.deployment
  if (![...d.rewardTokens, d.factory, ...(d.aa === null ? [] : [d.aa.gasToken])].some((item) => same(item, token)))
    throw new Error('Sweep token is outside agent policy')
  if (
    !same(encodeFunctionData({ abi: agentSweepAbi, functionName: 'sweep', args: [token, agentId, amount] }), call.data)
  )
    throw new Error('Noncanonical sweep calldata')
  return 'sweep'
}

function redemption(scope: AgentCallScope, call: sdk.Call): string {
  const entries = decodeGrantBatch(call.data)
  if (entries.length !== 1) throw new Error('A hosted redemption requires one execution')
  const { grant, execution } = entries[0]!
  const hash = sdk.delegationHash(grant)
  const row = scope.grants.get(hash)
  if (
    row?.status !== 'live' ||
    row.signature === null ||
    row.expires_at <= scope.now ||
    !same(row.owner, scope.agent.operator)
  )
    throw new Error('Redemption requires this agent live grant')
  const spec = scope.grants.spec(hash)
  const signed = scope.grants.signed(hash)
  sdk.assertGrant(scope.context, spec, grant)
  if (
    spec.start > scope.now ||
    !same(grant.delegator, scope.agent.operator) ||
    !same(grant.delegate, scope.agent.address) ||
    !same(grant.signature, signed.signature) ||
    execution.value !== 0n
  )
    throw new Error('Redemption requires this operator and agent with zero value')
  if (spec.kind === 'permission') {
    sdk.checkPermissionExecution(spec, execution)
    if (spec.terms.type === 'sidequest:contract-call') {
      routine(scope, { to: execution.target, data: execution.callData, value: execution.value })
      return 'permission'
    }
  } else if (spec.kind !== 'allowance' && spec.kind !== 'allowance-once') {
    throw new Error('Redemption grant kind is outside agent policy')
  }
  const decoded = decodeFunctionData({ abi: erc20Abi, data: execution.callData })
  if (decoded.functionName !== 'transfer' || !same(decoded.args[0], scope.agent.address))
    throw new Error('Redemption must pay this agent')
  if (spec.kind !== 'permission')
    checkGrantCall(scope.context, spec, { to: execution.target, data: execution.callData, value: '0' })
  return spec.kind === 'permission' ? 'permission' : 'reward-pull'
}

/** Every method is bound to the configured contract; direct native value and naked token transfers are refused. */
export function checkAgentCall(scope: AgentCallScope, call: sdk.Call): string {
  if (call.value !== 0n || call.data.length > 32770)
    throw new Error('Agent calls require zero value and bounded calldata')
  if (same(call.data.slice(0, 10), '0x095ea7b3')) return approval(scope, call)
  if (scope.agentSweep !== null && scope.agentSweep !== undefined && same(call.to, scope.agentSweep))
    return sweep(scope, call)
  if (same(call.to, scope.context.deployment.delegation.manager) && same(call.data.slice(0, 10), REDEEM))
    return redemption(scope, call)
  if (
    scope.evidenceCall !== undefined &&
    same(call.to, scope.evidenceCall.to) &&
    same(call.data, scope.evidenceCall.data)
  )
    return 'evidence'
  const vault = scope.context.deployment.sidequest?.vault
  if (vault !== undefined && same(call.to, vault)) {
    const decoded = decodeFunctionData({ abi: sdk.stakeVaultAbi, data: call.data })
    if (decoded.functionName === 'requestUndelegate') {
      const spec: sdk.GrantSpec = {
        kind: 'unstake',
        delegator: scope.agent.address,
        shares: decoded.args[1],
        operationId: scope.operationId,
        start: scope.now,
        salt: 0n,
      }
      scope.grants.approvedUnstake(scope.agent.operator, spec)
      return checkGrantCall(scope.context, spec, { to: call.to, data: call.data, value: '0' }).method
    }
  }
  return routine(scope, call).method
}

function checkHire(scope: AgentCallScope, calls: readonly sdk.Call[], index: number): void {
  const publish = calls[index]!
  const checked = decodeFunctionData({ abi: sdk.sidequestHoldingAbi, data: publish.data })
  if (checked.functionName !== 'publish') throw new Error('Expected publish')
  const params = checked.args[0]
  const approve = calls[index - 1]
  const pull = calls[index - 2]
  if (approve === undefined || pull === undefined || checkAgentCall(scope, pull) !== 'reward-pull')
    throw new Error('Publish requires the atomic allowance, approval and publish triple')
  if (
    !same(approve.to, params.token) ||
    !same(approve.data, sdk.approveCall(params.token, scope.context.stack.holding, params.reward).data)
  )
    throw new Error('Holding approval must equal this hire reward')
  const nested = decodeGrantBatch(pull.data)[0]!
  const transfer = decodeFunctionData({ abi: erc20Abi, data: nested.execution.callData })
  if (
    transfer.functionName !== 'transfer' ||
    transfer.args[1] !== params.reward ||
    !same(nested.execution.target, params.token)
  )
    throw new Error('Reward pull must equal this hire reward and token')
  if (scope.context.deployment.rewardTokens.some((token) => same(token, params.token))) return
  const spec = scope.grants.spec(sdk.delegationHash(nested.grant))
  if (spec.kind !== 'allowance-once') throw new Error('Unknown token hire requires an exact operator allowance')
  scope.grants.approvedHire(
    scope.agent.operator,
    {
      kind: 'agent-approve-once',
      delegator: scope.agent.address,
      token: params.token,
      amount: params.reward,
      operationId: scope.operationId,
      salt: 0n,
      start: spec.start,
    },
    publish.data,
  )
}

export function checkAgentBatch(scope: AgentCallScope, calls: readonly sdk.Call[]): void {
  if (calls.length === 0 || calls.length > 16) throw new Error('Agent batch requires 1-16 calls')
  const methods = calls.map((call) => checkAgentCall(scope, call))
  methods.forEach((method, index) => {
    if (method === 'approve' && methods[index + 1] !== 'publish') throw new Error('Holding approval requires a hire')
    if (method === 'reward-pull' && methods[index + 2] !== 'publish')
      throw new Error('Reward allowance requires a hire')
    if (method === 'publish') checkHire(scope, calls, index)
    if (method === 'permission' && methods.filter((item) => item !== 'gas-approve').length !== 1)
      throw new Error('Permission redemption must be the only action')
  })
}
