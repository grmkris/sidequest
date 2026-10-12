/** Call and nested funding checks shared by the executor and sponsor desk, before simulation or signing. */
import * as sdk from '@sidequest/sdk'
import {
  type AbiFunction,
  type Address,
  type Hex,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  isAddress,
  toFunctionSelector,
} from 'viem'
import { decodeGrantBatch } from './hire-batch.ts'

export interface GrantCall {
  readonly to: string
  readonly data: string
  readonly value?: string
  readonly chainId?: number
}

export interface CheckedGrantCall {
  readonly execution: sdk.Execution
  readonly method: string
  readonly args: readonly unknown[]
  readonly floor: bigint
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function checkGrantCall(ctx: sdk.GrantContext, spec: sdk.GrantSpec, call: GrantCall): CheckedGrantCall {
  // A permission delegates to its agent, never to the relay; it is only ever redeemed nested (checkPermissionRedemption).
  if (spec.kind === 'permission') throw new Error('Call is outside the grant target and method policy')
  if (!isAddress(call.to) || !/^0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{2})*$/.test(call.data) || call.data.length > 32770)
    throw new Error('Malformed grant call')
  if ((call.value ?? '0') !== '0' || (call.chainId !== undefined && call.chainId !== ctx.deployment.chainId))
    throw new Error('Grant calls must have zero value and use this chain')
  const target = sdk.grantTargets(ctx, spec).find((candidate) => same(candidate.address, call.to))
  const fn = target?.abi.find(
    (item): item is AbiFunction =>
      item.type === 'function' &&
      target.methods.includes(item.name) &&
      same(toFunctionSelector(item), call.data.slice(0, 10)),
  )
  if (target === undefined || fn === undefined) throw new Error('Call is outside the grant target and method policy')
  if (spec.kind === 'registration' && fn.name === 'register' && fn.inputs.length !== 1)
    throw new Error('Registration requires the recorded URI')
  const decoded = decodeFunctionData({ abi: [fn], data: call.data as Hex })
  if (!same(encodeFunctionData({ abi: [fn], functionName: decoded.functionName, args: decoded.args }), call.data))
    throw new Error('Call is not valid canonical calldata')
  const args = decoded.args ?? []
  const pin =
    spec.kind === 'agent-approve' || spec.kind === 'agent-approve-once'
      ? ctx.stack.holding
      : spec.kind === 'agent-sweep'
        ? spec.operator
        : spec.kind === 'allowance' || spec.kind === 'gas-allowance' || spec.kind === 'allowance-once'
          ? spec.agent
          : undefined
  if (pin !== undefined && (typeof args[0] !== 'string' || !same(args[0], pin)))
    throw new Error('Grant spender or recipient mismatch')
  if (spec.kind === 'allowance-once' && args[1] !== spec.amount) throw new Error('One-off allowance amount mismatch')
  if (spec.kind === 'agent-approve-once' && args[1] !== spec.amount) throw new Error('One-off approval amount mismatch')
  if (
    spec.kind === 'unstake' &&
    (typeof args[0] !== 'string' || !same(args[0], spec.delegator) || args[1] !== spec.shares)
  )
    throw new Error('One-off unstake account or shares mismatch')
  if (
    spec.kind === 'agent-work' &&
    ctx.deployment.sidequest !== null &&
    same(target.address, ctx.deployment.sidequest.vault) &&
    (typeof args[0] !== 'string' || !same(args[0], spec.delegator))
  )
    throw new Error('Agent vault calls require the agent own position')
  if (fn.name === 'disableDelegation') {
    const disabled = args[0] as sdk.Delegation
    if (!same(disabled.delegator, spec.delegator)) throw new Error('Cannot disable another wallet delegation')
  }
  const floor =
    fn.name === 'publish'
      ? 1_000_000n
      : fn.name === 'redeemDelegations'
        ? 800_000n
        : fn.name === 'retryDeferred'
          ? sdk.V1_GAS.retryDeferred
          : fn.name === 'settle'
            ? sdk.V1_GAS.settle
            : same(target.address, ctx.stack.evaluator)
              ? sdk.V1_GAS.evaluator
              : 500_000n
  return {
    execution: { target: getAddress(call.to), value: 0n, callData: call.data.toLowerCase() as Hex },
    method: decoded.functionName,
    args,
    floor,
  }
}

/**
 * A permission redeemed by its agent (ADR-0015): exactly the stored, signed operator → agent delegation, one execution
 * inside its terms. The caller has already required the redemption to be the batch's only call.
 */
