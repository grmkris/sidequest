/** An RPC failure while preparing an offer is not a refusal: its text names the provider URL and never reaches a reply. */
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { agentFailureReply } from './agent-failure.ts'
import { BoardError } from './board-error.ts'
import { Board } from './service.ts'
import { fromNodeSqlite } from './store.ts'

const creator = '0x1111111111111111111111111111111111111111' as const
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixture(failBounds: boolean) {
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const policyReads: Record<string, bigint | number | string> = {
    minimumCreatorBond: 10n ** 18n,
    unfilledForfeitBps: 2500,
    CANCEL_GRACE: 600,
    treasury: creator,
    UNSTAKE_DELAY: 259200,
  }
  const read = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName in policyReads) return policyReads[functionName]
    if (functionName === 'paused') return false
    if (functionName === 'decimals') return 0
    if (functionName === 'symbol') return 'mUSD'
    if (functionName === 'margin') return 120
    if (functionName === 'allowance') return 0n
    if (functionName === 'availableOf') return 1_000_000_000_000_000_000n
    if (failBounds && functionName.startsWith('MIN_')) {
      throw Object.assign(
        new Error(
          'HTTP request failed.\n\nURL: https://monad.example/v2/SECRETKEY\nRequest body: {"apiKey":"short-secret"}',
        ),
        { name: 'HttpRequestError', status: 401 },
      )
    }
    if (functionName === 'MIN_REVIEW_WINDOW' || functionName === 'MIN_DISPUTE_WINDOW') return 120
    if (functionName === 'MIN_ARBITRATION_WINDOW') return 300
    if (functionName.startsWith('MAX_')) return sdk.MAX_SIDEQUEST_WINDOW
    throw new Error(`unexpected chain read: ${functionName}`)
  })
  // SAFETY: the horizon reads only timestamp; the partial block deliberately omits unused RPC fields.
  const getBlock = vi
    .fn<sdk.Ctx['publicClient']['getBlock']>()
    .mockResolvedValue({ timestamp: 1000n } as Awaited<ReturnType<sdk.Ctx['publicClient']['getBlock']>>)
  const client = { ...base.publicClient, readContract: read, getBlockNumber: vi.fn(async () => 100n), getBlock }
  const ctx = { ...base, stack: { ...base.stack, kind: 'sidequest-v1' }, publicClient: client } as unknown as sdk.Ctx
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  const board = new Board(sql, {
    network: 'monad-testnet',
    contexts: { main: ctx },
    domain: 'offer.test',
    uri: 'https://offer.test',
    manifestBaseUrl: 'https://offer.test/offers',
    now: () => 1000,
  })
  const input = {
    title: 'Offer',
    brief: 'Brief',
    acceptanceCriteria: ['works'],
    token: base.deployment.rewardTokens[0]!,
    reward: '1',
    creatorBond: '1',
    workerBond: '0',
    deliveryDeadline: 200_000,
    windows: { reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 },
    arbitrator: '0x4444444444444444444444444444444444444444',
  }
  return { board, input, read, sql }
}

it('create_task and request_quotes pass a failed bounds read to the boundary, not as a trusted refusal', async () => {
  const f = fixture(true)
  const failures = [
    await f.board.createTask({ address: creator }, f.input).catch((error: unknown) => error),
    await f.board
      .requestQuotes({ address: creator }, { ...f.input, tokens: [f.input.token], quoteDeadline: 100_000 })
      .catch((error: unknown) => error),
  ]
  expect(f.read.mock.calls.some(([call]) => call.functionName.startsWith('MIN_'))).toBe(true)
  for (const failure of failures) {
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(BoardError)
    const reply = agentFailureReply(failure, 'The board could not complete this call', vi.fn(), 'error')
    // An RPC endpoint that failed the read is an outage: retryable with the same key, and not an owner page.
    expect(reply).toMatchObject({ code: 'unavailable', reason: 'transient', retry: 'same-key' })
    expect(JSON.stringify(reply)).not.toMatch(/SECRETKEY|monad\.example|short-secret|HTTP request/)
  }
})

it('a local validation failure is still an invalid refusal with its own text', async () => {
  const f = fixture(false)
  await expect(
    f.board.createTask(
      { address: creator },
      { ...f.input, windows: { reviewSeconds: 1, disputeSeconds: 120, arbitrationSeconds: 300 } },
    ),
  ).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('window') })
})

it.each([
  { creatorBond: '1', workerBond: '0' },
  { creatorBond: '1', workerBond: '1' },
])('create_task refuses a long bonded expiry before persistence for $creatorBond/$workerBond', async (bonds) => {
  const f = fixture(false)
  await expect(
    f.board.createTask({ address: creator }, { ...f.input, ...bonds, deliveryDeadline: 1000 + 259200 - 540 - 120 + 1 }),
  ).rejects.toMatchObject({
    code: 'invalid',
    message: 'A job with a bond must end within 3 days (the unstake period). Shorten the deadline or windows.',
  })
  expect(f.sql.all('SELECT * FROM tasks')).toHaveLength(0)
  expect(f.sql.all('SELECT * FROM operations')).toHaveLength(0)
  expect(f.read.mock.calls.some(([call]) => call.functionName === 'allowance' || call.functionName === 'symbol')).toBe(
    false,
  )
})

