import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { zeroAddress, type Address } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Board } from './service.ts'
import { fromNodeSqlite } from './store.ts'
import { canonicalJson, termsHash, type OfferTerms } from './terms.ts'

vi.mock('@sidequest/sdk', async (original) => ({
  ...(await original<typeof sdk>()),
  getJob: vi.fn(),
  getListing: vi.fn(),
  sidequestState: vi.fn(),
  agentWallet: vi.fn(),
}))

const creator = '0x1111111111111111111111111111111111111111' as const
const worker = '0x2222222222222222222222222222222222222222' as const
const curator = '0x3333333333333333333333333333333333333333' as const
const databases: DatabaseSync[] = []
afterEach(() => {
  databases.splice(0).forEach((database) => database.close())
  vi.clearAllMocks()
})

function fixture(workerBond = 0n, expiredAt = 260200) {
  // Use the current v1 pair for selections.
  const historical = sdk.deployment('monad-testnet')
  const base = {
    ...sdk.contextFor('monad-testnet', historical.stacks.main!, 'http://127.0.0.1:1'),
    deployment: historical,
  }
  const verify = vi.fn(async () => true)
  const read = vi.fn(
    async ({
      functionName,
    }: {
      functionName: string
    }): Promise<boolean | number | bigint | string | (number | bigint)[] | typeof listing> => {
      if (functionName === 'selectionNonceUsed' || functionName === 'paused') return false
      if (functionName === 'decimals') return 6
      if (functionName === 'symbol') return 'mUSD'
      if (functionName === 'UNSTAKE_DELAY') return 259200
      if (functionName === 'getListing') return listing
      if (functionName === 'availableOf') return 100n
      if (functionName === 'quoteActivation') return [3000, 2n, 3n]
      throw new Error(`unexpected read ${functionName}`)
    },
  )
  // SAFETY: the guard only needs the mined block's timestamp; unused RPC fields are omitted.
  const getBlock = vi
    .fn<sdk.Ctx['publicClient']['getBlock']>()
    .mockResolvedValue({ timestamp: 1000n } as Awaited<ReturnType<sdk.Ctx['publicClient']['getBlock']>>)
  const ctx = {
    ...base,
    publicClient: { ...base.publicClient, verifyTypedData: verify, readContract: read, getBlock },
  } as unknown as sdk.Ctx
  const database = new DatabaseSync(':memory:')
  databases.push(database)
  const sql = fromNodeSqlite(database)
  let now = 1_000
  const boot = () =>
    new Board(sql, {
      network: 'monad-testnet',
      contexts: { main: ctx },
      domain: 'fixture.test',
      uri: 'https://fixture.test',
      manifestBaseUrl: 'https://fixture.test/offers',
      now: () => now,
    })
  const board = boot()
  const terms: OfferTerms = {
    v: 2,
    taskId: 'selection-fixture',
    projectId: null,
    policyVersion: null,
    mode: 'hire',
    title: 'Selection fixture',
    brief: 'Test only',
    acceptanceCriteria: [],
    deployment: {
      chainId: base.deployment.chainId,
      core: base.deployment.core,
      holding: base.stack.holding,
      evaluator: base.stack.evaluator,
      identity: base.deployment.identity,
    },
    creator,
    approver: creator,
    arbitrator: base.deployment.arbitrator,
    token: base.deployment.rewardTokens[0]!,
    reward: 5n,
    creatorBond: 0n,
    workerBond,
    deliveryDeadline: 1_200,
    windows: { reviewSeconds: 100, disputeSeconds: 100, arbitrationSeconds: 100 },
    eligibility: null,
    evidencePolicy: null,
    quote: null,
    salt: sdk.EMPTY_HASH,
  }
  const hash = termsHash(terms)
  sql.run(
    'INSERT INTO tasks (id, creator, stack, terms_json, terms_hash, job_id, from_block, created_at, pool_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    terms.taskId,
    terms.creator,
    'main',
    canonicalJson(terms),
    hash,
    '61',
    0,
    0,
    null,
  )
  sql.run(
    'INSERT INTO applications (id, task_id, worker, agent_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    'app-1',
    terms.taskId,
    worker,
    '7001',
    'Test only',
    0,
  )
  sql.run(
    'INSERT INTO selections (task_id, nonce, application_id, worker, agent_id, activate_by, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    terms.taskId,
    '1',
    'app-1',
    worker,
    '7001',
    1_100,
    '0x1234',
    10,
  )
  vi.mocked(sdk.getJob).mockResolvedValue({
    statusName: 'Open',
    provider: zeroAddress,
    submittedAt: 0,
  } as unknown as Awaited<ReturnType<typeof sdk.getJob>>)
  const listing = {
    creator,
    approver: creator,
    arbitrator: terms.arbitrator,
    token: terms.token,
    reward: terms.reward,
    creatorBond: 0n,
    workerBond,
    expiredAt,
    deliveryDeadline: terms.deliveryDeadline,
    policyHash: hash,
    reviewWindow: terms.windows.reviewSeconds,
    disputeWindow: terms.windows.disputeSeconds,
    arbitrationWindow: terms.windows.arbitrationSeconds,
    feeBps: 0,
    fee: 0n,
    bonus: 0n,
  }
  vi.mocked(sdk.getListing).mockResolvedValue(listing as unknown as Awaited<ReturnType<typeof sdk.getListing>>)
  // SAFETY: the board reads only these fields of the chain state; the rest of the type is never touched.
  const chainState = (provider: Address, status: string) =>
    ({
      job: { statusName: status === 'active' ? 'Funded' : 'Open', provider, submittedAt: 0 },
      listing,
      terms: { deliveryDeadline: terms.deliveryDeadline, funded: 0n },
      decision: { outcome: 0, rejectedAt: 0, disputedAt: 0, violation: 0 },
      outcome: 'None',
      status,
      paused: false,
      deferredDecision: false,
      collectPending: false,
      reviewEndsAt: null,
      disputeEndsAt: null,
      arbitrationEndsAt: null,
    }) as unknown as Awaited<ReturnType<typeof sdk.sidequestState>>
  vi.mocked(sdk.sidequestState).mockResolvedValue(chainState(zeroAddress, 'open'))
  vi.mocked(sdk.agentWallet).mockResolvedValue(worker)
  const get = (address?: Address) => board.getTask(address === undefined ? {} : { address }, { taskId: terms.taskId })
  return {
    get,
    boot,
    chainState,
    sql,
    terms,
    read,
    verify,
    setNow: (value: number) => {
      now = value
    },
  }
}

