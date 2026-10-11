/** Execute a hosted agent action from one frozen intent, signing request and relay journal. */
import * as sdk from '@sidequest/sdk'
import { type Address, type Hex, keccak256, stringToHex } from 'viem'
import { AgentStore, canonicalAgentArgs, type AgentOperationRow, type AgentRow, type ApprovalRow } from './agents.ts'
import { AgentPermissions, type PermissionApprovalRequest, type PermissionDecision } from './agent-permissions.ts'
import { AgentSigning } from './agent-signing.ts'
import { GrantStore, grantSpecJson, parseGrantSpec } from './grants.ts'
import { ensureAgentGrants } from './agent-grant-renewal.ts'
import { mapAgentCalls, type ApprovedAgentAction } from './agent-call-mapper.ts'
import { SponsorDesk, type NamedSponsorEntry, type SponsorResult } from './sponsor.ts'
import type { Sql } from './store.ts'
import { AgentLifecycle } from './agent-lifecycle.ts'
import { AgentFailure, agentFailureReply } from './agent-failure.ts'
import { AgentX402 } from './agent-x402.ts'
import { x402Deployment } from './x402.ts'

export interface AgentPreparedCall {
  readonly transactions?: readonly sdk.TxRequest[]
  readonly sign?: { readonly typedData: string; readonly description?: string }
  readonly [key: string]: unknown
}

export interface AgentToolRequest {
  readonly tool: string
  readonly args: Record<string, unknown>
  readonly caller: { readonly address: Address }
}

export interface AgentExecutorDeps {
  readonly sql: Sql
  readonly now: () => number
  readonly context: sdk.Ctx
  readonly sponsor: SponsorDesk
  readonly signing: AgentSigning
  readonly prepareTool: (request: AgentToolRequest) => Promise<AgentPreparedCall>
  /** Hosted storage must be verified even when the action was frozen before a restart. */
  readonly verifyAction?: (action: AgentPreparedCall) => Promise<void>
  readonly verifyToolSigning: (request: AgentToolRequest & { typedData: string }) => Promise<string>
}

export interface AgentExecuteInput {
  readonly agentId: string
  readonly boardId: string
  readonly operationKey: string
  readonly tool: string
  readonly args: Record<string, unknown>
}

export type AgentExecuteResult =
  | { readonly status: 'confirmed' | 'rejected'; readonly operationId: Hex; readonly result: unknown }
  | { readonly status: 'approval'; readonly operationId: Hex; readonly approval: ApprovalRow }
  | { readonly status: 'pending' | 'reverted' | 'dropped'; readonly operationId: Hex; readonly result: SponsorResult }

function publicOutput(output: AgentPreparedCall): Record<string, unknown> {
  const { sign: _sign, transactions: _transactions, next: _next, ...result } = output
  return result
}

function jsonOutput(output: AgentPreparedCall): AgentPreparedCall {
  return JSON.parse(
    JSON.stringify(output, (_, value) => (typeof value === 'bigint' ? value.toString() : value)),
  ) as AgentPreparedCall
}

export class AgentExecutor {
  readonly agents: AgentStore
  readonly grants: GrantStore
  #queue: Promise<unknown> = Promise.resolve()

  constructor(readonly deps: AgentExecutorDeps) {
    this.agents = new AgentStore(deps.sql, deps.now)
    this.grants = new GrantStore(deps.sql, deps.context)
  }

  execute(input: AgentExecuteInput): Promise<AgentExecuteResult> {
    const result = this.#queue.then(() => this.#execute(input))
    this.#queue = result.catch(() => undefined)
    return result
  }

