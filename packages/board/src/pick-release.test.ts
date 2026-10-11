/** A pick that never reached the chain can be withdrawn, and its quote request picked again (12 Oct fix list). */
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { Board } from './service.ts'
import { fromNodeSqlite } from './store.ts'

const creator = '0x1111111111111111111111111111111111111111' as const
const worker = '0x2222222222222222222222222222222222222222' as const
const outsider = '0x5555555555555555555555555555555555555555' as const
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

async function fixture() {
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  let listed = false
  const reads: Record<string, bigint | number | string | boolean> = {
    minimumCreatorBond: 10n ** 18n,
    unfilledForfeitBps: 2500,
    CANCEL_GRACE: 600,
    treasury: creator,
    UNSTAKE_DELAY: 259200,
    paused: false,
    decimals: 0,
    symbol: 'mUSD',
    getAgentWallet: worker,
    allowance: 0n,
    margin: 120,
    jobCounter: 0n,
  }
  const read = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'policyListed') return listed
    if (functionName in reads) return reads[functionName]
    if (['MIN_REVIEW_WINDOW', 'MIN_DISPUTE_WINDOW', 'reviewWindow', 'disputeWindow'].includes(functionName)) return 120
    if (functionName === 'settlementWindow') return 120
    if (functionName === 'MIN_ARBITRATION_WINDOW' || functionName === 'arbitrationWindow') return 300
    if (functionName.startsWith('MAX_')) return sdk.MAX_SIDEQUEST_WINDOW
    throw new Error(`unexpected chain read: ${functionName}`)
  })
  // The board reads contracts, the block number and the block timestamp; the rest of the client stays real.
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
  const board = new Board(fromNodeSqlite(db), {
    network: 'monad-testnet',
    domain: 'pick.test',
    uri: 'https://pick.test',
    manifestBaseUrl: 'https://pick.test/offers',
    now: () => 1000,
    contexts: { main: ctx },
  })
  const terms = {
    title: 'Logo mark idea',
    brief: 'A small logo',
    acceptanceCriteria: ['an SVG'],
    mode: 'hire' as const,
    token: base.deployment.rewardTokens[0]!,
    creatorBond: '1',
    workerBond: '0',
    deliveryDeadline: 2000,
    windows: { reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 },
    arbitrator: '0x4444444444444444444444444444444444444444',
  }
  const request = await board.requestQuotes(
    { address: creator },
    { ...terms, tokens: [terms.token], quoteDeadline: 1900 },
  )
  const quote = await board.submitQuote(
    { address: worker },
    { requestId: request.requestId, agentId: '7', token: terms.token, amount: '1' },
  )
  const pick = (key: string) =>
    board.pickQuote({ address: creator }, { requestId: request.requestId, quoteId: quote.quoteId, idempotencyKey: key })
  return { board, request, pick, publish: (value: boolean) => (listed = value) }
}

it('withdraws an unpublished pick so the request can be picked again, once', async () => {
  const f = await fixture()
  const first = await f.pick('pick-1')
  await expect(f.pick('pick-2')).rejects.toMatchObject({ code: 'conflict' })
  const release = { requestId: f.request.requestId, taskId: first.taskId }
  expect(await f.board.releasePick({ address: creator }, release)).toMatchObject({ released: true, ...release })
  expect(await f.board.releasePick({ address: creator }, release)).toMatchObject({ released: true })
  const second = await f.pick('pick-2')
  expect(second.taskId).not.toBe(first.taskId)
  // The withdrawn task is never published, listed or indexed again.
  await expect(f.board.publishTransactions({ address: creator }, { taskId: first.taskId })).rejects.toMatchObject({
    code: 'conflict',
  })
  const listed = await f.board.listTasks({ address: creator }, { role: 'creator' })
  expect(listed.map((t) => t.taskId)).toEqual([second.taskId])
  expect(f.board.taskIndex({ address: creator }).map((t) => t.taskId)).toEqual([second.taskId])
})

it('never releases a pick that reached the chain, nor one that is not the caller’s', async () => {
  const f = await fixture()
  const first = await f.pick('pick-1')
  const release = { requestId: f.request.requestId, taskId: first.taskId }
  await expect(f.board.releasePick({ address: outsider }, release)).rejects.toMatchObject({ code: 'forbidden' })
  f.publish(true)
  expect(await f.board.releasePick({ address: creator }, release)).toMatchObject({ released: false })
  await expect(f.pick('pick-2')).rejects.toMatchObject({ code: 'conflict' })
})
