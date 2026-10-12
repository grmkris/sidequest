/** ADR-0019: who may post on a board that requires poster agents, and which agent each post records. */
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { zeroAddress } from 'viem'
import { afterEach, expect, it, vi } from 'vitest'
import { BoardError } from './board-error.ts'
import type { HostedCreatorQuery } from './hosted-creators.ts'
import { Board } from './service.ts'
import { fromNodeSqlite } from './store.ts'

const wallet = '0x1111111111111111111111111111111111111111' as const
const hosted = '0x3333333333333333333333333333333333333333' as const
const selfRun = '0x5555555555555555555555555555555555555555' as const
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

/** The chain reads posting needs, and the identity registry naming agent 2081's wallet. */
const chainReads: Record<string, unknown> = {
  minimumCreatorBond: 10n ** 18n,
  unfilledForfeitBps: 2500,
  CANCEL_GRACE: 600,
  treasury: wallet,
  UNSTAKE_DELAY: 259200,
  paused: false,
  decimals: 0,
  symbol: 'mUSD',
  margin: 120,
  allowance: 0n,
  availableOf: 10n ** 18n,
  MIN_REVIEW_WINDOW: 120,
  MIN_DISPUTE_WINDOW: 120,
  MIN_ARBITRATION_WINDOW: 300,
}

function fixture(options: { require: boolean; lookup?: 'ok' | 'down'; available?: bigint }) {
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const read = vi.fn(
    async ({ functionName, args }: { functionName: string; args?: readonly unknown[] | undefined }) => {
      if (functionName === 'getAgentWallet') return args?.[0] === 2081n ? selfRun : zeroAddress
      if (functionName === 'availableOf' && options.available !== undefined) return options.available
      if (functionName in chainReads) return chainReads[functionName]
      if (functionName.startsWith('MAX_')) return sdk.MAX_SIDEQUEST_WINDOW
      throw new Error(`unexpected chain read: ${functionName}`)
    },
  )
  // SAFETY: the horizon reads only timestamp; the partial block deliberately omits unused RPC fields.
  const getBlock = vi
    .fn<sdk.Ctx['publicClient']['getBlock']>()
    .mockResolvedValue({ timestamp: 1000n } as Awaited<ReturnType<sdk.Ctx['publicClient']['getBlock']>>)
  // The posting path reads the chain only through these client methods.
  vi.spyOn(base.publicClient, 'readContract').mockImplementation(read)
  vi.spyOn(base.publicClient, 'getBlockNumber').mockResolvedValue(100n)
  vi.spyOn(base.publicClient, 'getBlock').mockImplementation(getBlock)
  const ctx: sdk.Ctx = { ...base, stack: { ...base.stack, kind: 'sidequest-v1' } }
  const hostedCreators = vi.fn(async (query: HostedCreatorQuery) => {
    if (options.lookup === 'down') throw new Error('sponsor object unreachable')
    return {
      agents: query.addresses
        .filter((a) => a.toLowerCase() === hosted)
        .map((address) => ({ address, agentId: '2029' })),
      allowances: [],
    }
  })
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const board = new Board(fromNodeSqlite(db), {
    network: 'monad-testnet',
    contexts: { main: ctx },
    domain: 'poster.test',
    uri: 'https://poster.test',
    manifestBaseUrl: 'https://poster.test/offers',
    now: () => 1000,
    hostedCreators,
    requirePosterAgent: options.require,
  })
  const offer = {
    title: 'Offer',
    brief: 'Brief',
    acceptanceCriteria: ['works'],
    creatorBond: '1',
    workerBond: '0',
    deliveryDeadline: 200_000,
    windows: { reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 },
    arbitrator: '0x4444444444444444444444444444444444444444',
  }
  const token = base.deployment.rewardTokens[0]!
  const request = (address: `0x${string}`, extra: { agentId?: string } = {}) =>
    board.requestQuotes({ address }, { ...offer, tokens: [token], quoteDeadline: 100_000, ...extra })
  const create = (address: `0x${string}`, extra: { agentId?: string } = {}) =>
    board.createTask({ address }, { ...offer, token, reward: '1', ...extra })
  const agents = async () =>
    Object.fromEntries(
      (await board.listQuoteRequests({})).map((r) => [String(r.creator).toLowerCase(), r.creatorAgentId]),
    )
  return { board, request, create, agents }
}

