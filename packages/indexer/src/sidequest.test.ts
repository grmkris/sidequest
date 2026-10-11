/** ABI-encoded v1 logs in real SQLite. No RPC writes. */
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import {
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
  encodeAbiParameters,
  encodeEventTopics,
  stringToHex,
} from 'viem'
import { describe, expect, it } from 'vitest'
import {
  type AsyncSql,
  type IndexerConfig,
  type RawLog,
  contractsFromDeployment,
  decode,
  fromNodeSqlite,
  agentDetail,
  jobDetail,
  listAgents,
  migrate,
  networkStats,
  protocolEvents,
  resetIndex,
  runOnce,
  stmt,
} from './index.ts'

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`
const d: sdk.Deployment = {
  ...sdk.deployment('monad-testnet'),
  stacks: { main: { kind: 'sidequest-v1', factory: addr(1), holding: addr(2), evaluator: addr(3), openTokens: true } },
  sidequest: {
    block: 100n,
    safe: addr(9),
    factory: addr(1),
    vault: addr(4),
    feeSchedule: addr(5),
  },
}
const contracts = contractsFromDeployment(d)
const creator = addr(20),
  worker = addr(21),
  approver = addr(22),
  arbitrator = addr(23),
  token = addr(24)
const holding = sdk.sidequestHoldingAbi as Abi,
  evaluator = sdk.sidequestEvaluatorAbi as Abi

/** Encode exactly the event's indexed topics and non-indexed data from the generated contract ABI. */
function log(
  abi: Abi,
  address: Address,
  name: string,
  args: Record<string, unknown>,
  block: number,
  index = 0,
): RawLog {
  const event = abi.find((item): item is AbiEvent => item.type === 'event' && item.name === name)!
  for (const input of event.inputs)
    if (args[input.name!] === undefined) throw new Error(`Missing ${name}.${input.name}`)
  const topics = encodeEventTopics({ abi: [event], eventName: name, args } as never) as Hex[]
  const dataInputs = event.inputs.filter((p) => !p.indexed)
  return {
    address,
    block_number: block,
    log_index: index,
    transaction_hash: hash(block),
    topic0: topics[0] ?? null,
    topic1: topics[1] ?? null,
    topic2: topics[2] ?? null,
    topic3: topics[3] ?? null,
    data: encodeAbiParameters(
      dataInputs,
      dataInputs.map((p) => args[p.name!]),
    ),
  }
}

function published(id = 1000n, block = 100, by: Address = creator) {
  return log(
    holding,
    addr(2),
    'Published',
    {
      jobId: id,
      creator: by,
      approver,
      arbitrator,
      token,
      reward: 1000n,
      creatorBond: 100n,
      workerBond: 200n,
      manifestHash: hash(1),
      policyHash: hash(2),
      deliveryDeadline: 10_000,
      expiredAt: 60_000,
      reviewWindow: 3600,
      disputeWindow: 7200,
      arbitrationWindow: 43_200,
    },
    block,
  )
}
function activated(id = 1000n, block = 101) {
  return log(
    holding,
    addr(2),
    'Activated',
    { jobId: id, worker, agentId: 7n, selectionNonce: 1n, feeBps: 1000, fee: 100n, net: 900n, workerBond: 200n },
    block,
  )
}
const paidLogs = [
  published(),
  activated(),
  log(holding, addr(2), 'ToppedUp', { jobId: 1000n, contributor: creator, amount: 100n, bonus: 100n }, 102),
  log(
    evaluator,
    addr(3),
    'Ruled',
    { jobId: 1000n, arbitrator, forWorker: true, slashLoser: true, reasonHash: hash(3) },
    103,
  ),
  log(holding, addr(2), 'BondSlashed', { jobId: 1000n, side: 0, account: creator, amount: 100n }, 103, 1),
  log(holding, addr(2), 'BondReleased', { jobId: 1000n, side: 1, account: worker, amount: 200n }, 103, 2),
  log(evaluator, addr(3), 'PayoutDeferred', { jobId: 1000n, refundedToHolding: true }, 103, 3),
  log(sdk.coreAbi as Abi, d.core, 'JobRejected', { jobId: 1000n, rejector: addr(3), reason: hash(4) }, 103, 4),
  log(holding, addr(2), 'RewardSettled', { jobId: 1000n, to: worker, outcome: 1, amount: 990n }, 104),
  log(holding, addr(2), 'FeeCharged', { jobId: 1000n, token, worker, creator, amount: 110n, bonusPart: 10n }, 104, 1),
  log(holding, addr(2), 'PayoutOwed', { jobId: 1000n, to: worker, token, amount: 990n }, 104, 2),
  log(
    sdk.stakeVaultAbi as Abi,
    addr(4),
    'Delegated',
    { account: worker, delegator: worker, payer: worker, assets: 10_000n, shares: 10_000n },
    100,
    1,
  ),
  log(sdk.stakeVaultAbi as Abi, addr(4), 'Reserved', { holding: addr(2), account: worker, amount: 200n }, 101, 1),
  log(
    sdk.feeScheduleAbi as Abi,
    addr(5),
    'ScheduleExecuted',
    { thresholds: [0n, 10_000n, 100_000n, 1_000_000n], bps: [3000, 1000, 300, 100], treasury: addr(9) },
    107,
  ),
]

function cfg(logs: RawLog[], pageSize = 50, finalized = 110, deployment = d): IndexerConfig {
  return {
    contracts: deployment === d ? contracts : contractsFromDeployment(deployment),
    deployBlock: 100,
    runner: 'test',
    now: () => 1_000,
    maxPages: 20,
    head: {
      finalizedBlock: async () => finalized,
      blockHash: async (block) => hash(block),
      blockTimestamp: async (block) => 10_000 + block,
    },
    source: {
      logs: async ({ fromBlock, toBlock }) => {
        const end = Math.min(fromBlock + pageSize, toBlock)
        return { logs: logs.filter((l) => l.block_number >= fromBlock && l.block_number < end), nextBlock: end }
      },
    },
  }
}
async function db() {
  const sql = fromNodeSqlite(new DatabaseSync(':memory:'))
  await migrate(sql)
  return sql
}
async function snapshot(sql: AsyncSql) {
  return Promise.all(
    [
      'events',
      'protocol_events',
      'jobs',
      'top_ups',
      'fee_charges',
      'payout_owed',
      'reward_outcomes',
      'bond_outcomes',
      'rulings',
    ].map((table) => sql.all(`SELECT * FROM ${table} ORDER BY 1, 2, 3, 4`)),
  )
}

describe('Sidequest event indexing', () => {
  it('replays unfilled bond forfeitures without including them in success fees or mining accounting', async () => {
    const sql = await db()
    const paid = log(
      holding,
      addr(2),
      'BondForfeited',
      { jobId: 1000n, creator, treasury: addr(9), amount: 25n },
      100,
      1,
    )
    expect(decode(contracts, paid)).toMatchObject({
      jobId: '1000',
      name: 'BondForfeited',
      args: { amount: 25n.toString(), treasury: addr(9) },
    })
    await runOnce(sql, cfg([published(), paid]))
    const detail = await jobDetail(sql, contracts.chainId, '1000', 0)
    expect(detail?.timeline.filter((event) => event.name === 'BondForfeited')).toHaveLength(1)
    expect(detail?.bonds).toEqual([
      expect.objectContaining({ side: 'creator', outcome: 'forfeited', recipient: addr(9), amount: '25' }),
    ])
    expect(detail?.fees).toEqual([])
    expect(detail?.job.charged_fee).toBe('0')
    expect(await sql.all('SELECT * FROM fee_charges')).toEqual([])
    expect(await protocolEvents(sql, contracts.chainId)).toEqual([])
    const before = await snapshot(sql)
    const accounting = (await networkStats(sql, contracts.chainId)).accounting
    await sql.batch([stmt('UPDATE checkpoint SET next_block = 100, block_hash = NULL')])
    await runOnce(sql, cfg([published(), paid, paid], 1))
    expect(await snapshot(sql)).toEqual(before)
    expect((await networkStats(sql, contracts.chainId)).accounting).toEqual(accounting)
  })
  it('uses the emitted release after a late penalty finding instead of the evaluator outcome', async () => {
    const sql = await db()
    const late = [
      published(),
      activated(),
      log(
        evaluator,
        addr(3),
        'TimedOut',
        { jobId: 1000n, reason: stringToHex('delivery-deadline', { size: 32 }) },
        103,
      ),
      log(sdk.coreAbi, d.core, 'JobRejected', { jobId: 1000n, rejector: addr(3), reason: hash(4) }, 103, 1),
      log(holding, addr(2), 'BondReleased', { jobId: 1000n, side: 0, account: creator, amount: 100n }, 104),
      log(holding, addr(2), 'BondReleased', { jobId: 1000n, side: 1, account: worker, amount: 200n }, 104, 1),
      log(holding, addr(2), 'RewardSettled', { jobId: 1000n, to: creator, outcome: 2, amount: 1000n }, 104, 2),
    ]
    const config = cfg(late)
    config.head.blockTimestamp = async () => 60_000
    await runOnce(sql, config)
    const detail = await jobDetail(sql, contracts.chainId, '1000', 0)
    expect(detail?.job.outcome).toBe('DeliveryMissed')
    expect(detail?.bonds).toEqual(
      expect.arrayContaining([expect.objectContaining({ side: 'worker', outcome: 'returned', recipient: worker })]),
    )
    expect(detail?.bonds).not.toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'burned' })]))
  })

  it('headline accounting separates gross, fee, net earned and a refused worker transfer', async () => {
    const sql = await db()
    await runOnce(sql, cfg(paidLogs))
    const stats = await networkStats(sql, contracts.chainId)
    expect(stats.accounting[token]).toEqual({ gross: '1100', fee: '110', net: '990', paid: '0' })
  })

  it('folds fees, windows, top-ups, paid rights, deferrals and reserved stake bonds', async () => {
    const sql = await db()
    const result = await runOnce(sql, cfg(paidLogs))
    expect(result.jobs).toBe(1)
    const detail = await jobDetail(sql, contracts.chainId, '1000', 0)
    expect(detail?.job).toMatchObject({
      kind: 'sidequest-v1',
      mode: 'hire',
      selection_deadline: null,
      arbitrator,
      review_window: 3600,
      manifest_hash: hash(1),
      policy_hash: hash(2),
      dispute_window: 7200,
      arbitration_window: 43_200,
      expired_at: 60_000,
      fee_bps: 1000,
      fee: '100',
      net: '900',
      bonus: '100',
      charged_fee: '110',
      bonus_fee: '10',
      outcome: 'RuledForWorker',
      settlement_outcome: 'Paid',
      payout_deferred: 1,
      refunded_to_holding: 1,
      status: 'rejected',
    })
    expect(detail?.topUps).toMatchObject([{ contributor: creator, amount: '100', refunded: 0 }])
    expect(detail?.fees).toMatchObject([{ token, worker, creator, amount: '110', bonus_part: '10' }])
    expect(detail?.payoutsOwed).toMatchObject([{ recipient: worker, token, amount: '990' }])
    expect(detail?.rewards).toMatchObject([{ kind: 'owed', recipient: worker, amount: '990' }])
    expect(await listAgents(sql, contracts.chainId)).toMatchObject([
      { agentId: '7', completed: 1, lost: 0, earned: {} },
    ])
    expect(detail?.bonds).toMatchObject([
      { side: 'creator', outcome: 'burned', recipient: creator },
      { side: 'worker', outcome: 'returned', recipient: worker },
    ])
    const protocol = await protocolEvents(sql, contracts.chainId)
    expect(protocol.map((e) => e.name)).toEqual(['Delegated', 'Reserved', 'ScheduleExecuted'])
    expect(protocol.every((e) => e.at === 10_000 + e.block)).toBe(true)
    expect(protocol.at(-1)?.args.thresholds).toEqual(['0', '10000', '100000', '1000000'])
    expect(
      (await protocolEvents(sql, contracts.chainId, { contract: addr(4), fromBlock: 101 })).map((e) => e.name),
    ).toEqual(['Reserved'])
  })

  it('keeps fast per-job windows without deriving them from wall-clock constants', async () => {
    const sql = await db()
    const logs = [
      log(
        holding,
        addr(2),
        'Published',
        { ...decode(contracts, published())!.args, reviewWindow: 120, disputeWindow: 120, arbitrationWindow: 300 },
        100,
      ),
    ]
    await runOnce(sql, cfg(logs))
    expect((await jobDetail(sql, contracts.chainId, '1000', 0))?.job).toMatchObject({
      review_window: 120,
      dispute_window: 120,
      arbitration_window: 300,
    })
  })

  it('records creator refunds, top-up claims and permissionless outcomes separately', async () => {
    const sql = await db()
    const logs = [
      published(),
      activated(),
      log(
        evaluator,
        addr(3),
        'TimedOut',
        { jobId: 1000n, reason: stringToHex('arbitration-window', { size: 32 }) },
        102,
      ),
      log(evaluator, addr(3), 'RefundDeferred', { jobId: 1000n }, 102, 1),
      log(holding, addr(2), 'RewardSettled', { jobId: 1000n, to: creator, outcome: 2, amount: 1000n }, 103),
      log(holding, addr(2), 'TopUpRefunded', { jobId: 1000n, contributor: creator, amount: 100n }, 104),
    ]
    await runOnce(sql, cfg(logs))
    const detail = await jobDetail(sql, contracts.chainId, '1000', 0)
    expect(detail?.job).toMatchObject({
      outcome: 'ArbitrationTimeout',
      settlement_outcome: 'Refunded',
      refund_deferred: 1,
    })
    expect(detail?.rewards).toMatchObject([{ kind: 'refunded', recipient: creator, amount: '1000' }])
    expect(detail?.topUps).toMatchObject([{ amount: '100', refunded: 1 }])
  })

  it('counts the core net payment and a successfully settled bonus once, without counting the fee as earnings', async () => {
    const sql = await db()
    const logs = [
      published(),
      activated(),
      log(holding, addr(2), 'ToppedUp', { jobId: 1000n, contributor: creator, amount: 100n, bonus: 100n }, 102),
      log(evaluator, addr(3), 'Accepted', { jobId: 1000n, approver }, 103),
      log(sdk.coreAbi as Abi, d.core, 'PaymentReleased', { jobId: 1000n, recipient: worker, amount: 900n }, 103, 1),
      log(sdk.coreAbi as Abi, d.core, 'JobCompleted', { jobId: 1000n, evaluator: addr(3), reason: hash(1) }, 103, 2),
      log(holding, addr(2), 'RewardSettled', { jobId: 1000n, to: worker, outcome: 1, amount: 90n }, 104),
      log(
        holding,
        addr(2),
        'FeeCharged',
        { jobId: 1000n, token, worker, creator, amount: 110n, bonusPart: 10n },
        104,
        1,
      ),
    ]
    await runOnce(sql, cfg(logs))
    expect((await jobDetail(sql, contracts.chainId, '1000', 0))?.job).toMatchObject({
      status: 'completed',
      outcome: 'Accepted',
      settlement_outcome: 'Paid',
    })
    expect(await listAgents(sql, contracts.chainId)).toMatchObject([
      { completed: 1, lost: 0, earned: { [token]: '990' } },
    ])
  })

  it("an agent's record holds the jobs its wallets posted, gross/fee/net per side, and its timings", async () => {
    const sql = await db()
    const logs = [
      published(),
      activated(),
      log(holding, addr(2), 'ToppedUp', { jobId: 1000n, contributor: creator, amount: 100n, bonus: 100n }, 102),
      log(sdk.coreAbi as Abi, d.core, 'JobSubmitted', { jobId: 1000n, provider: worker, deliverable: hash(5) }, 103),
      log(evaluator, addr(3), 'Accepted', { jobId: 1000n, approver }, 104),
      log(sdk.coreAbi as Abi, d.core, 'PaymentReleased', { jobId: 1000n, recipient: worker, amount: 900n }, 104, 1),
      log(sdk.coreAbi as Abi, d.core, 'JobCompleted', { jobId: 1000n, evaluator: addr(3), reason: hash(1) }, 104, 2),
      log(holding, addr(2), 'RewardSettled', { jobId: 1000n, to: worker, outcome: 1, amount: 90n }, 105),
      log(
        holding,
        addr(2),
        'FeeCharged',
        { jobId: 1000n, token, worker, creator, amount: 110n, bonusPart: 10n },
        105,
        1,
      ),
      // Agent 7's wallet posts a job of its own.
      published(1001n, 106, worker),
    ]
    await runOnce(sql, cfg(logs))
    const seven = await agentDetail(sql, contracts.chainId, '7')
    expect(seven?.jobs.map((j) => j.job_id)).toEqual(['1000'])
    expect(seven?.wallets).toEqual([worker])
    expect(seven?.posted.map((j) => j.job_id)).toEqual(['1001'])
    expect(seven?.hiring).toEqual({ posted: 1, open: 1, paidOut: {} })
    expect(seven?.work.earned).toEqual({ [token]: { gross: '1100', fee: '110', net: '990' } })
    // Block times are 10_000 + block: activated at 101, submitted at 103, last event at 106.
    expect(seven?.time).toEqual({ activeSince: 10_101, lastActive: 10_106, medianTurnaroundSeconds: 2, turnarounds: 1 })

    // An agent that took nothing: its record is the hiring its known wallet did, paid out gross/fee/net.
    const hirer = await agentDetail(sql, contracts.chainId, '8', [creator.toUpperCase().replace('0X', '0x')])
    expect(hirer?.agent).toMatchObject({ agentId: '8', jobs: 0, completed: 0 })
    expect(hirer?.jobs).toEqual([])
    expect(hirer?.posted.map((j) => j.job_id)).toEqual(['1000'])
    expect(hirer?.hiring).toEqual({
      posted: 1,
      open: 0,
      paidOut: { [token]: { gross: '1100', fee: '110', net: '990' } },
    })
    expect(hirer?.time.activeSince).toBe(10_100)
    expect(await agentDetail(sql, contracts.chainId, '9')).toBeUndefined()
  })

  it('replay, small pages, restart and rebuild preserve job and protocol rows', async () => {
    const sql = await db()
    await runOnce(sql, cfg(paidLogs))
    const live = await snapshot(sql)
    await sql.batch([stmt('UPDATE checkpoint SET next_block = 100, block_hash = NULL')])
    await runOnce(sql, cfg(paidLogs, 1))
    expect(await snapshot(sql)).toEqual(live)
    await resetIndex(sql, cfg(paidLogs))
    expect(await sql.all('SELECT * FROM protocol_events')).toEqual([])
    await runOnce(sql, cfg(paidLogs, 3))
    expect(await snapshot(sql)).toEqual(live)
  })

  it('a failed atomic page leaves neither protocol rows nor job rows or checkpoint', async () => {
    const sql = await db()
    const broken: AsyncSql = {
      all: sql.all,
      batch: async (statements) =>
        sql.batch(
          statements.some((s) => s.query.includes('INSERT OR IGNORE INTO events'))
            ? [...statements, stmt('INSERT INTO missing_table VALUES (1)')]
            : statements,
        ),
    }
    await expect(runOnce(broken, cfg(paidLogs))).rejects.toThrow()
    for (const table of ['events', 'protocol_events', 'jobs', 'checkpoint'])
      expect(await sql.all(`SELECT * FROM ${table}`)).toEqual([])
    await runOnce(sql, cfg(paidLogs))
    expect((await protocolEvents(sql, contracts.chainId)).length).toBe(3)
  })

  it('rewinds both paths and restores a pre-ruling job from retained events', async () => {
    const sql = await db()
    const config = cfg(paidLogs)
    await runOnce(sql, config)
    const rewound = await runOnce(sql, {
      ...config,
      maxPages: 0,
      rewindBlocks: 9,
      head: { ...config.head, blockHash: async () => hash(999) },
    })
    expect(rewound.rewound).toBe(true)
    expect(await sql.all('SELECT * FROM events WHERE block >= 102')).toEqual([])
    expect(await sql.all('SELECT * FROM protocol_events WHERE block >= 102')).toEqual([])
    expect((await jobDetail(sql, contracts.chainId, '1000', 0))?.job).toMatchObject({
      status: 'active',
      outcome: 'None',
      bonus: '0',
      payout_deferred: 0,
    })
    await runOnce(sql, config)
    expect((await jobDetail(sql, contracts.chainId, '1000', 0))?.job.outcome).toBe('RuledForWorker')
  })
})
