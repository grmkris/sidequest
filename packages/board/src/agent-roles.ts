/** An agent asks its operator for Work or Hire; only the operator's approval adds the role (ADR-0021). */
import type { Address } from 'viem'
import type { AgentExecuteResult } from './agent-executor.ts'
import { AGENT_ROLES, type AgentRole, type AgentRow, type AgentStore, type ApprovalRow } from './agents.ts'

export interface RoleRequest {
  readonly role: AgentRole
  readonly reason?: string
}

export class AgentRoles {
  constructor(readonly agents: AgentStore) {}

  /** Idempotent per operationKey: a held role confirms at once, otherwise the operator's approval is asked once. */
  request(agent: AgentRow, boardId: string, key: string, input: RoleRequest): AgentExecuteResult {
    const operation = this.agents.begin(agent.id, key, boardId, 'request_role', { ...input })
    if (operation.stage === 'confirmed')
      return { status: 'confirmed', operationId: operation.id, result: JSON.parse(operation.result_json!) }
    if (operation.stage === 'failed')
      return { status: 'rejected', operationId: operation.id, result: this.agents.approval(operation.id) }
    const held = this.agents.roles(agent.id).includes(input.role)
    if (operation.stage === 'approval') {
      const approval = this.agents.approval(operation.id)
      if (approval.status === 'rejected') return { status: 'rejected', operationId: operation.id, result: approval }
      if (!held) return { status: 'approval', operationId: operation.id, approval }
      // The operator granted the role on the agent page meanwhile: the request is answered.
      this.agents.sql.run(
        "UPDATE approvals SET status='executed',decided_at=? WHERE id=? AND status='pending'",
        this.agents.now(),
        approval.id,
      )
    }
    if (held) return this.#confirm(operation.id, agent.id, input.role)
    return {
      status: 'approval',
      operationId: operation.id,
      approval: this.agents.requestApproval(operation, 'role', input),
    }
  }

  /** The operator's answer, in one transaction: an approval adds the role and confirms the agent's request. */
  decide(approval: ApprovalRow, operator: Address, approved: boolean): ApprovalRow {
    // SAFETY: request() stores exactly a RoleRequest as the approval's request.
    const { role } = JSON.parse(approval.request_json) as RoleRequest
    if (!AGENT_ROLES.includes(role)) throw new Error('This role request is unreadable')
    if (this.agents.sql.atomic === undefined) throw new Error('Role approval requires atomic storage')
    return this.agents.sql.atomic(() => {
      const decided = this.agents.decide(approval.id, operator, approved, {})
      if (decided.status !== (approved ? 'approved' : 'rejected')) return decided
      if (!approved) {
        this.agents.saveOperation(approval.operation_id, 'failed')
        return decided
      }
      this.agents.addRole(approval.agent_id, role)
      this.agents.sql.run("UPDATE approvals SET status='executed' WHERE id=?", approval.id)
      this.#confirm(this.agents.operation(approval.operation_id).id, approval.agent_id, role)
      return this.agents.approval(approval.id)
    })
  }

  #confirm(operationId: AgentExecuteResult['operationId'], agentId: string, role: AgentRole): AgentExecuteResult {
    const result = { role, roles: this.agents.roles(agentId) }
    this.agents.saveOperation(operationId, 'sending')
    this.agents.saveOperation(operationId, 'confirmed', { result })
    return { status: 'confirmed', operationId, result }
  }
}