it('lets any wallet post where agents are not required, recording the agent when one resolves', async () => {
  const f = fixture({ require: false })
  await f.request(wallet)
  await f.request(hosted)
  expect(await f.agents()).toEqual({ [wallet]: null, [hosted]: '2029' })
})

it('refuses a wallet no agent resolves to where agents are required, and says how to post', async () => {
  const f = fixture({ require: true })
  const refusal = await f.request(wallet).catch((error: unknown) => error)
  expect(refusal).toBeInstanceOf(BoardError)
  expect(refusal).toMatchObject({
    code: 'forbidden',
    message: expect.stringMatching(/needs an agent.*agentId.*\/agents\/new/),
  })
  await expect(f.create(wallet)).rejects.toMatchObject({ code: 'forbidden' })
})

it("admits a hosted agent's wallet, and a self-run agent that names itself, recording each agent", async () => {
  const f = fixture({ require: true })
  await f.request(hosted)
  await f.request(selfRun, { agentId: '2081' })
  expect(await f.agents()).toEqual({ [hosted]: '2029', [selfRun]: '2081' })
  await f.create(selfRun, { agentId: '2081' })
  expect(f.board.taskIndex({}).map((t) => t.creatorAgentId)).toEqual(['2081'])
})

it("refuses an agent ID whose wallet is not the caller's, required or not", async () => {
  for (const require of [true, false]) {
    const f = fixture({ require })
    await expect(f.request(wallet, { agentId: '2081' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(f.request(selfRun, { agentId: 'not-a-number' })).rejects.toMatchObject({ code: 'invalid' })
  }
})

it('is unavailable, not a refusal, when the hosted agent lookup does not answer', async () => {
  await expect(fixture({ require: true, lookup: 'down' }).request(hosted)).rejects.toMatchObject({
    code: 'unavailable',
  })
  expect(await fixture({ require: false, lookup: 'down' }).request(wallet)).toMatchObject({
    requestId: expect.any(String),
  })
})

it('refuses a hosted agent short of backing before any quote, with the operator link to fill it', async () => {
  const f = fixture({ require: true, available: 0n })
  for (const post of [() => f.request(hosted), () => f.create(hosted)]) {
    const refusal = await post().catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(BoardError)
    expect(refusal).toMatchObject({
      code: 'conflict',
      reason: 'insufficient-backing',
      retry: 'after-operator',
      message: expect.stringContaining(
        'Call request_backing, or send your operator https://poster.test/agent/2029?back=1 to back it with 1 SIDE',
      ),
    })
  }
  expect(await f.board.listQuoteRequests({})).toEqual([])
})

it('leaves a wallet that is not a hosted agent to stake in its own publish batch', async () => {
  const f = fixture({ require: false, available: 0n })
  await f.request(wallet)
  await f.request(selfRun, { agentId: '2081' })
  expect(Object.keys(await f.agents())).toHaveLength(2)
})

it('names a missing deadline before anything else, so an unbacked agent is not sent to its operator first', async () => {
  const f = fixture({ require: true, available: 0n })
  const token = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1').deployment.rewardTokens[0]!
  // The wire's `required` is not enforced, so an omitted deadline reaches the board as no number at all.
  const omitted = Number.NaN
  const noDeadline = await f.board
    .requestQuotes(
      { address: hosted },
      {
        title: 'T',
        brief: 'B',
        acceptanceCriteria: ['ok'],
        tokens: [token],
        quoteDeadline: omitted,
        deliveryDeadline: omitted,
      },
    )
    .catch((error: unknown) => error)
  expect(noDeadline).toMatchObject({
    code: 'invalid',
    message: expect.stringMatching(/^deliveryDeadline and quoteDeadline are required/),
  })
  // A bad argument is refused as such; backing is checked last, once the call would otherwise succeed.
  const late = await f.request(hosted, {}).catch((error: unknown) => error)
  expect(late).toMatchObject({ reason: 'insufficient-backing' })
  const pastQuote = await f.board
    .requestQuotes(
      { address: hosted },
      {
        title: 'T',
        brief: 'B',
        acceptanceCriteria: ['ok'],
        tokens: [token],
        quoteDeadline: 500,
        deliveryDeadline: 200_000,
      },
    )
    .catch((error: unknown) => error)
  expect(pastQuote).toMatchObject({ code: 'invalid', message: expect.stringContaining('quote deadline') })
})
