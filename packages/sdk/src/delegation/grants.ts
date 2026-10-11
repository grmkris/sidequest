/** Spec v2 grants. The same templates are built, checked and described in the browser and backend. */
import {
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  isAddress,
  pad,
  toFunctionSelector,
} from 'viem'
import { coreAbi, sidequestEvaluatorAbi, sidequestHoldingAbi, identityAbi, stakeVaultAbi } from '../abi/index.ts'
import type { Deployment, Stack } from '../deployment.ts'
import { type Caveat, type Delegation, ROOT_AUTHORITY, delegationHash, delegationManagerAbi } from './index.ts'
import { type PermissionTerms, buildPermission } from './permissions.ts'

export type GrantKind =
  | 'operator'
  | 'registration'
  | 'agent-work'
  | 'agent-approve'
  | 'agent-approve-once'
  | 'agent-sweep'
  | 'allowance'
  | 'allowance-once'
  | 'unstake'
  | 'permission'

export interface GrantContext {
  readonly deployment: Deployment
  readonly stack: Stack
}

interface GrantBase {
  readonly delegator: Address
  readonly salt: bigint
  /** Unix seconds: persist this with the prepared grant, never refresh it on retry. */
  readonly start: number
}

export type GrantSpec = GrantBase &
  (
    | { readonly kind: 'operator' }
    | { readonly kind: 'registration' }
    | { readonly kind: 'agent-work' }
    | { readonly kind: 'agent-approve' }
    | {
        readonly kind: 'agent-approve-once'
        readonly token: Address
        readonly amount: bigint
        readonly operationId: Hex
      }
    | { readonly kind: 'unstake'; readonly shares: bigint; readonly operationId: Hex }
    | { readonly kind: 'agent-sweep'; readonly operator: Address }
    | { readonly kind: 'allowance'; readonly agent: Address; readonly token: Address; readonly amount: bigint }
    | { readonly kind: 'allowance-once'; readonly agent: Address; readonly token: Address; readonly amount: bigint }
    /** Permissions on demand (ADR-0015): an operator → agent delegation built by buildPermission. */
    | { readonly kind: 'permission'; readonly agent: Address; readonly expiry: number; readonly terms: PermissionTerms }
  )

export interface GrantTarget {
  readonly address: Address
  readonly abi: Abi
  readonly methods: readonly string[]
}

export const GRANT_CALLS = 100
export const GRANT_VALIDITY = 86400
export const ALLOWANCE_PERIOD = 7 * 86400
export const ALLOWANCE_VALIDITY = 30 * 86400
export const ONE_OFF_VALIDITY = 600

function uint(value: bigint): Hex {
  return encodeAbiParameters([{ type: 'uint256' }], [value])
}

function caveat(enforcer: Address, terms: Hex): Caveat {
  return { enforcer, terms: terms.toLowerCase() as Hex, args: '0x' }
}

function functions(target: GrantTarget): readonly AbiFunction[] {
  const result = target.abi.filter(
    (item): item is AbiFunction => item.type === 'function' && target.methods.includes(item.name),
  )
  if (target.methods.some((name) => !result.some((item) => item.name === name)))
    throw new Error('Grant method missing from ABI')
  return result
}

/** D15, with each method bound to its own target in application validation as well as the on-chain lists. */
export function workTargets(ctx: GrantContext): readonly GrantTarget[] {
  const { deployment: d, stack } = ctx
  if (stack.kind !== 'sidequest-v1' || d.sidequest === null) throw new Error('Grants require a Sidequest v1 deployment')
  return [
    {
      address: stack.holding,
      abi: sidequestHoldingAbi,
      methods: ['activate', 'cancel', 'cancelSelection', 'claimTopUpRefund', 'settle', 'withdraw'],
    },
    {
      address: stack.evaluator,
      abi: sidequestEvaluatorAbi,
      methods: [
        'accept',
        'reject',
        'dispute',
        'completeAfterSilence',
        'rejectAfterDeliveryDeadline',
        'rejectAfterWindow',
        'refundAfterArbitrationTimeout',
        'retryDeferred',
      ],
    },
    { address: d.sidequest.vault, abi: stakeVaultAbi, methods: ['cancelUndelegate', 'withdraw'] },
    { address: d.core, abi: coreAbi, methods: ['submit', 'submitClaim', 'claimRefund'] },
  ]
}