function checkPermissionRedemption(
  ctx: sdk.GrantContext,
  operator: Address,
  agent: Address,
  nested: { readonly grant: sdk.Delegation; readonly execution: sdk.Execution },
  stored: { readonly spec: sdk.GrantSpec; readonly grant: sdk.Delegation },
): void {
  const spec = stored.spec
  if (
    spec.kind !== 'permission' ||
    !same(spec.delegator, operator) ||
    !same(spec.agent, agent) ||
    !same(nested.grant.delegator, operator) ||
    !same(nested.grant.delegate, agent)
  )
    throw new Error('Nested permission does not match the stored operator grant')
  if (sdk.delegationHash(nested.grant) !== sdk.delegationHash(stored.grant))
    throw new Error('Nested permission does not match the stored operator grant')
  if (nested.grant.signature.toLowerCase() !== stored.grant.signature.toLowerCase())
    throw new Error('Nested permission signature does not match the stored operator grant')
  sdk.assertGrant(ctx, spec, nested.grant)
  sdk.checkPermissionExecution(spec, nested.execution)
}

/**
 * The hosted nested redemptions: a matched allowance/approve/publish triple, or one permission redemption sent alone.
 * `grantFor` resolves a nested delegation to the stored grant for this operator, or throws.
 */
export function checkHireFunding(
  ctx: sdk.GrantContext,
  operator: Address,
  agent: Address,
  calls: readonly { readonly spec: sdk.GrantSpec; readonly checked: CheckedGrantCall }[],
  grantFor: (hash: Hex) => { readonly spec: sdk.GrantSpec; readonly grant: sdk.Delegation },
): number {
  let publishes = 0
  for (let index = 0; index < calls.length; index++) {
    const current = calls[index]!
    if (current.checked.method === 'approve') {
      if (calls[index - 1]?.checked.method !== 'redeemDelegations' || calls[index + 1]?.checked.method !== 'publish')
        throw new Error('Approval requires the atomic hire triple')
    }
    if (current.checked.method === 'publish') {
      if (calls[index - 2]?.checked.method !== 'redeemDelegations' || calls[index - 1]?.checked.method !== 'approve')
        throw new Error('Publish requires the atomic hire triple')
      publishes++
    }
    if (current.checked.method !== 'redeemDelegations') continue
    const inner = decodeGrantBatch(current.checked.execution.callData)
    if (inner.length !== 1) throw new Error('Allowance redemption must contain one transfer')
    const nested = inner[0]!
    const stored = grantFor(sdk.delegationHash(nested.grant))
    if (stored.spec.kind === 'permission') {
      if (calls.length !== 1 || current.spec.kind !== 'agent-work')
        throw new Error('A permission redemption is sent on its own')
      checkPermissionRedemption(ctx, operator, agent, nested, stored)
      continue
    }
    const approval = calls[index + 1],
      publish = calls[index + 2]
    if (
      current.spec.kind !== 'agent-work' ||
      approval === undefined ||
      !['agent-approve', 'agent-approve-once'].includes(approval.spec.kind) ||
      publish?.spec.kind !== 'agent-work' ||
      approval.checked.method !== 'approve' ||
      publish.checked.method !== 'publish'
    )
      throw new Error('Nested allowance requires work, approval and publish entries')
    if (
      !['allowance', 'allowance-once'].includes(stored.spec.kind) ||
      !same(nested.grant.delegator, operator) ||
      !same(nested.grant.delegate, agent) ||
      !same(sdk.delegationHash(nested.grant), sdk.delegationHash(stored.grant))
    )
      throw new Error('Nested allowance does not match the stored operator grant')
    if (nested.grant.signature.toLowerCase() !== stored.grant.signature.toLowerCase())
      throw new Error('Nested allowance signature does not match the stored operator grant')
    if (approval.spec.kind === 'agent-approve-once' && stored.spec.kind !== 'allowance-once')
      throw new Error('One-off approval requires the exact one-off operator allowance')
    sdk.assertGrant(ctx, stored.spec, nested.grant)
    const transfer = checkGrantCall(ctx, stored.spec, {
      to: nested.execution.target,
      data: nested.execution.callData,
      value: nested.execution.value.toString(),
    })
    const params = publish.checked.args[0] as { token: Address; reward: bigint }
    if (
      !same(transfer.execution.target, params.token) ||
      transfer.args[1] !== params.reward ||
      !same(approval.checked.execution.target, params.token) ||
      approval.checked.args[1] !== params.reward
    )
      throw new Error('Allowance pull and approval must equal the published reward and token')
    if (!same(publish.checked.execution.target, ctx.stack.holding)) throw new Error('Publish targets another Holding')
    index += 2
    publishes++
  }
  return publishes
}
