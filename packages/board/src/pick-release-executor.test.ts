/**
 * The declined-pick path end to end inside the board: a hosted agent's over-budget pick its operator declines is
 * released by the executor through the board's own release_pick, and the quote request can be picked again.
 * Chain reads are stubbed as in the board's other unit tests; nothing on the release path is.
 */
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentExecutor, type AgentPreparedCall, type AgentToolRequest } from './agent-executor.ts'
import type { AgentSigning } from './agent-signing.ts'
import { Board } from './service.ts'
import type { SponsorDesk } from './sponsor.ts'
import { fromNodeSqlite } from './store.ts'

const operator = '0x1111111111111111111111111111111111111111' as const
const agent = '0x2222222222222222222222222222222222222222' as const
const worker = '0x3333333333333333333333333333333333333333' as const
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function board() {
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const reads: Record<string, bigint | number | string | boolean> = {
    minimumCreatorBond: 10n ** 18n,
    unfilledForfeitBps: 2500,
    CANCEL_GRACE: 600,
    treasury: operator,
    UNSTAKE_DELAY: 259200,
    paused: false,
    decimals: 0,
    symbol: 'mUSD',
    getAgentWallet: worker,
    allowance: 0n,
    margin: 120,
    jobCounter: 0n,
    policyListed: false,
  }
  const read = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName in reads) return reads[functionName]
    if (['MIN_REVIEW_WINDOW', 'MIN_DISPUTE_WINDOW', 'reviewWindow', 'disputeWindow'].includes(functionName)) return 120
    if (functionName === 'settlementWindow') return 120
    if (functionName === 'MIN_ARBITRATION_WINDOW' || functionName === 'arbitrationWindow') return 300
    if (functionName.startsWith('MAX_')) return sdk.MAX_SIDEQUEST_WINDOW
    throw new Error(`unexpected chain read: ${functionName}`)
  })
  const ctx: sdk.Ctx = {
    ...base,
    publicClient: Object.assign(base.publicClient, {
      readContract: read,
      getBlockNumber: vi.fn(async () => 100n),
      getBlock: vi.fn(async () => ({ timestamp: 1000n })),
    }),
  }
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  return {
    ctx,
    board: new Board(fromNodeSqlite(db), {
      network: 'monad-testnet',
      domain: 'pick.test',
      uri: 'https://pick.test',
      manifestBaseUrl: 'https://pick.test/offers',
      now: () => 1000,
      contexts: { main: ctx },
    }),
  }
}

it('releases an operator-declined pick through the board, so the agent can pick again', async () => {
  const { ctx, board: b } = board()
  const token = ctx.deployment.rewardTokens[0]!
  const request = await b.requestQuotes(
    { address: agent },
    {
      title: 'Logo mark idea',
      brief: 'A small logo',
      acceptanceCriteria: ['an SVG'],
      tokens: [token],
      creatorBond: '1',
      workerBond: '0',
      deliveryDeadline: 2000,
      quoteDeadline: 1900,
      windows: { reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 },
      arbitrator: '0x4444444444444444444444444444444444444444',
    },
  )
  const quote = await b.submitQuote(
    { address: worker },
    { requestId: request.requestId, agentId: '7', token, amount: '1' },
  )
  const picked = await b.pickQuote(
    { address: agent },
    { requestId: request.requestId, quoteId: quote.quoteId, idempotencyKey: 'pick-1' },
  )

  // The executor's release_pick is the board's own, as the hosted runtime wires it.
  const prepareTool = vi.fn(async (call: AgentToolRequest): Promise<AgentPreparedCall> => {
    if (call.tool !== 'release_pick') throw new Error(`unexpected tool ${call.tool}`)
    // SAFETY: release_pick's arguments are the two ids the executor passes.
    const args = call.args as { requestId: string; taskId: string }
    return { ...(await b.releasePick(call.caller, args)) }
  })
  const db = new DatabaseSync(':memory:')
  databases.push(db)
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
  executor.agents.bindWallet('agent', 'wallet', agent)
  for (const state of ['upgraded', 'grants-live', 'registered', 'active'] as const)
    executor.agents.advance('agent', state)
  const args = { requestId: request.requestId, quoteId: quote.quoteId }
  const operation = executor.agents.begin('agent', 'pick-1', 'public', 'pick_quote', args)
  executor.agents.freezeStep(operation.id, 'prepared', { taskId: picked.taskId, transactions: [] })
  const approval = executor.agents.requestApproval(executor.agents.operation(operation.id), 'hire-over-limit', {
    token: operator,
    amount: '9000000',
  })
  executor.agents.decide(approval.id, operator, false, {})
  executor.agents.saveOperation(operation.id, 'failed', { result: approval })

  const result = await executor.execute({
    agentId: 'agent',
    boardId: 'public',
    operationKey: 'pick-1',
    tool: 'pick_quote',
    args,
  })
  expect(result).toMatchObject({
    status: 'rejected',
    next: { tool: 'list_quotes', args: { requestId: request.requestId } },
  })
  // The request is open again: a new pick with a new key goes through, and the declined task never publishes.
  const again = await b.pickQuote(
    { address: agent },
    { requestId: request.requestId, quoteId: quote.quoteId, idempotencyKey: 'pick-2' },
  )
  expect(again.taskId).not.toBe(picked.taskId)
  await expect(b.publishTransactions({ address: agent }, { taskId: picked.taskId })).rejects.toMatchObject({
    code: 'conflict',
  })
})
