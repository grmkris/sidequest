/** Agent identities, frozen operation intents and operator approvals in the reserved management object. */
import { type Address, type Hex, keccak256, stringToHex } from 'viem'
import { migrateAgentSchema } from './agent-schema.ts'
import type { Sql } from './store.ts'
import { SPONSOR_OBJECT_NAME } from './sponsor.ts'
import { AgentFailure } from './agent-failure.ts'

export const AGENTS_OBJECT_NAME = SPONSOR_OBJECT_NAME
/** What an operator lets its agent do (ADR-0021); a connection's OAuth scope only bounds it. */
export type AgentRole = 'work' | 'hire'
export const AGENT_ROLES: readonly AgentRole[] = ['work', 'hire']
export type AgentState = 'created' | 'upgraded' | 'grants-live' | 'registered' | 'active' | 'revoked'
export interface AgentRow {
  id: string
  operator: Address
  privy_user_id: string
  privy_wallet_id: string | null
  address: Address | null
  name: string
  registry: Address
  agent_id: string | null
  chain_id: number
  state: AgentState
  last_activity_at: number | null
  permissions_json: string
  onboarding_json: string
  revoke_json: string
  created_at: number
  updated_at: number
}

export type AgentOperationStage = 'intent' | 'prepared' | 'signed' | 'approval' | 'sending' | 'confirmed' | 'failed'
export interface AgentOperationRow {
  id: Hex
  agent_id: string
  action_key: string
  board_id: string
  tool: string
  args_hash: Hex
  stage: AgentOperationStage
  intent_json: string
  prepared_json: string | null
  signatures_json: string
  sponsor_operation_id: string | null
  result_json: string | null
  created_at: number
  updated_at: number
}

export interface ApprovalRow {
  id: string
  agent_id: string
  operation_id: string
  kind: 'hire-over-limit' | 'unstake' | 'permission' | 'role'
  status: 'pending' | 'approved' | 'rejected' | 'executed'
  request_json: string
  decision_json: string | null
  created_at: number
  decided_at: number | null
}

/** JSON primitives only; key order cannot change the operation identity. */
export function canonicalAgentArgs(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalAgentArgs).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error('Agent arguments must be plain JSON objects')
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalAgentArgs(object[key])}`)
      .join(',')}}`
  }
  throw new Error('Agent arguments must be finite JSON')
}

/** The agent's roles, from `permissions_json`. Anything unreadable grants none. */
export function agentRoles(row: Pick<AgentRow, 'permissions_json'>): AgentRole[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.permissions_json)
  } catch {
    return []
  }
  if (!(parsed instanceof Object) || Array.isArray(parsed)) return []
  const flags = Object.fromEntries(Object.entries(parsed))
  return AGENT_ROLES.filter((role) => flags[role] === true)
}

/** An agent operation's id: the same agent and operationKey always name the same operation. */
export function agentOperationId(agentId: string, key: string): Hex {
  return keccak256(stringToHex(JSON.stringify([agentId, key])))
}

const transitions: Readonly<Record<AgentState, readonly AgentState[]>> = {
  created: ['upgraded', 'grants-live', 'revoked'],
  upgraded: ['grants-live', 'revoked'],
  'grants-live': ['registered', 'revoked'],
  registered: ['active', 'revoked'],
  active: ['revoked'],
  revoked: [],
}

export class AgentStore {
  constructor(
    readonly sql: Sql,
    readonly now: () => number,
  ) {
    migrateAgentSchema(sql)
  }

  get(id: string): AgentRow {
    const row = this.sql.all<AgentRow>('SELECT * FROM agents WHERE id=?', id)[0]
    if (!row) throw new Error('Agent not found')
    return row
  }

  owned(id: string, operator: string): AgentRow {
    const row = this.get(id)
    if (row.operator.toLowerCase() !== operator.toLowerCase()) throw new Error('Agent belongs to another operator')
    return row
  }

  list(operator: string): AgentRow[] {
    return this.sql.all<AgentRow>('SELECT * FROM agents WHERE operator=? ORDER BY created_at', operator.toLowerCase())
  }