it('create_task accepts both bonds exactly at the horizon including every window and margin', async () => {
  const f = fixture(false)
  const prepared = await f.board.createTask(
    { address: creator },
    { ...f.input, workerBond: '1', deliveryDeadline: 1000 + 259200 - 540 - 120 },
  )
  expect(prepared.transactions).toHaveLength(2)
  expect(f.sql.all('SELECT * FROM tasks')).toHaveLength(1)
})

it('create_task rejects a zero creator bond before persistence', async () => {
  const f = fixture(false)
  await expect(f.board.createTask({ address: creator }, { ...f.input, creatorBond: '0' })).rejects.toMatchObject({
    code: 'invalid',
    message: expect.stringContaining('at least 1 SIDE'),
  })
  expect(f.sql.all('SELECT * FROM tasks')).toHaveLength(0)
})

it.each([
  { creatorBond: '1', workerBond: '0' },
  { creatorBond: '1', workerBond: '1' },
])('create_task fits omitted defaults for a two-day bonded delivery $creatorBond/$workerBond', async (bonds) => {
  const f = fixture(false)
  const { windows: _windows, ...withoutWindows } = f.input
  const prepared = await f.board.createTask(
    { address: creator },
    { ...withoutWindows, ...bonds, deliveryDeadline: 1000 + 2 * 86400 },
  )
  expect(prepared.transactions).toHaveLength(2)
  const [row] = f.sql.all<{ terms_json: string }>('SELECT terms_json FROM tasks')
  const { windows } = JSON.parse(row!.terms_json)
  expect(windows).toEqual({ reviewSeconds: 21420, disputeSeconds: 21420, arbitrationSeconds: 42840 })
  expect(1000 + 2 * 86400 + windows.reviewSeconds + windows.disputeSeconds + windows.arbitrationSeconds + 120).toBe(
    1000 + 259200 - 600,
  )
})

it('request_quotes fits the same defaults before freezing the request, and retains explicit windows', async () => {
  const f = fixture(false)
  const { windows: _windows, ...withoutWindows } = f.input
  for (const request of [withoutWindows, f.input]) {
    await f.board.requestQuotes(
      { address: creator },
      {
        ...request,
        workerBond: '1',
        tokens: [f.input.token],
        quoteDeadline: 100_000,
        deliveryDeadline: 1000 + 2 * 86400,
      },
    )
  }
  const rows = f.sql.all<{ request_json: string }>('SELECT request_json FROM quote_requests ORDER BY rowid')
  expect(JSON.parse(rows[0]!.request_json).windows).toEqual({
    reviewSeconds: 21420,
    disputeSeconds: 21420,
    arbitrationSeconds: 42840,
  })
  expect(JSON.parse(rows[1]!.request_json).windows).toEqual(f.input.windows)
})

it('refuses omitted defaults when the minimum windows and inclusion slack cannot fit, without persisting', async () => {
  const f = fixture(false)
  const { windows: _windows, ...withoutWindows } = f.input
  const input = {
    ...withoutWindows,
    workerBond: '1',
    deliveryDeadline: 1000 + 259200 - 120 - 600 - 540 + 1,
  }
  await expect(f.board.createTask({ address: creator }, input)).rejects.toMatchObject({
    code: 'invalid',
    message: expect.stringContaining('3 days'),
  })
  await expect(
    f.board.requestQuotes({ address: creator }, { ...input, tokens: [f.input.token], quoteDeadline: 100_000 }),
  ).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('3 days') })
  expect(f.sql.all('SELECT * FROM tasks')).toHaveLength(0)
  expect(f.sql.all('SELECT * FROM quote_requests')).toHaveLength(0)
})

it('defaults an omitted creator bond to the live floor and fits windows within the horizon', async () => {
  const f = fixture(false)
  const { windows: _windows, creatorBond: _creatorBond, ...withoutDefaults } = f.input
  await f.board.createTask({ address: creator }, withoutDefaults)
  const [row] = f.sql.all<{ terms_json: string }>('SELECT terms_json FROM tasks')
  const terms = JSON.parse(row!.terms_json)
  expect(terms.creatorBond).toBe('1000000000000000000')
  expect(
    terms.deliveryDeadline +
      terms.windows.reviewSeconds +
      terms.windows.disputeSeconds +
      terms.windows.arbitrationSeconds +
      120,
  ).toBeLessThanOrEqual(1000 + 259200 - 600)
  expect(f.read.mock.calls.some(([call]) => call.functionName === 'UNSTAKE_DELAY')).toBe(true)
})
