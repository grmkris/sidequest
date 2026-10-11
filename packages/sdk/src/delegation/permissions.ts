/**
 * Permissions on demand (ERC-7715 envelope, ADR-0015 draft): an agent asks its operator for one exact permission, the
 * operator signs an operator → agent delegation, and the agent redeems it through the DelegationManager. Every limit
 * here is a MetaMask v1.3.0 caveat enforced on-chain; nothing is hosted-only. The browser and the backend build, check
 * and describe the same template, as with grants.
 */
import { DELEGATOR_CONTRACTS } from '@metamask/delegation-deployments'
import {
  type Address,
  type Hex,
  concat,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  getAddress,
  isAddress,
  isHex,
  pad,
  toFunctionSelector,
} from 'viem'
import type { Deployment } from '../deployment.ts'
import { permissionDescription, type GrantSpec } from './grants.ts'
import { type Caveat, type Delegation, type Execution, ROOT_AUTHORITY, delegationHash } from './index.ts'

export const PERMISSION_TYPES = ['erc20-token-periodic', 'erc20-token-allowance', 'sidequest:contract-call'] as const
export type PermissionType = (typeof PERMISSION_TYPES)[number]

/** The longest expiry an agent may propose; the operator may shorten it, never extend it past this. */
export const PERMISSION_MAX_EXPIRY: Readonly<Record<PermissionType, number>> = {
  'erc20-token-periodic': 30 * 86_400,
  'erc20-token-allowance': 30 * 86_400,
  'sidequest:contract-call': 86_400,
}
export const PERMISSION_MIN_PERIOD = 3600

/** ERC-7715 `wallet_requestExecutionPermissions` request entry, as an agent sends it through MCP. */
export interface PermissionRequest {
  readonly chainId: Hex | number
  readonly from?: Address
  readonly to: Address
  readonly permission: {
    readonly type: string
    readonly isAdjustmentAllowed?: boolean
    readonly data: Record<string, unknown>
  }
  readonly rules?: readonly { readonly type: string; readonly data: Record<string, unknown> }[]
}

export type PermissionTerms =
  | {
      readonly type: 'erc20-token-periodic'
      readonly token: Address
      readonly periodAmount: bigint
      readonly periodDuration: number
      readonly recipient: Address
    }
  | {
      readonly type: 'erc20-token-allowance'
      readonly token: Address
      readonly amount: bigint
      readonly recipient: Address
    }
  | {
      readonly type: 'sidequest:contract-call'
      readonly target: Address
      readonly value: bigint
      readonly callData: Hex
    }

/**
 * A permission frozen for signing (a GrantSpec kind, so grants and permissions share one build/assert/store path):
 * the operator grants `terms` to `agent` from `start` until `expiry`.
 */
export type PermissionSpec = Extract<GrantSpec, { kind: 'permission' }>

/** A request the board has validated: the terms, the proposed expiry and whether the operator may change them. */
export interface ParsedPermissionRequest {
  readonly terms: PermissionTerms
  readonly expiry: number
  readonly adjustable: boolean
  readonly justification: string | null
}

export class PermissionError extends Error {}

const same = (a: Address | undefined, b: Address) => a !== undefined && a.toLowerCase() === b.toLowerCase()
const listed = (list: readonly Address[] | undefined, value: Address) => list?.some((item) => same(item, value))

/** The v1.3.0 enforcers a permission caveat uses, by chain; the shared ones must equal the deployment config. */
export function permissionEnforcers(d: Deployment) {
  const canonical = (DELEGATOR_CONTRACTS as Record<string, Record<number, Record<string, Address>>>)['1.3.0']?.[
    d.chainId
  ]
  if (canonical === undefined)
    throw new PermissionError(`Delegation framework v1.3.0 is not deployed on chain ${d.chainId}`)
  const e = d.delegation.enforcers
  if (
    !same(canonical.DelegationManager, d.delegation.manager) ||
    !same(canonical.ERC20PeriodTransferEnforcer, e.erc20PeriodTransfer) ||
    !same(canonical.ERC20TransferAmountEnforcer, e.erc20TransferAmount) ||
    !same(canonical.AllowedCalldataEnforcer, e.allowedCalldata) ||
    !same(canonical.TimestampEnforcer, e.timestamp) ||
    !same(canonical.LimitedCallsEnforcer, e.limitedCalls)
  ) {
    throw new PermissionError('Deployment enforcers differ from the canonical v1.3.0 framework')
  }
  const exactExecution = canonical.ExactExecutionEnforcer
  if (exactExecution === undefined) throw new PermissionError('ExactExecutionEnforcer is not deployed on this chain')
  return { ...e, exactExecution: getAddress(exactExecution) }
}

