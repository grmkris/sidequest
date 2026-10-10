/** Budget covered on the public request list: wallet balance for self-run posters, one weekly grant for hosted ones. */
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { Board } from './service.ts'
import { fromNodeSqlite } from './store.ts'
import type { HostedCreatorQuery } from './hosted-creators.ts'

const alice = '0x1111111111111111111111111111111111111111' as const
const bob = '0x2222222222222222222222222222222222222222' as const
const scout = '0x3333333333333333333333333333333333333333' as const
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixture() {
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const token = base.deployment.rewardTokens[0]!
  const balances: Record<string, bigint> = { [alice]: 500n, [bob]: 10n, [scout]: 10_000n }
  const multicall = vi.fn(async ({ contracts }: { contracts: { args: [string] }[] }) =>
    contracts.map((c) => ({ status: 'success' as const, result: balances[c.args[0].toLowerCase()] ?? 0n })),
  )
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
    functionName === 'decimals' ? 6 : 'mUSD',
  )
  const ctx = { ...base, publicClient: { ...base.publicClient, multicall, readContract } } as unknown as sdk.Ctx
  const hostedCreators = vi.fn(async (query: HostedCreatorQuery) => ({
    // Like hostedCreatorFacts: every queried wallet, whether named as an address or in an allowance.
    agents: [...new Set([...query.addresses, ...query.allowances.map((a) => a.address)])]
      .filter((a) => a.toLowerCase() === scout)
      .map((address) => ({ address, agentId: '2029' })),
    allowances: query.allowances
      .filter((a) => a.address.toLowerCase() === scout)
      .map((a) => ({ ...a, available: '250' })),
  }))
  const clock = { now: 1000 }
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  const board = new Board(sql, {
    network: 'monad-testnet',
    contexts: { main: ctx },
    domain: 'cover.test',
    uri: 'https://cover.test',
    manifestBaseUrl: 'https://cover.test/offers',
    now: () => clock.now,
    hostedCreators,
  })
  const request = (id: string, creator: string, max: string | null) =>
    sql.run(
      'INSERT INTO quote_requests (id, creator, stack, request_json, request_hash, quote_deadline, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      creator,
      'main',
      JSON.stringify({
        creator,
        stack: 'main',
        title: id,
        tokens: [token],
        quoteDeadline: 5000,
        ...(max === null ? {} : { budget: { token, max } }),
      }),
      id,
      5000,
      null,
      900,
    )
  return { board, multicall, readContract, hostedCreators, clock, request }
}

const byId = (rows: readonly Record<string, unknown>[]) =>
  Object.fromEntries(rows.map((r) => [r.requestId, { agent: r.creatorAgentId, covered: r.budgetCovered }]))

it('a self-run poster is covered by its wallet, a hosted one only by its best weekly grant', async () => {
  const f = fixture()
  f.request('alice', alice, '300')
  f.request('bob', bob, '300')
  f.request('scout', scout, '300')
  f.request('open-budget', alice, null)
  expect(byId(await f.board.listQuoteRequests({}))).toEqual({
    alice: { agent: null, covered: true },
    bob: { agent: null, covered: false },
    // Scout's wallet holds 10,000 but a hosted pick is paid from one grant (250 left), so it is not covered.
    scout: { agent: '2029', covered: false },
    'open-budget': { agent: null, covered: undefined },
  })
  // One balance read for the two self-run posters; none for the hosted one.
  expect(f.multicall).toHaveBeenCalledTimes(1)
  expect(f.multicall.mock.calls[0]![0].contracts.map((c) => c.args[0].toLowerCase()).toSorted()).toEqual([alice, bob])
})

it('reads are cached for 30 s (poster identity for 5 min) and a failed read says null, uncached', async () => {
  const f = fixture()
  f.request('alice', alice, '300')
  f.request('scout', scout, '200')
  await f.board.listQuoteRequests({})
  await f.board.listQuoteRequests({})
  expect(f.multicall).toHaveBeenCalledTimes(1)
  expect(f.hostedCreators).toHaveBeenCalledTimes(1)
  f.clock.now += 31
  f.hostedCreators.mockRejectedValueOnce(new Error('sponsor object unavailable'))
  // The poster identities are still fresh, so Alice's balance is re-read; Scout's grant read failed: unknown, not false.
  expect(byId(await f.board.listQuoteRequests({}))).toEqual({
    alice: { agent: null, covered: true },
    scout: { agent: '2029', covered: null },
  })
  expect(byId(await f.board.listQuoteRequests({}))).toEqual({
    alice: { agent: null, covered: true },
    scout: { agent: '2029', covered: true },
  })
})

it('a poster read that hangs gives up after 4 s: the list answers with null instead of waiting', async () => {
  vi.useFakeTimers()
  try {
    const f = fixture()
    f.request('alice', alice, '300')
    f.multicall.mockImplementationOnce(() => new Promise(() => {}))
    const listed = f.board.listQuoteRequests({})
    await vi.advanceTimersByTimeAsync(4000)
    expect(byId(await listed)).toEqual({ alice: { agent: null, covered: null } })
  } finally {
    vi.useRealTimers()
  }
})

it('shows a budget cap in token units beside the hashed base-unit max, reading token metadata once', async () => {
  const f = fixture()
  f.request('alice', alice, '11000000')
  f.request('bob', bob, '2500000')
  f.request('open-budget', alice, null)
  const rows = await f.board.listQuoteRequests({})
  const display = Object.fromEntries(rows.map((r) => [r.requestId, r.budgetDisplay]))
  // Gap 2: budget.max stays "11000000" (base units, inside the request hash); submit_quote takes token units.
  expect(display).toEqual({
    alice: { max: '11', symbol: 'mUSD', decimals: 6 },
    bob: { max: '2.5', symbol: 'mUSD', decimals: 6 },
    'open-budget': undefined,
  })
  expect(rows.find((r) => r.requestId === 'alice')?.budget).toMatchObject({ max: '11000000' })
  await f.board.listQuoteRequests({})
  expect(f.readContract).toHaveBeenCalledTimes(2)
})
