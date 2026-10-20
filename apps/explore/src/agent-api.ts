import { agentEndpoint, type ManagedAgent } from './api.ts'

interface GasAllowanceStatus {
  hash: string
  status: string
  token: string
  limit: string
  left: string
  used: string
  periodSeconds: number
  periodStart: number
  periodEnd: number
  expiresAt: number
}

export interface AgentStatus {
  /** A live OAuth family proves the coding agent has connected; activity is only presence data. */
  connected: boolean
  agent: ManagedAgent
  gasAllowances?: GasAllowanceStatus[]
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
  /** Frozen operation context, validated by the API from the prepared offer. */
  context?: {
    operationKey: string
    boardId: string
    tool: string
    hire: {
      taskId: string
      title: string
      brief: string
      acceptanceCriteria: string[]
      termsHash: string
      creatorBond: string
    } | null
  }
}

const agentPath = (id: string, action = '') =>
  `/api/agents/${encodeURIComponent(id)}${action === '' ? '' : `/${action}`}`
export const agentStatus = (id: string) => agentEndpoint<AgentStatus>(agentPath(id))
export const agentBalances = (id: string) => agentEndpoint<AgentBalances>(agentPath(id, 'balances'))
export interface AgentBalances {
  wallet: string
  network: string
  chainId: number
  observedAt: number
  blockNumber: string
  blockTimestamp: number
  priceMaxAgeSeconds: number
  index: { next_block: number; updated_at: number } | null
  currencies: Array<{
    token: string | null
    symbol: string | null
    decimals: number | null
    wallet: string | null
    owed: string | null
    amounts: {
      wallet: string | null
      owed: string | null
      escrow: string | null
      paid: string | null
      pending: string | null
    }
    price: { perUnit: number | null; source: string | null; observedAt: number | null; sourceAt?: number | null }
    usd: Record<string, number | null>
  }>
  receipts: Array<{
    token: string
    amount: string
    jobId: string | null
    txHash: string
    block: number
    kind: string
  }> | null
}
export const agentAction = <T>(id: string, action: string, body: Record<string, unknown> = {}) =>
  agentEndpoint<T>(agentPath(id, action), 'POST', body)