export function grantTargets(ctx: GrantContext, spec: GrantSpec): readonly GrantTarget[] {
  const { deployment: d, stack } = ctx
  switch (spec.kind) {
    case 'operator':
      return [
        ...workTargets(ctx),
        { address: d.delegation.manager, abi: delegationManagerAbi, methods: ['disableDelegation'] },
      ]
    case 'registration':
      return [{ address: d.identity, abi: identityAbi, methods: ['register', 'setAgentWallet'] }]
    case 'agent-work':
      return [
        ...workTargets(ctx).map((target) =>
          target.address.toLowerCase() === stack.holding.toLowerCase()
            ? { ...target, methods: [...target.methods, 'publish'] }
            : target,
        ),
        {
          address: d.delegation.manager,
          abi: delegationManagerAbi,
          methods: ['redeemDelegations', 'disableDelegation'],
        },
      ]
    case 'agent-approve':
    case 'agent-approve-once':
    case 'agent-sweep':
      if (spec.kind === 'agent-approve-once') return [{ address: spec.token, abi: erc20Abi, methods: ['approve'] }]
      return [
        ...new Set(
          (spec.kind === 'agent-approve' ? d.rewardTokens : [...d.rewardTokens, d.factory]).map((address) =>
            address.toLowerCase(),
          ),
        ),
      ].map((address) => ({
        address: address as Address,
        abi: erc20Abi,
        methods: [spec.kind === 'agent-approve' ? 'approve' : 'transfer'],
      }))
    case 'allowance':
    case 'allowance-once':
      return [{ address: spec.token, abi: erc20Abi, methods: ['transfer'] }]
    case 'unstake':
      if (d.sidequest === null) throw new Error('Unstaking requires a Sidequest v1 deployment')
      return [{ address: d.sidequest.vault, abi: stakeVaultAbi, methods: ['requestUndelegate'] }]
    case 'permission':
      // An exact call names its target only; checkPermissionExecution, not a method list, decides what it may do.
      return spec.terms.type === 'sidequest:contract-call'
        ? [{ address: spec.terms.target, abi: [], methods: [] }]
        : [{ address: spec.terms.token, abi: erc20Abi, methods: ['transfer'] }]
  }
}

/** MetaMask ERC20PeriodTransferEnforcer: packed address, amount, duration and start, not ABI words for address. */
export function periodTransferTerms(token: Address, amount: bigint, duration: number, start: number): Hex {
  if (
    !isAddress(token) ||
    amount <= 0n ||
    !Number.isSafeInteger(duration) ||
    duration <= 0 ||
    !Number.isSafeInteger(start) ||
    start <= 0
  ) {
    throw new Error('Invalid period transfer terms')
  }
  return encodePacked(
    ['address', 'uint256', 'uint256', 'uint256'],
    [token, amount, BigInt(duration), BigInt(start)],
  ).toLowerCase() as Hex
}

export function grantExpiry(spec: GrantSpec): number {
  if (spec.kind === 'permission') return spec.expiry
  const validity =
    spec.kind === 'allowance'
      ? ALLOWANCE_VALIDITY
      : spec.kind === 'registration' ||
          spec.kind === 'allowance-once' ||
          spec.kind === 'agent-approve-once' ||
          spec.kind === 'unstake'
        ? ONE_OFF_VALIDITY
        : GRANT_VALIDITY
  return spec.start + validity
}

export function grantCallLimit(spec: GrantSpec): number {
  if (spec.kind === 'permission') {
    return spec.terms.type === 'sidequest:contract-call' ? 1 : GRANT_CALLS
  }
  return spec.kind === 'registration'
    ? 2
    : spec.kind === 'unstake' || spec.kind === 'allowance-once' || spec.kind === 'agent-approve-once'
      ? 1
      : GRANT_CALLS
}

