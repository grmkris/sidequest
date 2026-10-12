/** Hosted account execution adapter; the relay executor keeps its legacy path. */
import * as sdk from '@sidequest/sdk'
import type { Address, Hex } from 'viem'
import { AgentFailure } from './agent-failure.ts'
import type { AgentStore, AgentOperationRow } from './agents.ts'
import type { GrantStore } from './grants.ts'
import { buildAgentBatch, type AgentBatchScope } from './agent-batch.ts'
import type { ApprovedAgentAction } from './agent-call-mapper.ts'
import type { AgentExecuteResult, AgentPreparedCall } from './agent-executor.ts'
import type { UserOpSubmitter, UserOpResult } from './userop-desk.ts'
interface FrozenUserOpBatch {
  readonly calls: readonly { readonly to: Address; readonly value: string; readonly data: Hex }[]
  readonly evidenceCall?: { readonly to: Address; readonly value: string; readonly data: Hex }
}

export class AgentUserOps {
  constructor(
    readonly deps: {
      readonly agents: AgentStore
      readonly grants: GrantStore
      readonly submitter?: UserOpSubmitter
      readonly context: sdk.Ctx
      readonly now: () => number
      readonly finish: (
        operation: AgentOperationRow,
        address: Address,
        sent: UserOpResult,
      ) => Promise<AgentExecuteResult>
    },
  ) {}

  async resume(operation: AgentOperationRow, address: Address): Promise<AgentExecuteResult | undefined> {
    const frozen = this.deps.agents.step<FrozenUserOpBatch>(operation.id, 'userop-batch')
    if (frozen === undefined) return undefined
    return this.#submit(operation, address, frozen)
  }
  async #submit(
    operation: AgentOperationRow,
    address: Address,
    frozen: FrozenUserOpBatch,
  ): Promise<AgentExecuteResult> {
    const submitter = this.deps.submitter
    if (submitter === undefined)
      throw new AgentFailure(
        'unavailable',
        'This operation requires the user-operation desk',
        'aa-unavailable',
        'same-key',
      )
    const calls = frozen.calls.map((call) => ({ ...call, value: BigInt(call.value) }))
    const evidenceCall =
      frozen.evidenceCall === undefined
        ? undefined
        : { ...frozen.evidenceCall, value: BigInt(frozen.evidenceCall.value) }
    const sent = await submitter.submit({
      id: operation.id,
      agentId: operation.agent_id,
      calls,
      ...(evidenceCall === undefined ? {} : { evidenceCall }),
    })
    // Dropped is retryable on its original nonce; it must never make the agent operation terminal.
    if (sent.status === 'dropped') return { status: 'dropped', operationId: operation.id, result: sent }
    return this.deps.finish(this.deps.agents.operation(operation.id), address, sent)
  }

  async send(
    operation: AgentOperationRow,
    address: Address,
    transactions: readonly sdk.TxRequest[],
    approved: ApprovedAgentAction,
  ): Promise<AgentExecuteResult> {
    const submitter = this.deps.submitter
    if (submitter === undefined)
      throw new AgentFailure(
        'unavailable',
        'This operation requires the user-operation desk',
        'aa-unavailable',
        'same-key',
      )
    await submitter.ready(operation.agent_id)
    const agent = this.deps.agents.get(operation.agent_id)
    const action = this.deps.agents.step<AgentPreparedCall>(operation.id, 'action')!
    const evidenceCall =
      action.evidenceAttestation == null
        ? undefined
        : sdk.attachEvidenceCall(this.deps.context, action.evidenceAttestation)
    const scope: AgentBatchScope = {
      context: this.deps.context,
      grants: this.deps.grants,
      agent: { address, operator: agent.operator, agent_id: agent.agent_id },
      operationId: operation.id,
      now: this.deps.now(),
      agentSweep: this.deps.context.deployment.agentSweep,
      ...(evidenceCall === undefined ? {} : { evidenceCall }),
    }
    const batch = await buildAgentBatch(scope, transactions, approved)
    if (batch.approval !== undefined) {
      if (approved.allowanceHash !== undefined)
        throw new AgentFailure(
          'conflict',
          'The approved exact allowance is unavailable',
          'allowance-unavailable',
          'after-operator',
        )
      const approval = this.deps.agents.requestApproval(
        this.deps.agents.operation(operation.id),
        'hire-over-limit',
        batch.approval,
      )
      return { status: 'approval', operationId: operation.id, approval }
    }
    const frozen = this.deps.agents.freezeStep<FrozenUserOpBatch>(operation.id, 'userop-batch', {
      calls: batch.calls.map((call) => ({ ...call, value: call.value.toString() })),
      ...(evidenceCall === undefined
        ? {}
        : { evidenceCall: { ...evidenceCall, value: evidenceCall.value.toString() } }),
    })
    this.deps.agents.saveOperation(operation.id, 'sending')
    return this.#submit(operation, address, frozen)
  }
}