  async #finish(operation: AgentOperationRow, address: Address, sent: SponsorResult): Promise<AgentExecuteResult> {
    if (sent.status === 'pending') return { status: 'pending', operationId: operation.id, result: sent }
    if (sent.status !== 'confirmed') {
      this.agents.saveOperation(operation.id, 'failed', { result: sent })
      return { status: sent.status, operationId: operation.id, result: sent }
    }
    const action = this.agents.step<AgentPreparedCall>(operation.id, 'action')!
    const result = { ...publicOutput(action), sponsorship: sent }
    const reported = this.agents.step(operation.id, 'reported')
    if (reported === undefined) {
      if (typeof action.taskId === 'string' || typeof JSON.parse(operation.intent_json).taskId === 'string') {
        const taskId = action.taskId ?? JSON.parse(operation.intent_json).taskId
        await this.deps.prepareTool({
          tool: 'report_transaction',
          args: { taskId, txHash: sent.txHash },
          caller: { address },
        })
      }
      if (typeof action.operationId === 'string') {
        await this.deps.prepareTool({
          tool: 'report_operation',
          args: { operationId: action.operationId, txHash: sent.txHash },
          caller: { address },
        })
      }
      this.agents.freezeStep(operation.id, 'reported', true)
    }
    const selection = await this.#selectInvited(operation, action)
    const confirmed = selection === undefined ? result : { ...result, selection }
    this.agents.saveOperation(operation.id, 'confirmed', { result: confirmed })
    this.deps.sql.run("UPDATE approvals SET status='executed' WHERE operation_id=? AND status='approved'", operation.id)
    return { status: 'confirmed', operationId: operation.id, result: confirmed }
  }

  /**
   * A confirmed publish that names its worker (create_task with an invite, or pick_quote) continues to select_worker
   * under a key derived from the publish key, so one call hires. It runs #execute directly: this is already inside
   * the queue, and a queued execute would wait on itself. A retry of the publish key reaches the same derived
   * operation. Selection never fails the publish; its failure comes back with the call to make instead.
   */
  async #selectInvited(
    operation: AgentOperationRow,
    action: AgentPreparedCall,
  ): Promise<Record<string, unknown> | undefined> {
    if (
      (operation.tool !== 'create_task' && operation.tool !== 'pick_quote') ||
      typeof action.taskId !== 'string' ||
      typeof action.applicationId !== 'string'
    )
      return undefined
    const args = { taskId: action.taskId, applicationId: action.applicationId }
    const key =
      operation.action_key.length <= 124
        ? `${operation.action_key}-sel`
        : `sel-${keccak256(stringToHex(operation.action_key)).slice(2, 62)}`
    // Retrying with this exact key resumes the same selection instead of signing a second one.
    const next = { tool: 'select_worker', args: { ...args, operationKey: key } }
    try {
      const selected = await this.#execute({
        agentId: operation.agent_id,
        boardId: operation.board_id,
        operationKey: key,
        tool: 'select_worker',
        args,
      })
      return {
        status: selected.status,
        operationId: selected.operationId,
        ...(selected.status === 'confirmed' ? { result: selected.result } : { next }),
      }
    } catch (error) {
      const { ok: _ok, ...failure } = agentFailureReply(error, 'Selecting the named worker failed')
      return { status: 'failed', ...failure, next }
    }
  }

  async #approved(operation: AgentOperationRow): Promise<ApprovedAgentAction> {
    const approval = this.agents.approval(operation.id)
    if (approval.status !== 'approved')
      throw new AgentFailure(
        'conflict',
        "This action waits for the operator's decision",
        'approval-required',
        'after-operator',
      )
    const agent = this.agents.get(operation.agent_id)
    const request = JSON.parse(approval.request_json) as { token: Address; amount: string; shares?: string }
    const decision = JSON.parse(approval.decision_json ?? '{}') as { allowanceHash: Hex }
    const step = approval.kind === 'unstake' ? 'approved-grant-spec' : `approved-grant-spec:${decision.allowanceHash}`
    let spec = this.agents.step<string>(operation.id, step)
    if (spec === undefined) {
      const base = {
        delegator: agent.address!,
        salt: BigInt(operation.id),
        operationId: operation.id,
        amount: BigInt(request.amount),
      }
      let template: sdk.GrantSpec
      if (approval.kind === 'unstake')
        template = {
          delegator: agent.address!,
          salt: BigInt(operation.id),
          operationId: operation.id,
          kind: 'unstake',
          shares: BigInt(request.shares!),
          start: this.deps.now(),
        }
      else {
        const allowance = this.grants.spec(decision.allowanceHash)
        if (allowance.kind !== 'allowance-once')
          throw new AgentFailure(
            'conflict',
            'Approved hire requires an exact one-off allowance',
            'approval-allowance',
            'after-operator',
          )
        template = { ...base, kind: 'agent-approve-once', start: allowance.start, token: request.token }
      }
      spec = this.agents.freezeStep(operation.id, step, grantSpecJson(template))
    }
    const prepared = this.grants.prepare(agent.operator, parseGrantSpec(spec))
    await this.grants.confirm(prepared.hash, await this.deps.signing.signGrant(agent.id, prepared.hash))
    return approval.kind === 'unstake'
      ? { unstakeHash: prepared.hash }
      : { approvalHash: prepared.hash, allowanceHash: decision.allowanceHash }
  }

  async #action(input: AgentExecuteInput, operation: AgentOperationRow, address: Address): Promise<AgentPreparedCall> {
    const saved = this.agents.step<AgentPreparedCall>(operation.id, 'action')
    if (saved !== undefined) return saved
    let prepared = this.agents.step<AgentPreparedCall>(operation.id, 'prepared')
    if (prepared === undefined) {
      prepared = jsonOutput(
        await this.deps.prepareTool({
          tool: input.tool,
          args: { ...input.args, idempotencyKey: operation.id },
          caller: { address },
        }),
      )
      this.agents.freezeStep(operation.id, 'prepared', prepared)
      this.agents.saveOperation(operation.id, 'prepared', { prepared })
    }
    let action = prepared
    if (prepared.sign !== undefined) {
      const typedData = prepared.sign.typedData
      const signature = await this.deps.signing.signTool(input.agentId, operation.id, typedData, () =>
        this.deps.verifyToolSigning({ tool: input.tool, args: input.args, caller: { address }, typedData }),
      )
      this.agents.saveOperation(operation.id, 'signed', { signatures: { primary: signature } })
      let args: Record<string, unknown>
      let tool: string
      if (input.tool === 'select_worker') {
        tool = 'submit_selection'
        args = { ...input.args, nonce: JSON.parse(typedData).message.nonce, signature }
      } else if (input.tool === 'prepare_activation') {
        tool = 'build_activation'
        args = { ...input.args, budgetSignature: signature }
      } else throw new Error('Signing tool has no authorized continuation')
      action = jsonOutput(await this.deps.prepareTool({ tool, args, caller: { address } }))
    }
    return this.agents.freezeStep(operation.id, 'action', action)
  }

  /**
   * request_permissions sends nothing. A live standing rule that covers the request grants it at once; otherwise the
   * operator decides in Explore, and the approved retry returns the permission the operator signed.
   */
  async #permission(operationId: Hex, agent: AgentRow, action: AgentPreparedCall): Promise<AgentExecuteResult> {
    const permissions = new AgentPermissions({ sql: this.deps.sql, context: this.deps.context, now: this.deps.now })
    const current = this.agents.operation(operationId)
    let hash: Hex
    let granted: 'operator' | 'standing-rule' = 'operator'
    if (current.stage === 'approval') {
      const decision = JSON.parse(
        this.agents.approval(operationId).decision_json ?? '{}',
      ) as Partial<PermissionDecision>
      if (typeof decision.permissionHash !== 'string')
        throw new Error('The approved permission is missing its signed template')
      hash = decision.permissionHash
    } else {
      const request = action.request as PermissionApprovalRequest
      const covered = await permissions.covering(agent, request)
      if (covered === undefined)
        return {
          status: 'approval',
          operationId,
          approval: this.agents.requestApproval(current, 'permission', request),
        }
      hash = covered.delegation_hash
      granted = 'standing-rule'
    }
    const result = { ...permissions.response(hash), granted }
    this.agents.saveOperation(operationId, 'sending')
    this.agents.saveOperation(operationId, 'confirmed', { result })
    this.deps.sql.run("UPDATE approvals SET status='executed' WHERE operation_id=? AND status='approved'", operationId)
    return { status: 'confirmed', operationId, result }
  }

  #freezeEntries(operationId: Hex, scope: string, entries: NamedSponsorEntry[]): NamedSponsorEntry[] {
    const prefix = `${scope}:`
    const prior = this.deps.sql
      .all<{ name: string; value_json: string }>(
        // A prefix match by substr, not LIKE: Cloudflare's SQLite refuses LIKE patterns over 50 bytes, and this one carries
        // a 32-byte allowance hash (an approved hire failed on every retry).
        'SELECT name,value_json FROM agent_operation_steps WHERE operation_id=? AND substr(name,1,?)=?',
        operationId,
        prefix.length,
        prefix,
      )
      .filter((step) => /^[1-9][0-9]*$/.test(step.name.slice(prefix.length)))
      .toSorted((left, right) => Number(right.name.slice(prefix.length)) - Number(left.name.slice(prefix.length)))[0]
    const saved = prior === undefined ? undefined : (JSON.parse(prior.value_json) as NamedSponsorEntry[])
    if (saved !== undefined && canonicalAgentArgs(saved) === canonicalAgentArgs(entries)) return saved
    const attempt = prior === undefined ? 1 : Number(prior.name.slice(prefix.length)) + 1
    return this.agents.freezeStep(operationId, `${prefix}${attempt}`, entries)
  }

  async #execute(input: AgentExecuteInput): Promise<AgentExecuteResult> {
    if (input.tool === 'x402_pay') x402Deployment(this.deps.context.deployment)
    const agent = this.agents.get(input.agentId)
    if (
      agent.address === null ||
      agent.privy_wallet_id === null ||
      agent.state !== 'active' ||
      agent.chain_id !== this.deps.context.deployment.chainId
    )
      throw new AgentFailure('forbidden', 'Agent is not active on this chain', 'agent-unavailable', 'none')
    if (
      ['stake', 'request_unstake', 'cancel_unstake', 'withdraw_stake'].includes(input.tool) &&
      input.args.account !== undefined &&
      (typeof input.args.account !== 'string' || input.args.account.toLowerCase() !== agent.address.toLowerCase())
    ) {
      throw new AgentFailure(
        'forbidden',
        'Managed vault actions require the agent own account and position',
        'outside-policy',
        'none',
      )
    }
    const operation = this.agents.begin(input.agentId, input.operationKey, input.boardId, input.tool, input.args)
    if (operation.stage === 'confirmed')
      return { status: 'confirmed', operationId: operation.id, result: JSON.parse(operation.result_json!) }
    if (operation.sponsor_operation_id !== null) {
      // Resume the original signed send before preparing calls, renewing grants or calling the routine signer.
      const sent = await this.deps.sponsor.submit(agent.address, [], operation.action_key)
      return this.#finish(operation, agent.address, sent)
    }
    // A declined approval answers the same on every retry, so a client that retries an uncertain call learns it again.
    const declined = this.deps.sql.all<ApprovalRow>(
      "SELECT * FROM approvals WHERE id=? AND status='rejected'",
      operation.id,
    )[0]
    if (operation.stage === 'failed' && declined !== undefined)
      return { status: 'rejected', operationId: operation.id, result: declined }
    if (operation.stage === 'failed')
      throw new AgentFailure(
        'conflict',
        'This operation is terminal; inspect it with check_operation, or start a new action with a new operationKey',
        'operation-terminal',
        'new-key',
      )
    if (input.tool === 'x402_pay') {
      const saved = this.agents.step<Awaited<ReturnType<AgentX402['pay']>>>(operation.id, 'x402-result')
      const result =
        saved ?? this.agents.freezeStep(operation.id, 'x402-result', await new AgentX402(this.deps).pay(operation))
      if (operation.stage !== 'sending') {
        this.agents.saveOperation(operation.id, 'signed', { signatures: { primary: result.payload.payload.signature } })
        this.agents.saveOperation(operation.id, 'sending')
      }
      this.agents.saveOperation(operation.id, 'confirmed', { result })
      return { status: 'confirmed', operationId: operation.id, result }
    }
    if (operation.stage === 'sending') {
      const action = this.agents.step<AgentPreparedCall>(operation.id, 'action')
      if (action === undefined || (action.transactions?.length ?? 0) !== 0)
        throw new Error('Sending operation is missing its relay link')
      const result = publicOutput(action)
      this.agents.saveOperation(operation.id, 'confirmed', { result })
      return { status: 'confirmed', operationId: operation.id, result }
    }
    let approved: ApprovedAgentAction = {}
    if (operation.stage === 'approval') {
      const approval = new AgentLifecycle({
        sql: this.deps.sql,
        context: this.deps.context,
        now: this.deps.now,
        sponsor: this.deps.sponsor,
      }).recoverApproval(operation.id, agent.operator)
      if (approval.status === 'pending') return { status: 'approval', operationId: operation.id, approval }
      if (approval.status === 'rejected') {
        this.agents.saveOperation(operation.id, 'failed', { result: approval })
        return { status: 'rejected', operationId: operation.id, result: approval }
      }
    }
    await this.deps.sponsor.ready()
    const action = await this.#action(input, operation, agent.address)
    if (input.tool === 'request_permissions') return this.#permission(operation.id, agent, action)
    await this.deps.verifyAction?.(action)
    if (input.tool === 'request_unstake' && this.agents.operation(operation.id).stage !== 'approval') {
      const call = action.transactions?.[0]
      if (
        call === undefined ||
        action.transactions?.length !== 1 ||
        typeof action.amount !== 'string' ||
        typeof action.shares !== 'string'
      )
        throw new Error('Unstake preparation requires its exact single vault call')
      const approval = this.agents.requestApproval(this.agents.operation(operation.id), 'unstake', {
        amount: action.amount,
        shares: action.shares,
        call,
      })
      return { status: 'approval', operationId: operation.id, approval }
    }
    if (this.agents.operation(operation.id).stage === 'approval') approved = await this.#approved(operation)
    const transactions = action.transactions ?? []
    if (transactions.length === 0) {
      const result = publicOutput(action)
      this.agents.saveOperation(operation.id, 'sending')
      this.agents.saveOperation(operation.id, 'confirmed', { result })
      return { status: 'confirmed', operationId: operation.id, result }
    }
    const entriesStep = approved.allowanceHash === undefined ? 'entries' : `entries:${approved.allowanceHash}`
    // No sponsor link means there are no signed relay bytes. Recheck gas authority on every such retry;
    // the economic calls stay frozen, while old mappings remain available for audit.
    await ensureAgentGrants(
      this.deps.context,
      this.agents,
      this.grants,
      this.deps.signing,
      agent.id,
      operation.id,
      this.deps.now(),
    )
    const mapped = await mapAgentCalls(
      this.deps.context,
      this.grants,
      { address: agent.address, operator: agent.operator },
      transactions,
      this.deps.now(),
      approved,
    )
    if (mapped.approval !== undefined) {
      if (approved.allowanceHash !== undefined)
        throw new AgentFailure(
          'conflict',
          'The approved exact allowance is unavailable; this operation has not been sent',
          'allowance-unavailable',
          'after-operator',
        )
      const approval = this.agents.requestApproval(
        this.agents.operation(operation.id),
        'hire-over-limit',
        mapped.approval,
      )
      return { status: 'approval', operationId: operation.id, approval }
    }
    const entries = this.#freezeEntries(operation.id, entriesStep, mapped.entries)
    const sent = await this.deps.sponsor.submit(agent.address, entries, operation.action_key, operation.id)
    return this.#finish(this.agents.operation(operation.id), agent.address, sent)
  }
}