/** `wallet_getSupportedExecutionPermissions`: the types this board grants, on its chain, with the expiry rule only. */
export function supportedPermissions(d: Deployment): Record<PermissionType, { chainIds: Hex[]; ruleTypes: string[] }> {
  permissionEnforcers(d)
  const chainIds = [`0x${d.chainId.toString(16)}` as Hex]
  return Object.fromEntries(PERMISSION_TYPES.map((type) => [type, { chainIds, ruleTypes: ['expiry'] }])) as Record<
    PermissionType,
    { chainIds: Hex[]; ruleTypes: string[] }
  >
}

function amount(value: unknown, field: string, allowZero = false): bigint {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof text !== 'string' || !(/^0x[0-9a-fA-F]{1,64}$/.test(text) || /^[0-9]{1,78}$/.test(text)))
    throw new PermissionError(`${field} must be base units as a decimal or hex string`)
  const parsed = BigInt(text)
  if (parsed < (allowZero ? 0n : 1n) || parsed >= 2n ** 256n) throw new PermissionError(`${field} is outside uint256`)
  return parsed
}

function address(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !isAddress(value)) throw new PermissionError(`${field} must be an address`)
  return getAddress(value)
}

/**
 * Validates one ERC-7715 request entry for this agent and operator. The agent must be `to`; `from`, if given, must be
 * the operator; the expiry rule is required and capped per type. Unknown types, rules and fields are refused.
 */
export function parsePermissionRequest(
  request: PermissionRequest,
  scope: { chainId: number; agent: Address; operator: Address; now: number },
): ParsedPermissionRequest {
  const chainId =
    typeof request.chainId === 'number'
      ? request.chainId
      : isHex(request.chainId)
        ? Number(BigInt(request.chainId))
        : NaN
  if (chainId !== scope.chainId) throw new PermissionError(`chainId must be ${scope.chainId}`)
  if (address(request.to, 'to') !== getAddress(scope.agent)) throw new PermissionError("to must be this agent's wallet")
  if (request.from !== undefined && address(request.from, 'from') !== getAddress(scope.operator))
    throw new PermissionError("from must be this agent's operator")
  const type = request.permission?.type
  if (!(PERMISSION_TYPES as readonly string[]).includes(type))
    throw new PermissionError(`permission.type must be one of ${PERMISSION_TYPES.join(', ')}`)
  const rules = request.rules ?? []
  if (rules.length !== 1 || rules[0]!.type !== 'expiry')
    throw new PermissionError('exactly one rule is required: {type: "expiry", data: {timestamp}}')
  const expiry = rules[0]!.data.timestamp
  if (typeof expiry !== 'number' || !Number.isSafeInteger(expiry) || expiry <= scope.now)
    throw new PermissionError('the expiry timestamp must be future unix seconds')
  if (expiry - scope.now > PERMISSION_MAX_EXPIRY[type as PermissionType])
    throw new PermissionError(`${type} expires within ${PERMISSION_MAX_EXPIRY[type as PermissionType] / 3600} hours`)
  const data = request.permission.data ?? {}
  const justification = typeof data.justification === 'string' ? data.justification.slice(0, 500) : null
  const known = (fields: readonly string[]) => {
    const extra = Object.keys(data).filter((key) => key !== 'justification' && !fields.includes(key))
    if (extra.length > 0) throw new PermissionError(`unknown permission.data fields: ${extra.join(', ')}`)
  }
  let terms: PermissionTerms
  if (type === 'erc20-token-periodic') {
    known(['tokenAddress', 'periodAmount', 'periodDuration', 'recipient'])
    const periodDuration = data.periodDuration
    if (
      typeof periodDuration !== 'number' ||
      !Number.isSafeInteger(periodDuration) ||
      periodDuration < PERMISSION_MIN_PERIOD ||
      periodDuration > PERMISSION_MAX_EXPIRY[type]
    ) {
      throw new PermissionError(
        `periodDuration must be ${PERMISSION_MIN_PERIOD} to ${PERMISSION_MAX_EXPIRY[type]} seconds`,
      )
    }
    terms = {
      type,
      token: address(data.tokenAddress, 'tokenAddress'),
      periodAmount: amount(data.periodAmount, 'periodAmount'),
      periodDuration,
      recipient: address(data.recipient, 'recipient'),
    }
  } else if (type === 'erc20-token-allowance') {
    known(['tokenAddress', 'allowanceAmount', 'recipient'])
    terms = {
      type,
      token: address(data.tokenAddress, 'tokenAddress'),
      amount: amount(data.allowanceAmount, 'allowanceAmount'),
      recipient: address(data.recipient, 'recipient'),
    }
  } else {
    known(['target', 'value', 'calldata'])
    const callData = data.calldata
    if (
      typeof callData !== 'string' ||
      !isHex(callData) ||
      callData.length < 10 ||
      callData.length % 2 !== 0 ||
      callData.length > 2 + 2 * 24_576
    ) {
      throw new PermissionError('calldata must be the exact hex call, selector included')
    }
    const value =
      data.value === undefined || data.value === '0' || data.value === '0x0' ? 0n : amount(data.value, 'value')
    terms = {
      type: 'sidequest:contract-call',
      target: address(data.target, 'target'),
      value,
      callData: callData.toLowerCase() as Hex,
    }
  }
  return { terms, expiry, adjustable: request.permission.isAdjustmentAllowed === true, justification }
}