/** Whether the delegation carries a LimitedCalls caveat (token permissions are bounded by amount, not by calls). */
export function grantHasCallLimit(spec: GrantSpec): boolean {
  return spec.kind !== 'allowance' && (spec.kind !== 'permission' || spec.terms.type === 'sidequest:contract-call')
}

export function buildGrant(ctx: GrantContext, spec: GrantSpec): Delegation {
  if (spec.kind === 'permission') return buildPermission(ctx.deployment, spec)
  if (!isAddress(spec.delegator) || !Number.isSafeInteger(spec.start) || spec.start <= 0 || spec.salt < 0n)
    throw new Error('Invalid grant identity')
  const { deployment: d, stack } = ctx
  const e = d.delegation.enforcers
  const allowance = spec.kind === 'allowance' || spec.kind === 'allowance-once'
  const delegate = allowance ? spec.agent : d.relay
  if (!isAddress(delegate)) throw new Error('Invalid grant delegate')
  const targets = grantTargets(ctx, spec)
  // register(string) only; register() would omit the recorded profile URI.
  const methods = targets.flatMap((target) =>
    functions(target)
      .filter((fn) => spec.kind !== 'registration' || fn.name !== 'register' || fn.inputs.length === 1)
      .map((fn) => toFunctionSelector(fn)),
  )
  const caveats = [
    caveat(e.allowedTargets, concat(targets.map((target) => target.address))),
    caveat(e.allowedMethods, concat([...new Set(methods)])),
    caveat(e.valueLte, uint(0n)),
    caveat(e.timestamp, encodePacked(['uint128', 'uint128'], [0n, BigInt(grantExpiry(spec))])),
  ]
  if (spec.kind !== 'allowance') caveats.push(caveat(e.limitedCalls, uint(BigInt(grantCallLimit(spec)))))
  if (spec.kind === 'agent-approve' || spec.kind === 'agent-approve-once' || spec.kind === 'agent-sweep' || allowance) {
    const recipient =
      spec.kind === 'agent-approve' || spec.kind === 'agent-approve-once'
        ? stack.holding
        : spec.kind === 'agent-sweep'
          ? spec.operator
          : spec.agent
    if (!isAddress(recipient)) throw new Error('Invalid grant recipient')
    caveats.push(caveat(e.allowedCalldata, encodePacked(['uint256', 'bytes'], [4n, pad(recipient, { size: 32 })])))
    if (spec.kind === 'agent-approve-once') {
      if (spec.amount <= 0n) throw new Error('One-off approval requires a positive amount')
      if (!/^0x[0-9a-fA-F]{64}$/.test(spec.operationId))
        throw new Error('One-off approval requires its exact operation')
      caveats.push(caveat(e.allowedCalldata, encodePacked(['uint256', 'bytes'], [36n, uint(spec.amount)])))
    }
  }
  if (spec.kind === 'unstake') {
    if (spec.shares <= 0n || !/^0x[0-9a-fA-F]{64}$/.test(spec.operationId))
      throw new Error('Unstake requires an exact positive approved operation')
    caveats.push(caveat(e.allowedCalldata, encodePacked(['uint256', 'bytes'], [4n, pad(spec.delegator, { size: 32 })])))
    caveats.push(caveat(e.allowedCalldata, encodePacked(['uint256', 'bytes'], [36n, uint(spec.shares)])))
  }
  if (spec.kind === 'allowance')
    caveats.push(
      caveat(e.erc20PeriodTransfer, periodTransferTerms(spec.token, spec.amount, ALLOWANCE_PERIOD, spec.start)),
    )
  if (spec.kind === 'allowance-once') {
    if (spec.amount <= 0n) throw new Error('One-off allowance requires a positive amount')
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [spec.agent, spec.amount] })
    caveats.push(caveat(e.allowedCalldata, encodePacked(['uint256', 'bytes'], [0n, data])))
    caveats.push(caveat(e.erc20TransferAmount, encodePacked(['address', 'uint256'], [spec.token, spec.amount])))
  }
  return { delegator: spec.delegator, delegate, authority: ROOT_AUTHORITY, salt: spec.salt, caveats, signature: '0x' }
}

