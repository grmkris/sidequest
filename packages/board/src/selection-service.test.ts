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
  const boot = (extra: Partial<ConstructorParameters<typeof Board>[1]> = {}) =>
    new Board(sql, {
      network: 'monad-testnet',
      contexts: { main: ctx },
      domain: 'fixture.test',
      uri: 'https://fixture.test',
      manifestBaseUrl: 'https://fixture.test/offers',
      now: () => now,
      ...extra,
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

it('select_worker reads a legacy REAL-text agent id ("10415.0", prod job 17) instead of failing internal', async () => {
  const f = fixture(1n),
    board = f.boot()
  f.sql.run("UPDATE applications SET agent_id = CAST(7001 AS REAL) WHERE id = 'app-1'")
  expect(f.sql.all<{ agent_id: string }>("SELECT agent_id FROM applications WHERE id = 'app-1'")[0]!.agent_id).toBe(
    '7001.0',
  )
  const signed = await board.selectWorker({ address: creator }, { taskId: f.terms.taskId, applicationId: 'app-1' })
  expect(JSON.parse(signed.sign.typedData).message.agentId).toBe('7001')
  expect(f.sql.all<{ agent_id: string }>("SELECT agent_id FROM applications WHERE id = 'app-1'")[0]!.agent_id).toBe(
    '7001',
  )
})

it('select_worker refuses a malformed stored agent id as invalid before writing a selection', async () => {
  const f = fixture(1n),
    board = f.boot()
  f.sql.run("UPDATE applications SET agent_id = '7001.5' WHERE id = 'app-1'")
  await expect(
    board.selectWorker({ address: creator }, { taskId: f.terms.taskId, applicationId: 'app-1' }),
  ).rejects.toMatchObject({ code: 'invalid' })
  expect(f.sql.all('SELECT * FROM selections')).toHaveLength(1)
})

it('apply stores a numeric agent id canonically, so select_worker can sign it', async () => {
  const f = fixture(1n),
    board = f.boot()
  // A JSON client (e.g. Python) that sends the id as a number; bound raw it became "7001.0" on Workers SQLite.
  await board.apply({ address: worker }, { taskId: f.terms.taskId, agentId: 7001 })
  expect(f.sql.all<{ agent_id: string }>("SELECT agent_id FROM applications WHERE id = 'app-1'")[0]!.agent_id).toBe(
    '7001',
  )
  await expect(board.apply({ address: worker }, { taskId: f.terms.taskId, agentId: '7001.0' })).rejects.toMatchObject({
    code: 'invalid',
  })
})

it('apply refuses the task creator applying to its own task', async () => {
  const f = fixture(1n),
    board = f.boot()
  vi.mocked(sdk.agentWallet).mockResolvedValue(creator)
  await expect(board.apply({ address: creator }, { taskId: f.terms.taskId, agentId: '7002' })).rejects.toMatchObject({
    code: 'forbidden',
  })
  expect(f.sql.all('SELECT * FROM applications WHERE lower(worker) = ?', creator.toLowerCase())).toHaveLength(0)
})

const operator = '0x4444444444444444444444444444444444444444' as const
const sibling = '0x5555555555555555555555555555555555555555' as const
/** The creator is a hosted agent run by `operator`; so is `sibling`. Anyone else is not hosted. */
const hostedOperators = vi.fn(async (addresses: readonly Address[]) =>
  [
    { address: creator, operator },
    { address: sibling, operator },
  ].filter((agent) => addresses.some((a) => a.toLowerCase() === agent.address.toLowerCase())),
)

describe('applicants: public facts, the operator view and same-operator applications', () => {
  it('get_task shows anyone the count, agent IDs and times, never notes or wallets', async () => {
    const f = fixture()
    for (const address of [undefined, curator]) {
      const task = await f.get(address)
      expect(task).toMatchObject({ applicationCount: 1, applicants: [{ agentId: '7001', appliedAt: 0 }] })
      expect(JSON.stringify(task.applicants)).not.toMatch(/Test only|0x2222/)
    }
  })

  it('get_task names the signed, unexpired selection publicly, and drops it once activateBy passes', async () => {
    const f = fixture()
    expect((await f.get()).pendingSelection).toEqual({ agentId: '7001', activateBy: 1_100 })
    f.setNow(1_101)
    expect((await f.get()).pendingSelection).toBeNull()
  })

  it("lets a hosted creator's operator read list_applications, and nobody else but the creator", async () => {
    const f = fixture()
    const board = f.boot({ hostedOperators })
    expect(await board.listApplications({ address: operator }, { taskId: f.terms.taskId })).toHaveLength(1)
    expect(await board.listApplications({ address: creator }, { taskId: f.terms.taskId })).toHaveLength(1)
    await expect(board.listApplications({ address: curator }, { taskId: f.terms.taskId })).rejects.toMatchObject({
      code: 'forbidden',
    })
    // A sibling agent of the same operator is not the operator.
    await expect(board.listApplications({ address: sibling }, { taskId: f.terms.taskId })).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('fails closed when the operator lookup is absent or does not answer', async () => {
    const f = fixture()
    await expect(f.boot().listApplications({ address: operator }, { taskId: f.terms.taskId })).rejects.toMatchObject({
      code: 'forbidden',
    })
    const broken = f.boot({ hostedOperators: async () => Promise.reject(new Error('down')) })
    await expect(broken.listApplications({ address: operator }, { taskId: f.terms.taskId })).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it("refuses an application from the creator's operator or its sibling agent, and admits an outsider", async () => {
    const f = fixture(1n)
    const board = f.boot({ hostedOperators })
    for (const wallet of [operator, sibling]) {
      vi.mocked(sdk.agentWallet).mockResolvedValue(wallet)
      await expect(board.apply({ address: wallet }, { taskId: f.terms.taskId, agentId: '7003' })).rejects.toMatchObject(
        { code: 'forbidden' },
      )
    }
    vi.mocked(sdk.agentWallet).mockResolvedValue(worker)
    await board.apply({ address: worker }, { taskId: f.terms.taskId, agentId: 7001 })
    expect(f.sql.all('SELECT * FROM applications')).toHaveLength(1)
    const down = f.boot({ hostedOperators: async () => Promise.reject(new Error('down')) })
    await expect(down.apply({ address: worker }, { taskId: f.terms.taskId, agentId: '7001' })).rejects.toMatchObject({
      code: 'unavailable',
    })
  })
})

const unsigned = (f: ReturnType<typeof fixture>) =>
  f.sql.all<{ nonce: string; activate_by: number }>('SELECT nonce, activate_by FROM selections WHERE signature IS NULL')

describe('select_worker unsigned selections and chain reads', () => {
  it('hands a repeat call the same unsigned selection instead of piling up rows', async () => {
    const f = fixture(1n),
      board = f.boot()
    const first = await board.selectWorker({ address: creator }, { taskId: f.terms.taskId, applicationId: 'app-1' })
    f.setNow(1_030)
    const again = await board.selectWorker({ address: creator }, { taskId: f.terms.taskId, applicationId: 'app-1' })
    expect(again.nonce).toBe(first.nonce)
    expect(again.sign.typedData).toBe(first.sign.typedData)
    expect(unsigned(f)).toHaveLength(1)
    // An explicit, different activateBy is a different message: a new row.
    const explicit = await board.selectWorker(
      { address: creator },
      { taskId: f.terms.taskId, applicationId: 'app-1', activateBy: 1_120 },
    )
    expect(explicit.nonce).not.toBe(first.nonce)
    expect(unsigned(f)).toHaveLength(2)
  })

  it('drops unsigned selections that can no longer be signed', async () => {
    const f = fixture(1n),
      board = f.boot()
    f.sql.run(
      'INSERT INTO selections (task_id, nonce, application_id, worker, agent_id, activate_by, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
      f.terms.taskId,
      '99',
      'app-1',
      worker,
      '7001',
      999,
      5,
    )
    await board.selectWorker({ address: creator }, { taskId: f.terms.taskId, applicationId: 'app-1' })
    expect(unsigned(f).map((r) => r.nonce)).not.toContain('99')
    // The signed selection is kept.
    expect(f.sql.all('SELECT * FROM selections WHERE signature IS NOT NULL')).toHaveLength(1)
  })

  it('answers retryably instead of hanging when a chain read stalls', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture(1n),
        board = f.boot()
      // The RPC never answers the listing read.
      f.read.mockImplementation(() => new Promise(() => {}))
      const pending = board.selectWorker({ address: creator }, { taskId: f.terms.taskId, applicationId: 'app-1' })
      const settled = expect(pending).rejects.toMatchObject({
        code: 'unavailable',
        reason: 'chain-timeout',
        retry: 'same-key',
      })
      await vi.advanceTimersByTimeAsync(8_000)
      await settled
      expect(unsigned(f)).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
