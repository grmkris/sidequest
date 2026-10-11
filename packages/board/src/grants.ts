/** Immutable prepared grant templates and signed bytes. Chain counters remain the authority for availability. */
import * as sdk from '@sidequest/sdk'
import { type Address, type Hex, recoverAddress } from 'viem'
import { migrateAgentSchema } from './agent-schema.ts'
import type { Sql } from './store.ts'
import { checkGrantCall } from './grant-calls.ts'
import { BoardError } from './board-error.ts'

export interface GrantRow {
  delegation_hash: Hex
  kind: sdk.GrantKind
  delegator: Address
  delegate: Address
  owner: Address
  delegation_json: string
  signature: Hex | null
  status: 'prepared' | 'live' | 'revoked' | 'disabled'
  expires_at: number
}

const sortedKeys = (value: object) =>
  Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b)))

export function grantSpecJson(spec: sdk.GrantSpec): string {
  // A permission nests its terms; sort them too, so one template always has one JSON.
  const ordered = sortedKeys(spec.kind === 'permission' ? { ...spec, terms: sortedKeys(spec.terms) } : spec)
  return JSON.stringify(ordered, (_, value) => (typeof value === 'bigint' ? value.toString() : value))
}

/**
 * Permission types Sidequest no longer issues. Backer share was removed with mining (ADR-0022); a stored grant of it can
 * only set an inert metadata value, so it is left on chain to expire and skipped instead of re-parsed.
 */
export const RETIRED_PERMISSION_TYPES = ['sidequest:backer-share'] as const

export function parseGrantSpec(json: string): sdk.GrantSpec {
  const raw = JSON.parse(json) as sdk.GrantSpec & { salt: string; amount?: string; shares?: string }
  if (raw.kind === 'permission') return sdk.parsePermissionSpec(json)
  return {
    ...raw,
    salt: BigInt(raw.salt),
    ...(raw.amount === undefined ? {} : { amount: BigInt(raw.amount) }),
    ...(raw.shares === undefined ? {} : { shares: BigInt(raw.shares) }),
  } as sdk.GrantSpec
}

export class GrantStore {
  constructor(
    readonly sql: Sql,
    readonly context: sdk.GrantContext,
  ) {
    migrateAgentSchema(sql)
  }

  prepare(
    owner: Address,
    spec: sdk.GrantSpec,
  ): { hash: Hex; grant: sdk.Delegation; typedData: string; description: ReturnType<typeof sdk.describeGrant> } {
    if (spec.kind === 'agent-approve-once') this.approvedHire(owner, spec)
    if (spec.kind === 'unstake') this.approvedUnstake(owner, spec)
    const grant = sdk.buildGrant(this.context, spec)
    const hash = sdk.delegationHash(grant)
    const prior = this.get(hash)
    if (
      prior &&
      (prior.owner.toLowerCase() !== owner.toLowerCase() || prior.status === 'revoked' || prior.status === 'disabled')
    )
      throw new Error('Grant identity is already stopped')
    if (prior && grantSpecJson(this.spec(hash)) !== grantSpecJson(spec)) throw new Error('Grant template cannot change')
    if (this.sql.atomic === undefined) throw new Error('Grant preparation requires atomic storage')
    this.sql.atomic(() => {
      this.sql.run(
        `INSERT OR IGNORE INTO grants (delegation_hash,kind,delegator,delegate,owner,delegation_json,signature,status,expires_at)
        VALUES (?,?,?,?,?,?,NULL,'prepared',?)`,
        hash,
        spec.kind,
        grant.delegator.toLowerCase(),
        grant.delegate.toLowerCase(),
        owner.toLowerCase(),
        sdk.delegationJson(grant),
        sdk.grantExpiry(spec),
      )
      this.sql.run('INSERT OR IGNORE INTO grant_templates VALUES (?,?)', hash, grantSpecJson(spec))
    })
    return {
      hash,
      grant,
      typedData: sdk.delegationTypedData(this.context.deployment, grant),
      description: sdk.describeGrant(this.context, spec, grant),
    }
  }

