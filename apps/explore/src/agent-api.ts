import { agentEndpoint, type ManagedAgent } from './api.ts'
import type { PreparedGrant } from './agent-grant.ts'

export interface AgentStatus {
  /** A live OAuth family proves the coding agent has connected; activity is only presence data. */
  connected: boolean
  agent: ManagedAgent
  allowances: Array<{
    hash: string
    token: string
    limit: string
    left: string
    used: string
    periodEnd: number
    expiresAt: number
  }>
  grants: Array<{ hash: string; kind: string; status: string; expiresAt: number }>
  revocation: {
    hostedAccessStopped?: boolean
    signerRemoved?: boolean
    onchainPermissionsDisabled?: boolean
    receipts?: Array<{ tx_hash: string; status: string }>
  }
}

export interface AgentApproval {
  id: string
  agent_id: string
  operation_id: string
  kind: 'hire-over-limit' | 'unstake' | 'permission' | 'role'
  /** pending, approved, rejected or executed. */
  status: string
  request_json: string
  /** Unix seconds; the operator's answer, when there is one, and when it was given. */
  created_at?: number
  decision_json?: string | null
  decided_at?: number | null
}

const agentPath = (id: string, action = '') =>
  `/api/agents/${encodeURIComponent(id)}${action === '' ? '' : `/${action}`}`
export const agentStatus = (id: string) => agentEndpoint<AgentStatus>(agentPath(id))
export const agentAction = <T>(id: string, action: string, body: Record<string, unknown> = {}) =>
  agentEndpoint<T>(agentPath(id, action), 'POST', body)
export const prepareRegistration = (id: string) => agentAction<PreparedGrant>(id, 'registration-prepare')