describe('get_task creator selection authorization and persistence', () => {
  it('hydrates after a board restart without altering open chain state or exposing a signature/nonce', async () => {
    const context = fixture()
    const first = await context.get(creator)
    const refreshed = await context.boot().getTask({ address: creator }, { taskId: context.terms.taskId })
    expect(refreshed.selection).toEqual(first.selection)
    expect(refreshed.selection).toEqual([
      { state: 'signed', applicationId: 'app-1', agentId: '7001', activateBy: 1_100 },
    ])
    expect(refreshed.chain).toMatchObject({ status: 'open', provider: null })
    expect(refreshed.nextAction).toEqual({ actor: 'worker', action: 'activate', deadline: 1_100 })
    expect(context.read).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'selectionNonceUsed', args: [creator, 1n] }),
    )
    expect(context.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        address: creator,
        primaryType: 'Selection',
        message: expect.objectContaining({ jobId: 61n }),
      }),
    )
  })

  it.each([undefined, worker, curator])('omits creator selection data for unauthorized caller %s', async (address) => {
    const context = fixture()
    const task = await context.get(address)
    expect(task).not.toHaveProperty('selection')
    expect(task).not.toHaveProperty('selectionObservedAt')
    await context.boot().listTasks(address === undefined ? {} : { address }, {})
    expect(context.verify).not.toHaveBeenCalled()
    expect(context.read.mock.calls.some(([call]) => call.functionName === 'selectionNonceUsed')).toBe(false)
  })

  it('tells the selected worker to activate from its own live selection, without throwing for anyone else', async () => {
    const context = fixture()
    const mine = await context.get(worker)
    expect(mine.nextAction).toEqual({ actor: 'worker', action: 'activate', deadline: 1_100 })
    expect(mine.mine).toMatchObject({ selected: true, liveSelection: { activateBy: 1_100 } })
    const other = await context.get(curator)
    expect(other.nextAction).toMatchObject({ actor: 'creator', action: 'select_worker' })
    expect(other.mine).toMatchObject({ selected: false, liveSelection: null })
    expect(context.verify).not.toHaveBeenCalled()
    context.setNow(1_101)
    const expired = await context.get(worker)
    expect(expired.nextAction).toMatchObject({ actor: 'creator', action: 'select_worker' })
    expect(expired.mine).toMatchObject({ selected: true, liveSelection: null })
  })

  it('lists a job under holder only for the selected worker the chain names as provider', async () => {
    const context = fixture()
    const board = context.boot()
    const held = async (address: Address) =>
      (await board.listTasks({ address }, { role: 'holder' })).map((task) => task.taskId)
    // Selected but not yet activated: the chain names no provider, so nobody holds it.
    expect(await held(worker)).toEqual([])
    vi.mocked(sdk.sidequestState).mockResolvedValue(context.chainState(worker, 'active'))
    expect(await held(worker)).toEqual([context.terms.taskId])
    // No signed selection: excluded before any chain read.
    vi.mocked(sdk.sidequestState).mockClear()
    expect(await held(curator)).toEqual([])
    expect(sdk.sidequestState).not.toHaveBeenCalled()
  })

  it('shows the requester how busy each bidder is, and the bidder nothing of the kind', async () => {
    const context = fixture()
    const board = context.boot()
    context.sql.run(
      'INSERT INTO quote_requests (id, creator, stack, request_json, request_hash, quote_deadline, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      'req',
      creator,
      'main',
      '{"title":"Next job"}',
      '0xreq',
      5000,
      null,
      900,
    )
    context.sql.run(
      'INSERT INTO quotes (id, request_id, worker, agent_id, token, amount, note, quote_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      'q1',
      'req',
      worker,
      '7001',
      context.terms.token,
      '9000000',
      '',
      '0xq1',
      950,
    )
    // Roadmap #4: the worker's earlier hire is selected and waiting for it to activate.
    const waiting = await board.listQuotes({ address: creator }, { requestId: 'req' })
    expect(waiting.quotes[0]).toMatchObject({ workerLoad: { holding: 0, awaitingActivation: 1 } })
    vi.mocked(sdk.sidequestState).mockResolvedValue(context.chainState(worker, 'active'))
    const busy = await board.listQuotes({ address: creator }, { requestId: 'req' })
    expect(busy.quotes[0]).toMatchObject({ workerLoad: { holding: 1, awaitingActivation: 0 } })
    expect((await board.listQuotes({ address: worker }, { requestId: 'req' })).quotes[0]).not.toHaveProperty(
      'workerLoad',
    )
  })

  it('expires a persisted selection strictly after its cutoff', async () => {
    const context = fixture()
    context.setNow(1_101)
    expect((await context.get(creator)).selection?.[0]?.state).toBe('expired')
    expect(context.verify).not.toHaveBeenCalled()
  })

  it('rejects a revoked nonce, rotated wallet, and invalid current creator signature', async () => {
    const context = fixture()
    context.read.mockImplementation(async ({ functionName }) => functionName === 'selectionNonceUsed')
    expect((await context.get(creator)).selection?.[0]?.state).toBe('invalid')
    context.read.mockImplementation(async () => false)
    vi.mocked(sdk.agentWallet).mockResolvedValue(curator)
    expect((await context.get(creator)).selection?.[0]?.state).toBe('invalid')
    vi.mocked(sdk.agentWallet).mockResolvedValue(worker)
    context.verify.mockResolvedValue(false)
    expect((await context.get(creator)).selection?.[0]?.state).toBe('invalid')
  })

  it('fails closed when the persisted application identity changes', async () => {
    const context = fixture()
    context.sql.run("UPDATE applications SET agent_id = '7002' WHERE id = 'app-1'")
    expect((await context.get(creator)).selection?.[0]?.state).toBe('invalid')
  })

  it('does not claim valid or invalid when RPC signature validation is unavailable', async () => {
    const context = fixture()
    context.verify.mockRejectedValue(new Error('RPC down'))
    expect((await context.get(creator)).selection?.[0]?.state).toBe('unavailable')
  })
})

it('select_worker and prepare_activation refuse the actual bonded listing horizon before saving authorization', async () => {
  const f = fixture(1n, 260201),
    board = f.boot()
  await expect(
    board.selectWorker({ address: creator }, { taskId: f.terms.taskId, applicationId: 'app-1' }),
  ).rejects.toThrow('3 days')
  expect(f.sql.all('SELECT * FROM selections')).toHaveLength(1)
  await expect(board.prepareActivation({ address: worker }, { taskId: f.terms.taskId })).rejects.toThrow('3 days')
  expect(f.sql.all('SELECT * FROM activation_preps')).toHaveLength(0)
})

it('select_worker and prepare_activation allow the exact horizon', async () => {
  const f = fixture(1n),
    board = f.boot()
  expect(
    await board.selectWorker({ address: creator }, { taskId: f.terms.taskId, applicationId: 'app-1' }),
  ).toHaveProperty('sign')
  expect(await board.prepareActivation({ address: worker }, { taskId: f.terms.taskId })).toHaveProperty('sign')
  expect(f.sql.all('SELECT * FROM activation_preps')).toHaveLength(1)
})