  get(hash: Hex): GrantRow | undefined {
    return this.sql.all<GrantRow>('SELECT * FROM grants WHERE delegation_hash=?', hash)[0]
  }

  spec(hash: Hex): sdk.GrantSpec {
    const row = this.sql.all<{ spec_json: string }>(
      'SELECT spec_json FROM grant_templates WHERE delegation_hash=?',
      hash,
    )[0]
    if (!row) throw new Error('Missing grant template')
    return parseGrantSpec(row.spec_json)
  }

  /** A wallet's grants, without permissions of retired types: their templates no longer parse (RETIRED_PERMISSION_TYPES). */
  list(wallet: Address): GrantRow[] {
    return this.sql.all<GrantRow>(
      `SELECT * FROM grants WHERE delegator=? AND delegation_hash NOT IN
         (SELECT delegation_hash FROM grant_templates WHERE ${RETIRED_PERMISSION_TYPES.map(() => 'instr(spec_json,?)>0').join(' OR ')})
       ORDER BY expires_at DESC`,
      wallet.toLowerCase(),
      ...RETIRED_PERMISSION_TYPES.map((type) => `"type":"${type}"`),
    )
  }

  signed(hash: Hex): sdk.Delegation {
    const row = this.get(hash)
    if (!row || row.signature === null || row.status !== 'live') throw new Error('Grant is not live')
    const grant = { ...sdk.parseDelegation(row.delegation_json), signature: row.signature }
    sdk.assertGrant(this.context, this.spec(hash), grant)
    return grant
  }

  /** Whether a stored grant was built against this deployment's pinned targets. */
  matchesDeployment(hash: Hex): boolean {
    const row = this.get(hash)
    if (row === undefined) return false
    try {
      sdk.assertGrant(this.context, this.spec(hash), sdk.parseDelegation(row.delegation_json))
      return true
    } catch {
      return false
    }
  }

  /** Unknown-token approval authority exists only after the operator's exact allowance has been verified. */
  approvedHire(owner: Address, spec: Extract<sdk.GrantSpec, { kind: 'agent-approve-once' }>, publishData?: Hex): Hex {
    const approval = this.sql.all<{
      status: string
      request_json: string
      decision_json: string | null
      operator: string
      address: string | null
      chain_id: number
      state: string
    }>(
      `SELECT approvals.status,approvals.request_json,approvals.decision_json,agents.operator,agents.address,agents.chain_id,agents.state
       FROM approvals JOIN agents ON agents.id=approvals.agent_id
       WHERE approvals.operation_id=? AND approvals.kind='hire-over-limit'`,
      spec.operationId,
    )[0]
    if (
      approval === undefined ||
      approval.status !== 'approved' ||
      approval.state === 'revoked' ||
      approval.chain_id !== this.context.deployment.chainId ||
      approval.operator.toLowerCase() !== owner.toLowerCase() ||
      approval.address?.toLowerCase() !== spec.delegator.toLowerCase()
    )
      throw new BoardError('conflict', 'One-off approval requires a verified operator decision for this operation')
    const request = JSON.parse(approval.request_json) as { token?: string; amount?: string; publish?: Hex }
    const decision = JSON.parse(approval.decision_json ?? '{}') as { allowanceHash?: string }
    if (
      request.token?.toLowerCase() !== spec.token.toLowerCase() ||
      request.amount !== spec.amount.toString() ||
      !/^0x[0-9a-fA-F]{64}$/.test(decision.allowanceHash ?? '')
    )
      throw new BoardError('conflict', 'One-off approval differs from the approved hire')
    if (
      typeof request.publish !== 'string' ||
      (publishData !== undefined && request.publish.toLowerCase() !== publishData.toLowerCase())
    )
      throw new BoardError('conflict', 'One-off approval requires the frozen publish for this operation')
    const publish = checkGrantCall(
      this.context,
      { kind: 'agent-work', delegator: spec.delegator, salt: spec.salt, start: spec.start },
      { to: this.context.stack.holding, data: request.publish },
    )
    const params = publish.args[0] as { token: Address; reward: bigint }
    if (
      publish.method !== 'publish' ||
      params.token.toLowerCase() !== spec.token.toLowerCase() ||
      params.reward !== spec.amount
    )
      throw new BoardError('conflict', 'One-off approval differs from the frozen publish')
    const hash = decision.allowanceHash as Hex
    const allowance = this.get(hash)
    const template = this.spec(hash)
    if (
      allowance?.status !== 'live' ||
      allowance.signature === null ||
      template.kind !== 'allowance-once' ||
      allowance.owner.toLowerCase() !== owner.toLowerCase() ||
      template.delegator.toLowerCase() !== owner.toLowerCase() ||
      template.agent.toLowerCase() !== spec.delegator.toLowerCase() ||
      template.token.toLowerCase() !== spec.token.toLowerCase() ||
      template.amount !== spec.amount ||
      allowance.expires_at < sdk.grantExpiry(spec)
    )
      throw new BoardError('conflict', 'One-off approval requires the verified exact operator allowance')
    this.signed(hash)
    return hash
  }