/** Reject extra caveats, mutated terms, parent authority, and unsigned args before any routine signature. */
export function assertGrant(ctx: GrantContext, spec: GrantSpec, grant: Delegation): void {
  if (
    grant.caveats.some((item) => item.args !== '0x') ||
    delegationHash(grant) !== delegationHash(buildGrant(ctx, spec))
  ) {
    throw new Error('Grant differs from the approved template')
  }
}

export function describeGrant(ctx: GrantContext, spec: GrantSpec, grant: Delegation) {
  assertGrant(ctx, spec, grant)
  if (spec.kind === 'permission') return describePermissionGrant(ctx, spec, grant)
  return {
    kind: spec.kind,
    chainId: ctx.deployment.chainId,
    delegator: grant.delegator,
    delegate: grant.delegate,
    targets: grantTargets(ctx, spec).map((target) => ({ address: target.address, methods: target.methods })),
    validAfter: spec.start,
    expiresAt: grantExpiry(spec),
    calls: spec.kind === 'allowance' ? null : grantCallLimit(spec),
    nativeValue: '0',
    recipient:
      spec.kind === 'agent-approve' || spec.kind === 'agent-approve-once'
        ? ctx.stack.holding
        : spec.kind === 'agent-sweep'
          ? spec.operator
          : spec.kind === 'allowance' || spec.kind === 'allowance-once'
            ? spec.agent
            : null,
    token:
      spec.kind === 'allowance' || spec.kind === 'allowance-once' || spec.kind === 'agent-approve-once'
        ? spec.token
        : null,
    amount:
      spec.kind === 'allowance' || spec.kind === 'allowance-once' || spec.kind === 'agent-approve-once'
        ? spec.amount.toString()
        : null,
    shares: spec.kind === 'unstake' ? spec.shares.toString() : null,
    periodSeconds: spec.kind === 'allowance' ? ALLOWANCE_PERIOD : null,
  }
}

function permissionGrantFields(terms: PermissionTerms) {
  switch (terms.type) {
    case 'sidequest:contract-call':
      return {
        targets: [{ address: terms.target, methods: [terms.callData.slice(0, 10)] }],
        calls: 1,
        nativeValue: terms.value.toString(),
      }
    case 'erc20-token-periodic':
    case 'erc20-token-allowance':
      return {
        targets: [{ address: terms.token, methods: ['transfer'] }],
        token: terms.token,
        recipient: terms.recipient,
        amount: (terms.type === 'erc20-token-periodic' ? terms.periodAmount : terms.amount).toString(),
        periodSeconds: terms.type === 'erc20-token-periodic' ? terms.periodDuration : null,
      }
  }
}

function describePermissionGrant(
  ctx: GrantContext,
  spec: Extract<GrantSpec, { kind: 'permission' }>,
  grant: Delegation,
) {
  return {
    kind: spec.kind,
    chainId: ctx.deployment.chainId,
    delegator: grant.delegator,
    delegate: grant.delegate,
    validAfter: spec.start,
    expiresAt: spec.expiry,
    calls: null,
    nativeValue: '0',
    recipient: null,
    token: null,
    amount: null,
    shares: null,
    periodSeconds: null,
    ...permissionGrantFields(spec.terms),
  }
}
export function permissionDescription(t: PermissionTerms) {
  switch (t.type) {
    case 'sidequest:contract-call':
      return { target: t.target, value: t.value.toString(), callData: t.callData, calls: 1 }
    case 'erc20-token-periodic':
    case 'erc20-token-allowance':
      return {
        token: t.token,
        recipient: t.recipient,
        amount: (t.type === 'erc20-token-periodic' ? t.periodAmount : t.amount).toString(),
        periodSeconds: t.type === 'erc20-token-periodic' ? t.periodDuration : null,
      }
  }
}
