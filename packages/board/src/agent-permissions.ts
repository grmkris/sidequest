/**
 * Permissions on demand (ADR-0015 draft): an agent requests one ERC-7715 permission, its operator reviews and signs the
 * exact operator → agent delegation in Explore, and the agent redeems it through its own work grant. Requests and
 * decisions live in `approvals` (kind 'permission'); the frozen template and signature live in `grants`, so a
 * permission is built, asserted, stored, sponsored and revoked like any other grant.
 */
import * as sdk from '@sidequest/sdk'
import { type Address, type Hex, encodeFunctionData, erc20Abi, keccak256, parseAbi, stringToHex } from 'viem'
import { AgentFailure } from './agent-failure.ts'
import { AgentStore, type AgentRow, type ApprovalRow } from './agents.ts'
import { GrantStore, type GrantRow } from './grants.ts'
import type { Sql } from './store.ts'

/** What an approval of kind 'permission' stores as request_json: the validated request and how it was asked. */
export interface PermissionApprovalRequest {
  readonly terms: string
  readonly expiry: number
  readonly adjustable: boolean
  readonly justification: string | null
  readonly standing: boolean
}

/** The operator's decision: the signed template and whether it stands for later covered requests. */
export interface PermissionDecision {
  readonly permissionHash: Hex
  readonly standing: boolean
  readonly adjusted: boolean
}

const termsJson = (terms: sdk.PermissionTerms) =>
  JSON.stringify(terms, (_, value) => (typeof value === 'bigint' ? value.toString() : value))

function parseTerms(json: string): sdk.PermissionTerms {
  // Reuse the spec parser for one canonical reading of stored terms.
  return sdk.parsePermissionSpec(
    JSON.stringify({
      kind: 'permission',
      delegator: '0x0000000000000000000000000000000000000001',
      agent: '0x0000000000000000000000000000000000000002',
      salt: '0',
      start: 0,
      expiry: 0,
      terms: JSON.parse(json),
    }),
  ).terms
}

/** Whether a live standing permission already allows everything the request asks for. */
function covers(have: sdk.PermissionTerms, want: sdk.PermissionTerms): boolean {
  if (have.type !== want.type) return false
  if (have.type === 'sidequest:contract-call' && want.type === 'sidequest:contract-call') {
    return (
      have.target.toLowerCase() === want.target.toLowerCase() &&
      have.value === want.value &&
      have.callData === want.callData
    )
  }
  if (have.type === 'erc20-token-periodic' && want.type === 'erc20-token-periodic') {
    return (
      have.token.toLowerCase() === want.token.toLowerCase() &&
      have.recipient.toLowerCase() === want.recipient.toLowerCase() &&
      want.periodAmount <= have.periodAmount &&
      want.periodDuration >= have.periodDuration
    )
  }
  if (have.type === 'erc20-token-allowance' && want.type === 'erc20-token-allowance') {
    return (
      have.token.toLowerCase() === want.token.toLowerCase() &&
      have.recipient.toLowerCase() === want.recipient.toLowerCase() &&
      want.amount <= have.amount
    )
  }
  return false
}

/** Seconds one prepared periodic template is reused; its start is the period anchor. */
export const PERMISSION_TEMPLATE_WINDOW = 600
/** A periodic template older than this (window plus clock skew) is refused at signing time (VV2-023). */
export const PERMISSION_TEMPLATE_MAX_AGE = 900

export class AgentPermissions {
  readonly agents: AgentStore
  readonly grants: GrantStore

  constructor(readonly deps: { readonly sql: Sql; readonly context: sdk.Ctx; readonly now: () => number }) {
    this.agents = new AgentStore(deps.sql, deps.now)
    this.grants = new GrantStore(deps.sql, deps.context)
  }

  /** Validates one request for this agent: the agent is `to`, the operator `from`; the expiry rule is capped per type. */
  parse(agent: AgentRow, request: sdk.PermissionRequest, standing: boolean): PermissionApprovalRequest {
    if (agent.address === null)
      throw new AgentFailure('forbidden', 'This agent has no wallet yet', 'agent-unavailable', 'none')
    let parsed: sdk.ParsedPermissionRequest
    try {
      parsed = sdk.parsePermissionRequest(request, {
        chainId: this.deps.context.deployment.chainId,
        agent: agent.address,
        operator: agent.operator,
        now: this.deps.now(),
      })
    } catch (error) {
      if (error instanceof sdk.PermissionError)
        throw new AgentFailure('invalid', error.message, 'permission-request', 'new-key')
      throw error
    }
    return {
      terms: termsJson(parsed.terms),
      expiry: parsed.expiry,
      adjustable: parsed.adjustable,
      justification: parsed.justification,
      standing,
    }
  }

