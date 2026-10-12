/**
 * Management feed events (V1.1 WS4): a managed agent's action waiting for its operator, the operator's decision, and a
 * permission granted. The agent reads them in `inbox`; the operator gets one Telegram link to the signing page, which
 * never approves anything by itself. Ids are deterministic, and nothing here ever fails the action that produced it.
 */
import { Option, Schema } from 'effect'
import type { AgentExecuteResult, AgentRow, ApprovalRow } from '@sidequest/board'
import type { AsyncSql } from '@sidequest/indexer'
import type { Network } from '@sidequest/sdk'
import { type FeedEvent, reportFeedFailure, writeFeed } from './feed.ts'
import { enqueueWalletNotification, publicOrigin } from './telegram.ts'

const KIND_WORDS: Record<ApprovalRow['kind'], string> = {
  'hire-over-limit': 'a hire above its weekly allowance',
  unstake: 'an exit from its stake',
  permission: 'a new permission',
  role: 'a new role (Work or Hire)',
}

type Agent = Pick<AgentRow, 'id' | 'name' | 'operator' | 'address' | 'agent_id'>

/** Where the operator reviews and signs: the agent's approvals tab, with this approval in view. */
export function approvalUrl(network: Network, agent: Agent, approvalId: string): string {
  if (agent.agent_id === null) return `${publicOrigin()}/agents`
  return `${publicOrigin()}/agent/${encodeURIComponent(agent.agent_id)}?tab=approvals&approval=${encodeURIComponent(approvalId)}`
}

/** Feed rows plus, for a new approval, the one Telegram message the operator gets. */
export interface AgentEvents {
  readonly events: FeedEvent[]
  readonly operatorNotice?: { readonly id: string; readonly text: string }
}

/** What one agent tool result tells the agent and its operator. */
export function agentFeedEvents(input: {
  network: Network
  agent: Agent
  tool: string
  operationKey: string
  result: AgentExecuteResult
  now: number
}): AgentEvents {
  const { network, agent, tool, operationKey, result, now } = input
  if (agent.address === null) return { events: [] }
  if (result.status === 'approval' && result.approval.status === 'pending') {
    const approval = result.approval,
      url = approvalUrl(network, agent, approval.id),
      words = KIND_WORDS[approval.kind]
    const events: FeedEvent[] = [
      {
        id: `approval:${approval.id}:requested`,
        address: agent.address,
        kind: 'approval.requested',
        role: 'agent',
        url,
        occurredAt: now,
        summary: `${tool} waits for your operator to approve ${words}. Once decided, retry ${tool} with the same arguments and operationKey.`,
        next: { tool, args: { operationKey } },
      },
      {
        id: `approval:${approval.id}:requested:operator`,
        address: agent.operator,
        kind: 'approval.requested',
        role: 'operator',
        url,
        occurredAt: now,
        summary: `${agent.name} asks you to approve ${words}. Review and sign in Explore.`,
      },
    ]
    return {
      events,
      operatorNotice: {
        id: `telegram:approval:${approval.id}`,
        text: `${agent.name} needs your decision: ${words}. Review and sign: ${url}`,
      },
    }
  }
  if (result.status === 'confirmed' && tool === 'request_permissions') {
    const granted = result.result as { permissionId?: unknown; granted?: unknown }
    if (typeof granted.permissionId !== 'string') return { events: [] }
    const byRule = granted.granted === 'standing-rule'
    const event = {
      kind: 'permission.granted',
      occurredAt: now,
      next: { tool: 'use_permission', args: { permissionId: granted.permissionId } },
    }
    return {
      events: [
        {
          ...event,
          id: `permission:${result.operationId}:granted`,
          address: agent.address,
          role: 'agent',
          summary: `Permission ${granted.permissionId} is granted ${byRule ? 'by a standing rule' : 'by your operator'}.`,
        },
        // A standing rule grants silently: no Telegram, but the operator's own feed keeps the record.
        ...(byRule
          ? [
              {
                ...event,
                id: `permission:${result.operationId}:granted:operator`,
                address: agent.operator,
                role: 'operator',
                summary: `Your standing rule granted ${agent.name} permission ${granted.permissionId}.`,
              },
            ]
          : []),
      ],
    }
  }
  return { events: [] }
}

/** The operator's decision, told to the agent (an approved action then runs on the operator's request). */
export function decisionFeedEvents(
  network: Network,
  agent: Agent,
  approval: ApprovalRow,
  operation: { tool: string; action_key: string; intent_json?: string },
  now: number,
): AgentEvents {
  if (agent.address === null || approval.status === 'pending') return { events: [] }
  const approved = approval.status !== 'rejected'
  // A declined over-budget pick sent nothing, and its quote request opens again for another pick.
  const reopened = !approved && approval.kind === 'hire-over-limit' && operation.tool === 'pick_quote'
  const requestId = reopened ? requestOf(operation.intent_json) : undefined
  return {
    events: [
      {
        id: `approval:${approval.id}:decided`,
        address: agent.address,
        kind: 'approval.decided',
        role: 'agent',
        occurredAt: now,
        url: approvalUrl(network, agent, approval.id),
        summary: approved
          ? `Your operator approved ${KIND_WORDS[approval.kind]}; retry ${operation.tool} with the same operationKey for the result.`
          : requestId !== undefined
            ? `Your operator declined this hire; nothing was sent. Quote request ${requestId} is open again: pick another quote with a new operationKey.`
            : `Your operator rejected ${KIND_WORDS[approval.kind]}; do not retry it unchanged.`,
        ...(approved
          ? { next: { tool: operation.tool, args: { operationKey: operation.action_key } } }
          : requestId !== undefined
            ? { next: { tool: 'list_quotes', args: { requestId } } }
            : {}),
      },
    ],
  }
}

const Intent = Schema.Struct({ requestId: Schema.String })

/** The quote request a pick_quote operation was made on. */
function requestOf(intentJson: string | undefined): string | undefined {
  if (intentJson === undefined) return undefined
  return Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Intent))(intentJson))?.requestId
}

/** Writes the rows and the operator's Telegram link, if any; logs and swallows every failure. */
export async function recordAgentEvents(
  d1: AsyncSql | undefined,
  network: Network,
  operator: string,
  produced: AgentEvents,
  now: number,
): Promise<void> {
  if (d1 === undefined || produced.events.length === 0) return
  try {
    await writeFeed(d1, network, produced.events, now)
    if (produced.operatorNotice !== undefined)
      await enqueueWalletNotification(d1, network, operator, { ...produced.operatorNotice, now })
  } catch (error) {
    reportFeedFailure(error)
  }
}