/**
 * The operator's adjustment of an adjustable request: a shorter expiry or smaller amounts only. Targets, tokens,
 * recipients and exact calls never change; widening is refused.
 */
export function adjustPermission(
  requested: ParsedPermissionRequest,
  adjusted: { expiry?: number; periodAmount?: bigint; amount?: bigint },
): ParsedPermissionRequest {
  if (!requested.adjustable && Object.keys(adjusted).length > 0)
    throw new PermissionError('this request does not allow adjustment')
  const expiry = adjusted.expiry ?? requested.expiry
  if (!Number.isSafeInteger(expiry) || expiry > requested.expiry)
    throw new PermissionError('an adjustment may only shorten the expiry')
  const t = requested.terms
  if (t.type === 'erc20-token-periodic') {
    const periodAmount = adjusted.periodAmount ?? t.periodAmount
    if (adjusted.amount !== undefined || periodAmount <= 0n || periodAmount > t.periodAmount)
      throw new PermissionError('an adjustment may only lower the period amount')
    return { ...requested, expiry, terms: { ...t, periodAmount } }
  }
  if (t.type === 'erc20-token-allowance') {
    const value = adjusted.amount ?? t.amount
    if (adjusted.periodAmount !== undefined || value <= 0n || value > t.amount)
      throw new PermissionError('an adjustment may only lower the amount')
    return { ...requested, expiry, terms: { ...t, amount: value } }
  }
  if (adjusted.amount !== undefined || adjusted.periodAmount !== undefined)
    throw new PermissionError('an exact call has no amount to adjust')
  return { ...requested, expiry }
}

function uint(value: bigint): Hex {
  return encodeAbiParameters([{ type: 'uint256' }], [value])
}

function caveat(enforcer: Address, terms: Hex): Caveat {
  return { enforcer, terms: terms.toLowerCase() as Hex, args: '0x' }
}

const transferSelector = toFunctionSelector('function transfer(address,uint256)')

/** The operator → agent delegation for a frozen permission. */
export function buildPermission(d: Deployment, spec: PermissionSpec): Delegation {
  if (
    !isAddress(spec.delegator) ||
    !isAddress(spec.agent) ||
    spec.salt < 0n ||
    !Number.isSafeInteger(spec.start) ||
    spec.start <= 0 ||
    !Number.isSafeInteger(spec.expiry) ||
    spec.expiry <= spec.start ||
    spec.expiry - spec.start > PERMISSION_MAX_EXPIRY[spec.terms.type]
  ) {
    throw new PermissionError('Invalid permission identity or validity')
  }
  if (spec.delegator.toLowerCase() === spec.agent.toLowerCase())
    throw new PermissionError('A permission is granted to another account')
  const e = permissionEnforcers(d)
  const t = spec.terms
  const caveats: Caveat[] = [caveat(e.timestamp, encodePacked(['uint128', 'uint128'], [0n, BigInt(spec.expiry)]))]
  if (t.type === 'sidequest:contract-call') {
    caveats.push(
      caveat(e.exactExecution, encodePacked(['address', 'uint256', 'bytes'], [t.target, t.value, t.callData])),
    )
    caveats.push(caveat(e.limitedCalls, uint(1n)))
  } else {
    caveats.push(
      caveat(e.allowedTargets, concat([t.token])),
      caveat(e.allowedMethods, transferSelector),
      caveat(e.valueLte, uint(0n)),
      caveat(e.allowedCalldata, encodePacked(['uint256', 'bytes'], [4n, pad(t.recipient, { size: 32 })])),
    )
    // ERC20PeriodTransferEnforcer: packed token, amount, duration and start (as the allowance grant encodes it).
    if (t.type === 'erc20-token-periodic')
      caveats.push(
        caveat(
          e.erc20PeriodTransfer,
          encodePacked(
            ['address', 'uint256', 'uint256', 'uint256'],
            [t.token, t.periodAmount, BigInt(t.periodDuration), BigInt(spec.start)],
          ),
        ),
      )
    else caveats.push(caveat(e.erc20TransferAmount, encodePacked(['address', 'uint256'], [t.token, t.amount])))
  }
  return {
    delegator: getAddress(spec.delegator),
    delegate: getAddress(spec.agent),
    authority: ROOT_AUTHORITY,
    salt: spec.salt,
    caveats,
    signature: '0x',
  }
}