  create(input: {
    id: string
    operator: Address
    privyUserId: string
    name: string
    registry: Address
    chainId: number
  }): AgentRow {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.id) || input.name.trim().length < 1 || input.name.trim().length > 80)
      throw new Error('Invalid agent identity')
    const prior = this.sql.all<AgentRow>('SELECT * FROM agents WHERE id=?', input.id)[0]
    if (prior) {
      if (
        prior.operator.toLowerCase() !== input.operator.toLowerCase() ||
        prior.privy_user_id !== input.privyUserId ||
        prior.chain_id !== input.chainId ||
        prior.registry.toLowerCase() !== input.registry.toLowerCase() ||
        prior.name !== input.name.trim()
      )
        throw new Error('Agent creation key changed')
      return prior
    }
    this.sql.run(
      `INSERT INTO agents (id,operator,privy_user_id,name,registry,chain_id,state,permissions_json,onboarding_json,revoke_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'created','{"work":true,"hire":true}','{}','{}',?,?)`,
      input.id,
      input.operator.toLowerCase(),
      input.privyUserId,
      input.name.trim(),
      input.registry.toLowerCase(),
      input.chainId,
      this.now(),
      this.now(),
    )
    return this.get(input.id)
  }

  rename(id: string, name: string): AgentRow {
    const normalized = name.trim()
    if (normalized.length < 1 || normalized.length > 80) throw new Error('Invalid agent name')
    this.get(id)
    this.sql.run('UPDATE agents SET name=?,updated_at=? WHERE id=?', normalized, this.now(), id)
    return this.get(id)
  }

  bindWallet(id: string, walletId: string, address: Address): AgentRow {
    const row = this.get(id)
    if (
      row.privy_wallet_id &&
      (row.privy_wallet_id !== walletId || row.address?.toLowerCase() !== address.toLowerCase())
    )
      throw new Error('Agent wallet binding cannot change')
    this.sql.run(
      'UPDATE agents SET privy_wallet_id=?,address=?,updated_at=? WHERE id=?',
      walletId,
      address.toLowerCase(),
      this.now(),
      id,
    )
    return this.get(id)
  }

  advance(id: string, state: AgentState): AgentRow {
    const row = this.get(id)
    if (row.state === state) return row
    if (!transitions[row.state].includes(state)) throw new Error('Invalid agent state transition')
    this.sql.run('UPDATE agents SET state=?,updated_at=? WHERE id=?', state, this.now(), id)
    return this.get(id)
  }

  updateOnboarding(id: string, value: Record<string, unknown>): void {
    this.sql.run(
      'UPDATE agents SET onboarding_json=?,updated_at=? WHERE id=?',
      canonicalAgentArgs(value),
      this.now(),
      id,
    )
  }

  bindRegistry(id: string, agentId: string): void {
    if (!/^[1-9][0-9]*$/.test(agentId)) throw new Error('Invalid registry identity')
    const row = this.get(id)
    if (row.agent_id && row.agent_id !== agentId) throw new Error('Registry identity cannot change')
    this.sql.run('UPDATE agents SET agent_id=?,updated_at=? WHERE id=?', agentId, this.now(), id)
  }

  roles(id: string): AgentRole[] {
    return agentRoles(this.get(id))
  }

  setRoles(id: string, roles: readonly AgentRole[]): AgentRole[] {
    this.get(id)
    this.sql.run(
      'UPDATE agents SET permissions_json=?,updated_at=? WHERE id=?',
      canonicalAgentArgs({ hire: roles.includes('hire'), work: roles.includes('work') }),
      this.now(),
      id,
    )
    return this.roles(id)
  }

  addRole(id: string, role: AgentRole): AgentRole[] {
    return this.setRoles(id, [...this.roles(id), role])
  }

  touch(id: string): void {
    this.sql.run('UPDATE agents SET last_activity_at=? WHERE id=?', this.now(), id)
  }

  /** When each active, registered agent last used its connection, with the wallet it acts from. At most 100 IDs. */
  lastActivity(
    chainId: number,
    registry: Address,
    agentIds: readonly string[],
  ): Array<{ agent_id: string; address: Address; last_activity_at: number }> {
    const ids = agentIds.filter((id) => /^[1-9][0-9]*$/.test(id)).slice(0, 100)
    if (ids.length === 0) return []
    return this.sql.all(
      `SELECT agent_id, address, last_activity_at FROM agents WHERE chain_id=? AND registry=? AND state='active'
      AND address IS NOT NULL AND last_activity_at IS NOT NULL AND agent_id IN (${ids.map(() => '?').join(',')})`,
      chainId,
      registry.toLowerCase(),
      ...ids,
    )
  }

  /** The active, registered hosted agents acting from these wallets, with their operators. At most 90 addresses. */
  activeByAddress(
    chainId: number,
    registry: Address,
    addresses: readonly Address[],
  ): Array<{ agent_id: string; address: Address; operator: Address }> {
    const wallets = [...new Set(addresses.map((a) => a.toLowerCase()))].slice(0, 90)
    if (wallets.length === 0) return []
    return this.sql.all(
      `SELECT agent_id, address, operator FROM agents WHERE chain_id=? AND registry=? AND state='active'
      AND address IS NOT NULL AND agent_id IS NOT NULL AND address IN (${wallets.map(() => '?').join(',')})`,
      chainId,
      registry.toLowerCase(),
      ...wallets,
    )
  }

  begin(id: string, key: string, boardId: string, tool: string, args: Record<string, unknown>): AgentOperationRow {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(key))
      throw new AgentFailure(
        'invalid',
        'Every agent action requires a stable operationKey (1-128 letters, digits, _ or -)',
        'operation-key',
        'new-key',
      )
    if (this.get(id).state === 'revoked')
      throw new AgentFailure('forbidden', 'Agent access is revoked', 'agent-revoked', 'none')
    const intent = canonicalAgentArgs(args)
    const hash = keccak256(stringToHex(intent))
    const operationId = agentOperationId(id, key)
    const prior = this.sql.all<AgentOperationRow>('SELECT * FROM agent_operations WHERE id=?', operationId)[0]
    if (prior) {
      if (prior.board_id !== boardId || prior.tool !== tool || prior.args_hash !== hash)
        throw new AgentFailure(
          'conflict',
          'This operationKey already names a different action; use a new key for a new action',
          'operation-key-reused',
          'new-key',
        )
      return prior
    }
    this.sql.run(
      `INSERT INTO agent_operations (id,agent_id,action_key,board_id,tool,args_hash,stage,intent_json,signatures_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'intent',?,'{}',?,?)`,
      operationId,
      id,
      key,
      boardId,
      tool,
      hash,
      intent,
      this.now(),
      this.now(),
    )
    return this.operation(operationId)
  }

  operation(id: string): AgentOperationRow {
    const row = this.sql.all<AgentOperationRow>('SELECT * FROM agent_operations WHERE id=?', id)[0]
    if (!row) throw new Error('Agent operation not found')
    return row
  }

  saveOperation(
    id: string,
    stage: AgentOperationStage,
    fields: { prepared?: unknown; signatures?: unknown; sponsorOperationId?: string; result?: unknown } = {},
  ): AgentOperationRow {
    const row = this.operation(id)
    const allowed: Readonly<Record<AgentOperationStage, readonly AgentOperationStage[]>> = {
      intent: ['intent', 'prepared', 'signed', 'approval', 'sending', 'failed'],
      prepared: ['prepared', 'signed', 'approval', 'sending', 'failed'],
      signed: ['signed', 'approval', 'sending', 'failed'],
      approval: ['approval', 'prepared', 'signed', 'sending', 'failed'],
      sending: ['sending', 'confirmed', 'failed'],
      confirmed: ['confirmed'],
      failed: ['failed'],
    }
    if (!allowed[row.stage].includes(stage))
      throw new Error(`Agent operation cannot move from ${row.stage} to ${stage}`)
    const prepared = fields.prepared === undefined ? row.prepared_json : canonicalAgentArgs(fields.prepared)
    if (row.prepared_json !== null && prepared !== row.prepared_json)
      throw new Error('Prepared operation cannot change')
    const signatures = fields.signatures === undefined ? row.signatures_json : canonicalAgentArgs(fields.signatures)
    const priorSignatures = JSON.parse(row.signatures_json) as Record<string, unknown>
    const nextSignatures = JSON.parse(signatures) as Record<string, unknown>
    for (const key of Object.keys(priorSignatures)) {
      if (
        !Object.hasOwn(nextSignatures, key) ||
        canonicalAgentArgs(priorSignatures[key]) !== canonicalAgentArgs(nextSignatures[key])
      )
        throw new Error('Persisted signature cannot change')
    }
    if (
      row.sponsor_operation_id !== null &&
      fields.sponsorOperationId !== undefined &&
      fields.sponsorOperationId !== row.sponsor_operation_id
    )
      throw new Error('Sponsor operation cannot change')
    const result = fields.result === undefined ? row.result_json : canonicalAgentArgs(fields.result)
    if (row.result_json !== null && result !== row.result_json) throw new Error('Operation result cannot change')
    this.sql.run(
      'UPDATE agent_operations SET stage=?,prepared_json=?,signatures_json=?,sponsor_operation_id=?,result_json=?,updated_at=? WHERE id=?',
      stage,
      prepared,
      signatures,
      fields.sponsorOperationId ?? row.sponsor_operation_id,
      result,
      this.now(),
      id,
    )
    return this.operation(id)
  }

  step<T>(operationId: string, name: string): T | undefined {
    const row = this.sql.all<{ value_json: string }>(
      'SELECT value_json FROM agent_operation_steps WHERE operation_id=? AND name=?',
      operationId,
      name,
    )[0]
    return row === undefined ? undefined : (JSON.parse(row.value_json) as T)
  }

  freezeStep<T>(operationId: string, name: string, value: T): T {
    this.operation(operationId)
    const json = canonicalAgentArgs(value)
    this.sql.run('INSERT OR IGNORE INTO agent_operation_steps VALUES (?,?,?)', operationId, name, json)
    const stored = this.step<T>(operationId, name)!
    if (canonicalAgentArgs(stored) !== json) throw new Error('Frozen operation step cannot change')
    return stored
  }

  requestApproval(operation: AgentOperationRow, kind: ApprovalRow['kind'], request: unknown): ApprovalRow {
    this.sql.run(
      `INSERT OR IGNORE INTO approvals (id,agent_id,operation_id,kind,status,request_json,created_at)
      VALUES (?,?,?,?,'pending',?,?)`,
      operation.id,
      operation.agent_id,
      operation.id,
      kind,
      canonicalAgentArgs(request),
      this.now(),
    )
    this.saveOperation(operation.id, 'approval')
    return this.approval(operation.id)
  }

  approval(id: string): ApprovalRow {
    const row = this.sql.all<ApprovalRow>('SELECT * FROM approvals WHERE id=?', id)[0]
    if (!row) throw new Error('Approval not found')
    return row
  }

  approvals(operator: Address): ApprovalRow[] {
    return this.sql.all<ApprovalRow>(
      'SELECT approvals.* FROM approvals JOIN agents ON agents.id=approvals.agent_id WHERE agents.operator=? ORDER BY created_at DESC',
      operator.toLowerCase(),
    )
  }

  decide(id: string, operator: Address, approved: boolean, decision: unknown): ApprovalRow {
    const row = this.approval(id)
    this.owned(row.agent_id, operator)
    if (row.status !== 'pending') return row
    this.sql.run(
      'UPDATE approvals SET status=?,decision_json=?,decided_at=? WHERE id=?',
      approved ? 'approved' : 'rejected',
      canonicalAgentArgs(decision),
      this.now(),
      id,
    )
    return this.approval(id)
  }

  reopenApproval(id: string): ApprovalRow {
    const row = this.approval(id)
    const operation = this.operation(row.operation_id)
    if (
      row.status !== 'approved' ||
      row.kind !== 'hire-over-limit' ||
      operation.sponsor_operation_id !== null ||
      operation.stage === 'sending' ||
      operation.stage === 'confirmed' ||
      operation.stage === 'failed'
    )
      throw new Error('Only an approved unsent hire can return to review')
    const decision = JSON.parse(row.decision_json!) as { allowanceHash: Hex }
    if (this.sql.atomic === undefined) throw new Error('Approval recovery requires atomic storage')
    this.sql.atomic(() => {
      this.freezeStep(operation.id, `operator-decision:${decision.allowanceHash}`, {
        decision,
        decidedAt: row.decided_at,
      })
      this.sql.run("UPDATE approvals SET status='pending',decision_json=NULL,decided_at=NULL WHERE id=?", id)
      this.saveOperation(operation.id, 'approval')
    })
    return this.approval(id)
  }
}
