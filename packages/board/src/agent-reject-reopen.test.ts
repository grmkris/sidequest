/** A declined over-budget pick reopens its quote request, once, and the agent is told to pick again (12 Oct). */
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentExecutor, type AgentPreparedCall, type AgentToolRequest } from './agent-executor.ts'
import type { AgentSigning } from './agent-signing.ts'
import type { SponsorDesk } from './sponsor.ts'
import { fromNodeSqlite } from './store.ts'

const operator = '0x1111111111111111111111111111111111111111' as const
const agentAddress = '0x2222222222222222222222222222222222222222' as const
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixture(release: (request: AgentToolRequest) => Promise<AgentPreparedCall>) {
  const ctx = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const prepareTool = vi.fn(async (request: AgentToolRequest) => {
    if (request.tool === 'release_pick') return release(request)
    throw new Error(`unexpected tool ${request.tool}`)
  })
  // SAFETY: a declined operation answers before the executor reaches the relay or the signer.
  const unused: SponsorDesk & AgentSigning = Object.create(null)
  const executor = new AgentExecutor({
    sql: fromNodeSqlite(db),
    now: () => 1000,
    context: ctx,
    sponsor: unused,
    signing: unused,
    prepareTool,
    verifyToolSigning: async () => 'ok',
  })
  executor.agents.create({
    id: 'agent',
    operator,
    privyUserId: 'did:privy:test',
    name: 'agent',
    registry: ctx.deployment.identity,
    chainId: ctx.deployment.chainId,
  })
  executor.agents.bindWallet('agent', 'wallet', agentAddress)
  for (const state of ['upgraded', 'grants-live', 'registered', 'active'] as const)
    executor.agents.advance('agent', state)
  /** An operation its operator declined: prepared (the board's pick), waiting on approval, then rejected. */
  const declined = (tool: 'pick_quote' | 'create_task', key: string) => {
    const args = tool === 'pick_quote' ? { requestId: 'r1', quoteId: 'q1' } : { title: key }
    const operation = executor.agents.begin('agent', key, 'public', tool, args)
    executor.agents.freezeStep(operation.id, 'prepared', { taskId: 't1', transactions: [] })
    const approval = executor.agents.requestApproval(executor.agents.operation(operation.id), 'hire-over-limit', {
      token: operator,
      amount: '9000000',
    })
    executor.agents.decide(approval.id, operator, false, {})
    executor.agents.saveOperation(operation.id, 'failed', { result: approval })
    return { agentId: 'agent', boardId: 'public', operationKey: key, tool, args }
  }
  return { executor, declined, prepareTool }
}

it('releases the declined pick once and points the agent back at the quotes', async () => {
  const f = fixture(async () => ({ released: true }))
  const input = f.declined('pick_quote', 'pick-1')
  const result = await f.executor.execute(input)
  expect(result).toMatchObject({ status: 'rejected', next: { tool: 'list_quotes', args: { requestId: 'r1' } } })
  expect(f.prepareTool).toHaveBeenCalledWith(
    expect.objectContaining({ tool: 'release_pick', args: { requestId: 'r1', taskId: 't1' } }),
  )
  expect(await f.executor.execute(input)).toMatchObject({ status: 'rejected', next: { tool: 'list_quotes' } })
  expect(f.prepareTool).toHaveBeenCalledTimes(1)
})

it('still answers rejected when the release fails, and releases on the next retry', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    let fail = true
    const f = fixture(async () => {
      if (fail) throw new Error('board unavailable')
      return { released: true }
    })
    const input = f.declined('pick_quote', 'pick-1')
    const first = await f.executor.execute(input)
    expect(first).toMatchObject({ status: 'rejected' })
    expect(first).not.toHaveProperty('next')
    fail = false
    expect(await f.executor.execute(input)).toMatchObject({ next: { tool: 'list_quotes' } })
    expect(f.prepareTool).toHaveBeenCalledTimes(2)
  } finally {
    spy.mockRestore()
  }
})

it('never releases anything for a declined create_task', async () => {
  const f = fixture(async () => ({ released: true }))
  const result = await f.executor.execute(f.declined('create_task', 'post-1'))
  expect(result).toMatchObject({ status: 'rejected' })
  expect(result).not.toHaveProperty('next')
  expect(f.prepareTool).not.toHaveBeenCalled()
})