/** Rejects extra caveats, mutated terms, parent authority and unsigned args, as assertGrant does for grants. */
export function assertPermission(d: Deployment, spec: PermissionSpec, delegation: Delegation): void {
  if (
    delegation.caveats.some((item) => item.args !== '0x') ||
    delegationHash(delegation) !== delegationHash(buildPermission(d, spec))
  ) {
    throw new PermissionError('Delegation differs from the approved permission')
  }
}

/**
 * Whether one execution stays inside the permission, checked before any sponsored send. The chain enforces the same
 * limits; this refuses early and never lets the relay pay for a call the enforcers would revert.
 */
export function checkPermissionExecution(spec: PermissionSpec, execution: Execution, now?: number): void {
  if (now !== undefined && now >= spec.expiry) throw new PermissionError('the permission has expired')
  const t = spec.terms
  if (t.type === 'sidequest:contract-call') {
    if (
      execution.target.toLowerCase() !== t.target.toLowerCase() ||
      execution.value !== t.value ||
      execution.callData.toLowerCase() !== t.callData
    ) {
      throw new PermissionError('the call differs from the exact approved call')
    }
    return
  }
  checkTokenPermissionExecution(t, execution)
}

function checkTokenPermissionExecution(t: Extract<PermissionTerms, { token: Address }>, execution: Execution) {
  if (execution.target.toLowerCase() !== t.token.toLowerCase() || execution.value !== 0n)
    throw new PermissionError('the call is outside the permitted token transfer')
  let args: readonly [Address, bigint]
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: execution.callData })
    if (decoded.functionName !== 'transfer') throw new Error('not a transfer')
    args = decoded.args as readonly [Address, bigint]
  } catch {
    throw new PermissionError('the call is outside the permitted token transfer')
  }
  if (
    execution.callData.toLowerCase() !==
    encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [args[0], args[1]] }).toLowerCase()
  ) {
    throw new PermissionError('the transfer calldata is not canonical')
  }
  if (args[0].toLowerCase() !== t.recipient.toLowerCase())
    throw new PermissionError('the transfer goes to a different recipient')
  const limit = t.type === 'erc20-token-periodic' ? t.periodAmount : t.amount
  if (args[1] <= 0n || args[1] > limit) throw new PermissionError('the transfer exceeds the permitted amount')
}

/** The plain description an approval card and a Telegram notice show. */
export function describePermission(spec: PermissionSpec) {
  return {
    type: spec.terms.type,
    from: spec.delegator,
    to: spec.agent,
    validAfter: spec.start,
    expiresAt: spec.expiry,
    ...permissionDescription(spec.terms),
  }
}

export interface PermissionRisk {
  readonly level: 'high' | 'medium' | 'info'
  readonly code: string
  readonly message: string
}

const DANGEROUS_SELECTORS: Readonly<Record<string, string>> = {
  [toFunctionSelector('function approve(address,uint256)')]: 'approve',
  [toFunctionSelector('function setApprovalForAll(address,bool)')]: 'setApprovalForAll',
  [toFunctionSelector('function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)')]: 'permit',
  [toFunctionSelector('function upgradeTo(address)')]: 'upgradeTo',
  [toFunctionSelector('function upgradeToAndCall(address,bytes)')]: 'upgradeToAndCall',
  [toFunctionSelector('function transferOwnership(address)')]: 'transferOwnership',
}