  approvedUnstake(owner: Address, spec: Extract<sdk.GrantSpec, { kind: 'unstake' }>): void {
    const approval = this.sql.all<{
      status: string
      request_json: string
      operator: string
      address: string | null
      chain_id: number
      state: string
    }>(
      `SELECT approvals.status,approvals.request_json,agents.operator,agents.address,agents.chain_id,agents.state
       FROM approvals JOIN agents ON agents.id=approvals.agent_id
       WHERE approvals.operation_id=? AND approvals.kind='unstake'`,
      spec.operationId,
    )[0]
    if (
      approval === undefined ||
      approval.status !== 'approved' ||
      approval.state === 'revoked' ||
      approval.chain_id !== this.context.deployment.chainId ||
      approval.operator.toLowerCase() !== owner.toLowerCase() ||
      approval.address?.toLowerCase() !== spec.delegator.toLowerCase()
    )
      throw new Error('Unstake requires a verified operator decision for this operation')
    const request = JSON.parse(approval.request_json) as {
      amount?: string
      shares?: string
      call?: { to: string; data: string }
    }
    if (request.shares !== spec.shares.toString() || request.call === undefined)
      throw new Error('Unstake differs from the exact operator approval')
    checkGrantCall(this.context, spec, request.call)
  }

  async verifySignature(hash: Hex, signature: Hex): Promise<GrantRow> {
    const row = this.get(hash)
    if (!row || !['prepared', 'live'].includes(row.status)) throw new Error('Grant is not available for confirmation')
    const grant = sdk.parseDelegation(row.delegation_json)
    sdk.assertGrant(this.context, this.spec(hash), grant)
    const signer = await recoverAddress({ hash: sdk.delegationDigest(this.context.deployment, grant), signature })
    if (signer.toLowerCase() !== row.delegator.toLowerCase()) throw new Error('Grant signature is not the delegator')
    if (row.signature !== null && row.signature.toLowerCase() !== signature.toLowerCase())
      throw new Error('Grant signature changed')
    return row
  }

  async confirm(hash: Hex, signature: Hex): Promise<GrantRow> {
    await this.verifySignature(hash, signature)
    this.sql.run("UPDATE grants SET signature=?,status='live' WHERE delegation_hash=?", signature, hash)
    return this.get(hash)!
  }

  stop(hash: Hex): void {
    this.sql.run("UPDATE grants SET status='revoked' WHERE delegation_hash=? AND status!='disabled'", hash)
  }
}
