/**
 * An agent's approvals as its Approvals tab shows them: the ones waiting first (full cards), then the decided ones as
 * one-line rows — what was asked, how much, the answer and when — with an executed hire linked to the job it published.
 * Pure, so the summaries are tested apart from the cards.
 */
import * as sdk from '@sidequest/sdk'
import { type Hex, decodeFunctionData } from 'viem'
import type { AgentApproval } from './agent-api.ts'
import { span } from './format.ts'
import { permissionRequest } from './permission-review.ts'

export interface ApprovalLine {
  /** "Hire over the weekly budget", "Leave agent-owned backing", "Recurring transfer"… */
  title: string
  /** The amount asked for, in base units of `token`; null for a contract call. */
  amount: { value: string; token: string } | null
  /** The rest of the line: cadence, recipient, call, expiry. */
  detail: string | null
  status: 'pending' | 'approved' | 'rejected' | 'executed'
  /** When the operator answered (unix seconds); null while pending or for a record from before the field existed. */
  decidedAt: number | null
  createdAt: number | null
  /** The operator narrowed an adjustable permission before granting it. */
  adjusted: boolean
  /** A hire's policy hash (lowercase), the key of the job it published. */
  policyHash: string | null
}

const STATUSES = new Set(['pending', 'approved', 'rejected', 'executed'])
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** The policy hash a hire's frozen `publish` call names (= the published job's `policy_hash`), or null. */
export function publishedPolicyHash(publish: Hex | undefined): string | null {
  if (publish === undefined) return null
  try {
    const decoded = decodeFunctionData({ abi: sdk.sidequestHoldingAbi, data: publish })
    return decoded.functionName === 'publish' ? decoded.args[0].policyHash.toLowerCase() : null
  } catch {
    return null
  }
}

function json<T>(raw: string | null | undefined): T | null {
  if (raw === null || raw === undefined) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function approvalLine(approval: AgentApproval, factory: string): ApprovalLine {
  const status = (STATUSES.has(approval.status) ? approval.status : 'pending') as ApprovalLine['status']
  const base = {
    status,
    decidedAt: approval.decided_at ?? null,
    createdAt: approval.created_at ?? null,
    adjusted: false,
    policyHash: null,
  }
  if (approval.kind === 'permission') {
    try {
      const request = permissionRequest(approval.request_json)
      const t = request.parsed
      const until = `until ${new Date(request.expiry * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
      const adjusted = json<{ adjusted?: boolean }>(approval.decision_json)?.adjusted === true
      if (t.type === 'erc20-token-periodic')
        return {
          ...base,
          adjusted,
          title: 'Recurring transfer',
          amount: { value: t.periodAmount.toString(), token: t.token },
          detail: `every ${span(t.periodDuration)} to ${short(t.recipient)} · ${until}`,
        }
      if (t.type === 'erc20-token-allowance')
        return {
          ...base,
          adjusted,
          title: 'Transfer limit',
          amount: { value: t.amount.toString(), token: t.token },
          detail: `to ${short(t.recipient)} · ${until}`,
        }
      if (t.type === 'sidequest:backer-share')
        return {
          ...base,
          adjusted,
          title: 'Set its backer share',
          amount: null,
          detail: `agent #${t.agentId.toString()} · up to ${t.calls} changes · ${until}`,
        }
      return {
        ...base,
        adjusted,
        title: 'Contract call',
        amount: null,
        detail: `${t.callData.slice(0, 10)} on ${short(t.target)} · ${until}`,
      }
    } catch {
      return { ...base, title: 'Permission', amount: null, detail: 'The request could not be read' }
    }
  }
  const request = json<{ token?: string; amount?: string; publish?: Hex; reason?: string; role?: string }>(
    approval.request_json,
  )
  if (approval.kind === 'role')
    return {
      ...base,
      title: request?.role === 'hire' ? 'Let it hire other agents' : 'Let it take and deliver jobs',
      amount: null,
      detail: request?.reason ?? null,
    }
  if (approval.kind === 'unstake')
    return {
      ...base,
      title: 'Leave agent-owned backing',
      amount: request?.amount === undefined ? null : { value: request.amount, token: factory },
      detail: null,
    }
  return {
    ...base,
    title: request?.reason === 'unknown-token' ? 'Hire in an unlisted token' : 'Hire over the weekly budget',
    amount:
      request?.amount === undefined || request.token === undefined
        ? null
        : { value: request.amount, token: request.token },
    detail: null,
    policyHash: publishedPolicyHash(request?.publish),
  }
}

/**
 * An approved hire or unstake whose operation has not finished: the approval is saved before the operation runs, so a
 * failed run leaves it here until the operator continues it. An approved permission is already granted, so it is history.
 */
export const unfinishedApproval = (approval: Pick<AgentApproval, 'status' | 'kind'>) =>
  approval.status === 'approved' && approval.kind !== 'permission' && approval.kind !== 'role'

/**
 * Waiting decisions, oldest first (they queue); approved operations that did not finish, oldest first (each needs the
 * operator to continue it); then the rest, newest answer first (VV2-032).
 */
export function splitApprovals<T extends AgentApproval>(
  approvals: readonly T[],
): { waiting: T[]; recovering: T[]; past: T[] } {
  const when = (a: T) => a.decided_at ?? a.created_at ?? 0
  const oldest = (a: T, b: T) => (a.created_at ?? 0) - (b.created_at ?? 0)
  return {
    waiting: approvals.filter((a) => a.status === 'pending').toSorted(oldest),
    recovering: approvals.filter(unfinishedApproval).toSorted(oldest),
    past: approvals
      .filter((a) => a.status !== 'pending' && !unfinishedApproval(a))
      .toSorted((a, b) => when(b) - when(a)),
  }
}

/** The job an executed hire published, among the jobs the agent posted. */
export function jobOfLine<J extends { policy_hash?: string | null }>(
  line: Pick<ApprovalLine, 'policyHash' | 'status'>,
  posted: readonly J[] | undefined,
): J | undefined {
  if (line.policyHash === null || line.status !== 'executed') return undefined
  return posted?.find((job) => job.policy_hash?.toLowerCase() === line.policyHash)
}