/**
 * What the operator should notice before signing. Facts the caller knows are optional: without a balance there is no
 * share check, without an address book no unknown-recipient check, without known targets no unknown-target check.
 */
export function permissionRisks(
  d: Deployment,
  spec: PermissionSpec,
  facts: {
    now: number
    balance?: bigint
    addressBook?: readonly Address[]
    knownTargets?: readonly Address[]
    adjusted?: boolean
    simulationReverted?: boolean
  },
): PermissionRisk[] {
  const risks: PermissionRisk[] = []
  const t = spec.terms
  if (t.type === 'sidequest:contract-call') {
    if (t.value > 0n)
      risks.push({ level: 'high', code: 'native-value', message: 'The call sends native MON from your account.' })
    const dangerous = DANGEROUS_SELECTORS[t.callData.slice(0, 10)]
    if (dangerous !== undefined)
      risks.push({
        level: 'high',
        code: 'dangerous-method',
        message: `The call is ${dangerous}, which hands control of assets or contracts to someone.`,
      })
    if (t.target.toLowerCase() === d.delegation.manager.toLowerCase())
      risks.push({ level: 'high', code: 'delegation-manager', message: 'The call targets the DelegationManager.' })
    if (t.target.toLowerCase() === spec.delegator.toLowerCase())
      risks.push({ level: 'high', code: 'self-call', message: 'The call targets your own account.' })
    if (facts.knownTargets !== undefined && !listed(facts.knownTargets, t.target))
      risks.push({ level: 'high', code: 'unknown-target', message: 'The target is not a known contract.' })
  } else {
    const limit = t.type === 'erc20-token-periodic' ? t.periodAmount : t.amount
    if (facts.balance !== undefined && limit * 2n > facts.balance)
      risks.push({
        level: 'high',
        code: 'large-share',
        message: 'The permission can move more than half of your current balance.',
      })
    if (facts.addressBook !== undefined && !listed(facts.addressBook, t.recipient))
      risks.push({ level: 'high', code: 'unknown-recipient', message: 'The recipient is not in your address book.' })
  }
  if (spec.expiry - facts.now > 7 * 86_400)
    risks.push({ level: 'medium', code: 'long-expiry', message: 'The permission lasts more than seven days.' })
  if (facts.simulationReverted === true)
    risks.push({ level: 'medium', code: 'simulation-reverted', message: 'A simulation of the call reverted.' })
  if (facts.adjusted === true)
    risks.push({ level: 'medium', code: 'adjusted', message: 'You changed the requested terms.' })
  return risks
}

/** JSON for a stored spec (bigints as decimal strings) and its exact inverse. */
export function permissionSpecJson(spec: PermissionSpec): string {
  return JSON.stringify(spec, (_, value) => (typeof value === 'bigint' ? value.toString() : value))
}

export function parsePermissionSpec(json: string): PermissionSpec {
  const raw = JSON.parse(json) as Record<string, unknown> & { terms: Record<string, unknown> }
  const terms = storedTerms(raw.terms)
  if (raw.kind !== 'permission') throw new PermissionError('Not a permission spec')
  return {
    kind: 'permission',
    delegator: getAddress(String(raw.delegator)),
    agent: getAddress(String(raw.agent)),
    salt: BigInt(String(raw.salt)),
    start: Number(raw.start),
    expiry: Number(raw.expiry),
    terms,
  }
}

function storedTerms(t: Record<string, unknown>): PermissionTerms {
  switch (t.type) {
    case 'sidequest:contract-call':
      // SAFETY: stored exact calldata is hex validated when the request was parsed; build/assert verify the frozen bytes.
      return {
        type: t.type,
        target: getAddress(String(t.target)),
        value: BigInt(String(t.value)),
        callData: String(t.callData).toLowerCase() as Hex,
      }
    case 'erc20-token-periodic':
      return {
        type: t.type,
        token: getAddress(String(t.token)),
        recipient: getAddress(String(t.recipient)),
        periodAmount: BigInt(String(t.periodAmount)),
        periodDuration: Number(t.periodDuration),
      }
    case 'erc20-token-allowance':
      return {
        type: t.type,
        token: getAddress(String(t.token)),
        recipient: getAddress(String(t.recipient)),
        amount: BigInt(String(t.amount)),
      }
    default:
      throw new PermissionError('Unknown stored permission type')
  }
}
