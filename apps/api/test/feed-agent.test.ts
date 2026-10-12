import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { AgentExecuteResult, ApprovalRow } from '@sidequest/board'
import { fromNodeSqlite, migrate, stmt } from '@sidequest/indexer'
import { agentFeedEvents, approvalUrl, decisionFeedEvents, recordAgentEvents } from '../src/feed-agent.ts'
import { feedTools, readInbox } from '../src/feed.ts'
import { permittedTool } from '../src/mcp-policy.ts'
import { migrateTelegram } from '../src/telegram.ts'

const operator = '0x1111111111111111111111111111111111111111'
const address = '0x2222222222222222222222222222222222222222'
const agent = { id: 'm1', name: 'Canvas', operator, address, agent_id: '77' } as const
const network = 'monad-testnet' as const
const now = 2_000_000
const approval: ApprovalRow = {
  id: 'ap1',
  agent_id: 'm1',
  operation_id: '0xop',
  kind: 'permission',
  status: 'pending',
  request_json: '{}',
  decision_json: null,
  created_at: now,
  decided_at: null,
}

async function d1() {
  const sql = fromNodeSqlite(new DatabaseSync(':memory:'))
  await migrate(sql)
  await migrateTelegram(sql)
  await sql.batch([stmt('INSERT INTO telegram_links VALUES (?, 10143, ?, NULL, 1)', 'chat-operator', operator)])
  return sql
}

describe('management feed events', () => {
  it('tells the agent to retry with its key and sends the operator one signing link, never an approve button', async () => {
    const result: AgentExecuteResult = { status: 'approval', operationId: '0xop', approval }
    const produced = agentFeedEvents({ network, agent, tool: 'request_permissions', operationKey: 'k1', result, now })
    expect(produced.events.map((e) => [e.address, e.kind, e.role])).toEqual([
      [address, 'approval.requested', 'agent'],
      [operator, 'approval.requested', 'operator'],
    ])
    expect(produced.events[0]!.next).toEqual({ tool: 'request_permissions', args: { operationKey: 'k1' } })
    expect(produced.operatorNotice).toEqual({
      id: 'telegram:approval:ap1',
      text: 'Canvas needs your decision: a new permission. Review and sign: https://dev.sidequest.exchange/agent/77?tab=approvals&approval=ap1',
    })
    const sql = await d1()
    await recordAgentEvents(sql, network, operator, produced, now)
    await recordAgentEvents(sql, network, operator, produced, now)
    expect(await sql.all('SELECT id, chat_id FROM telegram_outbox')).toEqual([
      { id: 'telegram:approval:ap1', chat_id: 'chat-operator' },
    ])
    expect((await readInbox(sql, { network, address, now })).events.map((e) => e.kind)).toEqual(['approval.requested'])
    expect(approvalUrl(network, { ...agent, agent_id: null }, 'ap1')).toBe('https://dev.sidequest.exchange/agents')
  })

  it('records a standing-rule grant silently in both feeds and tells the agent which permission to use', () => {
    const result: AgentExecuteResult = {
      status: 'confirmed',
      operationId: '0xop',
      result: { permissionId: '0xperm', granted: 'standing-rule' },
    }
    const produced = agentFeedEvents({ network, agent, tool: 'request_permissions', operationKey: 'k1', result, now })
    expect(produced.operatorNotice).toBeUndefined()
    expect(produced.events.map((e) => [e.address, e.kind])).toEqual([
      [address, 'permission.granted'],
      [operator, 'permission.granted'],
    ])
    expect(produced.events[0]!.next).toEqual({ tool: 'use_permission', args: { permissionId: '0xperm' } })
    const byOperator = agentFeedEvents({
      network,
      agent,
      tool: 'request_permissions',
      operationKey: 'k1',
      result: { ...result, result: { permissionId: '0xperm', granted: 'operator' } },
      now,
    })
    expect(byOperator.events).toHaveLength(1)
    expect(
      agentFeedEvents({
        network,
        agent,
        tool: 'apply',
        operationKey: 'k',
        result: { status: 'confirmed', operationId: '0xop', result: {} },
        now,
      }).events,
    ).toEqual([])
  })

  it('tells the agent the decision, with a retry only when approved', () => {
    const operation = { tool: 'create_task', action_key: 'k9' }
    expect(
      decisionFeedEvents(network, agent, { ...approval, status: 'approved' }, operation, { now }).events[0],
    ).toMatchObject({ kind: 'approval.decided', next: { tool: 'create_task', args: { operationKey: 'k9' } } })
    expect(
      decisionFeedEvents(network, agent, { ...approval, status: 'rejected' }, operation, { now }).events[0]!.next,
    ).toBeUndefined()
    expect(decisionFeedEvents(network, agent, approval, operation, { now }).events).toEqual([])
  })

  it('tells the agent a declined over-budget pick sent nothing and reopened its request', () => {
    const pick = {
      tool: 'pick_quote',
      action_key: 'p1',
      intent_json: JSON.stringify({ requestId: 'r7', quoteId: 'q1' }),
    }
    const declined = { ...approval, kind: 'hire-over-limit' as const, status: 'rejected' as const }
    expect(decisionFeedEvents(network, agent, declined, pick, { now, reopened: true }).events[0]).toMatchObject({
      summary: expect.stringContaining('Quote request r7 is open again'),
      next: { tool: 'list_quotes', args: { requestId: 'r7' } },
    })
    // The release failed: the agent retries the same pick, which re-attempts it, instead of a new key.
    expect(decisionFeedEvents(network, agent, declined, pick, { now, reopened: false }).events[0]).toMatchObject({
      summary: expect.stringContaining('is not open again yet'),
      next: { tool: 'pick_quote', args: { operationKey: 'p1' } },
    })
  })
})

describe('inbox tool', () => {
  it('is a read-scope tool for the signed-in wallet only, with typed cursor errors', async () => {
    expect(permittedTool({ scopes: ['sidequest:read'] }, 'inbox')).toBe(true)
    const sql = await d1()
    const deps = { sql, network, now }
    await expect(feedTools.inbox.run(deps, undefined, {})).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(feedTools.inbox.run(deps, address, { cursor: 'seq=4' })).rejects.toMatchObject({ code: 'invalid' })
    expect(await feedTools.inbox.run(deps, address, {})).toMatchObject({ events: [], cursor: null, hasMore: false })
  })
})