  /** The permissions this operator granted this agent, newest first. */
  #rows(agent: AgentRow): GrantRow[] {
    return this.grants
      .list(agent.operator)
      .filter(
        (row) =>
          row.kind === 'permission' &&
          agent.address !== null &&
          row.delegate.toLowerCase() === agent.address.toLowerCase(),
      )
  }

  #decision(hash: Hex): (PermissionDecision & { approvalId: string }) | undefined {
    for (const row of this.deps.sql.all<ApprovalRow>(
      "SELECT * FROM approvals WHERE kind='permission' AND status IN ('approved','executed')",
    )) {
      const decision = JSON.parse(row.decision_json ?? '{}') as Partial<PermissionDecision>
      if (decision.permissionHash === hash)
        return {
          approvalId: row.id,
          permissionHash: hash,
          standing: decision.standing === true,
          adjusted: decision.adjusted === true,
        }
    }
    return undefined
  }

  /**
   * A live standing permission covering the request, if any: the same token and recipient with at least the amount
   * (or the same exact call), lasting at least as long. Covered requests are granted without asking again.
   */
  async covering(agent: AgentRow, request: PermissionApprovalRequest): Promise<GrantRow | undefined> {
    const want = parseTerms(request.terms)
    for (const row of this.#rows(agent)) {
      if (
        row.status !== 'live' ||
        row.expires_at <= this.deps.now() ||
        row.expires_at < request.expiry ||
        this.#decision(row.delegation_hash)?.standing !== true
      )
        continue
      const spec = this.grants.spec(row.delegation_hash)
      if (spec.kind !== 'permission') continue
      if (!covers(spec.terms, want) || !(await this.#available(row, spec, want))) continue
      return row
    }
    return undefined
  }

  async #available(row: GrantRow, spec: sdk.PermissionSpec, want: sdk.PermissionTerms): Promise<boolean> {
    const ctx = this.deps.context
    const hash = row.delegation_hash
    if (await sdk.isDisabled(ctx, hash)) return false
    if (sdk.grantHasCallLimit(spec)) {
      return (await sdk.callsMade(ctx, hash)) + 1n <= BigInt(sdk.grantCallLimit(spec))
    }
    if (want.type === 'erc20-token-allowance' && spec.terms.type === 'erc20-token-allowance')
      return (await sdk.drawn(ctx, hash)) + want.amount <= spec.terms.amount
    if (want.type === 'erc20-token-periodic') return (await this.#periodAvailable(row)) >= want.periodAmount
    return false
  }

  async #periodAvailable(row: GrantRow): Promise<bigint> {
    const ctx = this.deps.context
    const enforcer = ctx.deployment.delegation.enforcers.erc20PeriodTransfer
    const caveat = this.grants
      .signed(row.delegation_hash)
      .caveats.find((item) => item.enforcer.toLowerCase() === enforcer.toLowerCase())
    if (caveat === undefined) throw new Error('Permission is missing its period caveat')
    const [available] = await ctx.publicClient.readContract({
      address: enforcer,
      abi: parseAbi([
        'function getAvailableAmount(bytes32 hash,address manager,bytes terms) view returns (uint256,bool,uint256)',
      ]),
      functionName: 'getAvailableAmount',
      args: [row.delegation_hash, ctx.deployment.delegation.manager, caveat.terms],
    })
    return available
  }

  /** The ERC-7715 response for a live permission: its context is the signed delegation the agent redeems. */
  response(hash: Hex) {
    const spec = this.grants.spec(hash) as sdk.PermissionSpec
    const signed = this.grants.signed(hash)
    return {
      permissionId: hash,
      chainId: `0x${this.deps.context.deployment.chainId.toString(16)}`,
      from: spec.delegator,
      to: spec.agent,
      context: sdk.permissionContext(signed),
      delegationManager: this.deps.context.deployment.delegation.manager,
      dependencies: [],
      permission: sdk.describePermission(spec),
    }
  }

  list(agent: AgentRow) {
    return this.#rows(agent).map((row) => ({
      permissionId: row.delegation_hash,
      status: row.status === 'live' && row.expires_at <= this.deps.now() ? 'expired' : row.status,
      expiresAt: row.expires_at,
      standing: this.#decision(row.delegation_hash)?.standing ?? false,
      permission: sdk.describePermission(this.grants.spec(row.delegation_hash) as sdk.PermissionSpec),
    }))
  }

  /**
   * The operator's signing request for a pending permission approval. An adjustment may only shorten the expiry or
   * lower the amount, and only when the agent allowed it; each distinct adjustment freezes its own template.
   */
  prepare(approval: ApprovalRow, operator: Address, adjust: { expiry?: number; amount?: bigint } = {}) {
    const agent = this.agents.owned(approval.agent_id, operator)
    if (
      approval.kind !== 'permission' ||
      approval.status !== 'pending' ||
      agent.state !== 'active' ||
      agent.address === null
    )
      throw new Error('This approval is unavailable')
    const request = JSON.parse(approval.request_json) as PermissionApprovalRequest
    const requested: sdk.ParsedPermissionRequest = {
      terms: parseTerms(request.terms),
      expiry: request.expiry,
      adjustable: request.adjustable,
      justification: request.justification,
    }
    const adjustment = {
      ...(adjust.expiry === undefined ? {} : { expiry: adjust.expiry }),
      ...(adjust.amount === undefined
        ? {}
        : requested.terms.type === 'erc20-token-periodic'
          ? { periodAmount: adjust.amount }
          : { amount: adjust.amount }),
    }
    let final: sdk.ParsedPermissionRequest
    try {
      final = sdk.adjustPermission(requested, adjustment)
    } catch (error) {
      throw error instanceof sdk.PermissionError ? new Error(error.message) : error
    }
    if (final.expiry <= this.deps.now())
      throw new Error('This permission request has expired; the agent must ask again')
    const adjusted = final.expiry !== requested.expiry || termsJson(final.terms) !== termsJson(requested.terms)
    // One salt per approval and adjustment: re-preparing the same choice returns the same template. A periodic template's
    // start is its period anchor, so it is reused for one ten-minute window and then replaced (VV2-023); other types'
    // bytes do not contain the start, so they keep one template (VV2-026).
    const salt = BigInt(keccak256(stringToHex(JSON.stringify([approval.id, final.expiry, termsJson(final.terms)]))))
    const spec: sdk.PermissionSpec = {
      kind: 'permission',
      delegator: operator,
      agent: agent.address,
      salt,
      start: this.deps.now(),
      expiry: final.expiry,
      terms: final.terms,
    }
    const base = `operator-permission:${salt.toString(16).slice(0, 16)}`
    const step =
      final.terms.type === 'erc20-token-periodic'
        ? `${base}:${Math.floor(this.deps.now() / PERMISSION_TEMPLATE_WINDOW)}`
        : base
    const frozen = this.agents.step<string>(approval.operation_id, step)
    const prepared = this.grants.prepare(operator, frozen === undefined ? spec : sdk.parsePermissionSpec(frozen))
    if (frozen === undefined) this.agents.freezeStep(approval.operation_id, step, sdk.permissionSpecJson(spec))
    const frozenSpec = this.grants.spec(prepared.hash) as sdk.PermissionSpec
    return {
      approval,
      ...prepared,
      adjusted,
      risks: sdk.permissionRisks(this.deps.context.deployment, frozenSpec, { now: this.deps.now(), adjusted }),
    }
  }

  /** Verifies the operator's signature over the exact prepared template, then records the decision. */
  async decide(
    approval: ApprovalRow,
    operator: Address,
    input: { approved: boolean; hash?: Hex; signature?: Hex; standing?: boolean },
  ): Promise<ApprovalRow> {
    this.agents.owned(approval.agent_id, operator)
    if (approval.kind !== 'permission') throw new Error('Not a permission approval')
    if (approval.status !== 'pending') return approval
    if (!input.approved) return this.agents.decide(approval.id, operator, false, {})
    if (input.hash === undefined || input.signature === undefined)
      throw new Error('Sign the prepared permission before approving it')
    const row = this.grants.get(input.hash)
    const steps = this.deps.sql.all<{ value_json: string }>(
      "SELECT value_json FROM agent_operation_steps WHERE operation_id=? AND name LIKE 'operator-permission:%'",
      approval.operation_id,
    )
    const prepared = steps
      .map((step) => JSON.parse(step.value_json) as string)
      .map((json) => sdk.parsePermissionSpec(json))
      .find((spec) => sdk.delegationHash(sdk.buildGrant(this.deps.context, spec)) === input.hash)
    if (row === undefined || prepared === undefined || row.kind !== 'permission' || row.expires_at <= this.deps.now())
      throw new Error('Sign a permission prepared for this approval')
    // An old review must not anchor a period that refills almost at once, however long ago it was signed in the browser.
    if (
      prepared.terms.type === 'erc20-token-periodic' &&
      prepared.start < this.deps.now() - PERMISSION_TEMPLATE_MAX_AGE
    )
      throw new Error('This prepared permission is out of date; review it again')
    await this.grants.confirm(input.hash, input.signature)
    const request = JSON.parse(approval.request_json) as PermissionApprovalRequest
    const adjusted = prepared.expiry !== request.expiry || termsJson(prepared.terms) !== request.terms
    return this.agents.decide(approval.id, operator, true, {
      permissionHash: input.hash,
      standing: input.standing === true,
      adjusted,
    } satisfies PermissionDecision)
  }

  /** The agent's redemption of a live permission: one manager call through its own work grant, sponsored like any. */
  use(agent: AgentRow, permissionId: string, input: { transfer?: { recipient?: unknown; amount?: unknown } }) {
    const row = this.#rows(agent).find((item) => item.delegation_hash.toLowerCase() === permissionId.toLowerCase())
    if (row === undefined)
      throw new AgentFailure('not-found', 'No such permission for this agent', 'permission-missing', 'none')
    if (row.status !== 'live' || row.expires_at <= this.deps.now())
      throw new AgentFailure(
        'conflict',
        'This permission is not live; request a new one',
        'permission-ended',
        'new-key',
      )
    const spec = this.grants.spec(row.delegation_hash) as sdk.PermissionSpec
    const t = spec.terms
    const execution = permissionExecution(t, input)
    try {
      sdk.checkPermissionExecution(spec, execution, this.deps.now())
    } catch (error) {
      throw error instanceof sdk.PermissionError
        ? new AgentFailure('forbidden', error.message, 'outside-policy', 'none')
        : error
    }
    return {
      permissionId: row.delegation_hash,
      transactions: [
        {
          to: this.deps.context.deployment.delegation.manager,
          data: sdk.redeemCalldata(this.grants.signed(row.delegation_hash), execution),
          value: '0',
          description: 'Redeem the operator permission',
          chainId: this.deps.context.deployment.chainId,
        },
      ],
    }
  }

  /** The agent gives a permission back: the board stops sponsoring it. Only the operator can disable it on-chain. */
  stop(agent: AgentRow, permissionId: string) {
    const row = this.#rows(agent).find((item) => item.delegation_hash.toLowerCase() === permissionId.toLowerCase())
    if (row === undefined)
      throw new AgentFailure('not-found', 'No such permission for this agent', 'permission-missing', 'none')
    this.grants.stop(row.delegation_hash)
    return { permissionId: row.delegation_hash, status: this.grants.get(row.delegation_hash)!.status }
  }
}

function permissionExecution(
  t: sdk.PermissionTerms,
  input: { transfer?: { recipient?: unknown; amount?: unknown } },
): sdk.Execution {
  if (t.type === 'sidequest:contract-call') {
    if (input.transfer !== undefined)
      throw new AgentFailure(
        'invalid',
        'An exact-call permission runs its approved call only',
        'permission-request',
        'new-key',
      )
    return { target: t.target, value: t.value, callData: t.callData }
  }
  {
    const amount =
      typeof input.transfer?.amount === 'string' && /^[0-9]{1,78}$/.test(input.transfer.amount)
        ? BigInt(input.transfer.amount)
        : undefined
    const recipient = typeof input.transfer?.recipient === 'string' ? input.transfer.recipient : t.recipient
    if (amount === undefined)
      throw new AgentFailure(
        'invalid',
        'transfer.amount must be base units as a decimal string',
        'permission-request',
        'new-key',
      )
    return {
      target: t.token,
      value: 0n,
      callData: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient as Address, amount] }),
    }
  }
}
