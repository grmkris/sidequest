/** Board tools + SQLite index + real local Monad v1 contracts. No remote sends. */
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { Board, fromNodeSqlite as boardSql } from '@sidequest/board'
import {
  contractsFromDeployment,
  decode,
  foldJob,
  fromNodeSqlite,
  migrate,
  stmt,
  type IndexedEvent,
} from '@sidequest/indexer'
import { type Address, decodeFunctionData, encodeFunctionData, parseAbi, parseEther } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { forkEnabled, forkSetupTimeout, startSidequestFork } from '../../../packages/sdk/test/sidequest-fixture.ts'
import { collectSnapshot } from '../src/collect-index.ts'

const fork = forkEnabled ? describe : describe.skip
const actor = (w: sdk.Wallet) => ({ address: w.account.address })
fork('B4 wallet tools and all-pair Collect on a real local Monad fork', () => {
  let f: Awaited<ReturnType<typeof startSidequestFork>>,
    board: Board,
    db: DatabaseSync,
    index: DatabaseSync,
    start: bigint,
    agentId: bigint
  let ctx: sdk.Ctx
  let boardNow: number
  const boot = () =>
    new Board(boardSql(db), {
      network: 'monad-testnet',
      contexts: { main: ctx },
      domain: 'fork.test',
      uri: 'https://fork.test',
      manifestBaseUrl: 'https://fork.test/offers',
      now: () => boardNow,
      collectSnapshot: async (wallet) =>
        collectSnapshot(fromNodeSqlite(index), ctx, wallet, Number((await ctx.publicClient.getBlock()).timestamp)),
    })
  beforeAll(async () => {
    f = await startSidequestFork()
    ctx = f.ctx
    db = new DatabaseSync(':memory:')
    index = new DatabaseSync(':memory:')
    start = await ctx.publicClient.getBlockNumber()
    boardNow = Number((await ctx.publicClient.getBlock()).timestamp)
    board = boot()
    await migrate(fromNodeSqlite(index))
    agentId = await sdk.registerAgent(ctx, f.worker, 'https://sidequest.exchange/b4-fork')
  }, forkSetupTimeout())
  afterAll(() => {
    db?.close()
    index?.close()
    f?.close()
  })
  async function indexNow() {
    const block = await ctx.publicClient.getBlock(),
      contracts = contractsFromDeployment(ctx.deployment)
    const logs = await ctx.publicClient.getLogs({
      address: [...contracts.roles.keys()] as `0x${string}`[],
      fromBlock: start,
      toBlock: block.number!,
    })
    const events = logs
      .map((l) =>
        decode(contracts, {
          block_number: Number(l.blockNumber),
          log_index: l.logIndex!,
          transaction_hash: l.transactionHash!,
          address: l.address,
          data: l.data,
          topic0: l.topics[0] ?? null,
          topic1: l.topics[1] ?? null,
          topic2: l.topics[2] ?? null,
          topic3: l.topics[3] ?? null,
        }),
      )
      .filter((e): e is IndexedEvent => e !== undefined)
    const sql = fromNodeSqlite(index)
    await sql.batch(
      events
        .filter((e) => e.jobId !== null)
        .map((e) =>
          stmt(
            'INSERT OR REPLACE INTO events (chain_id,contract,block,log_index,tx_hash,job_id,name,args_json) VALUES (?,?,?,?,?,?,?,?)',
            e.chainId,
            e.contract,
            e.block,
            e.logIndex,
            e.txHash,
            e.jobId,
            e.name,
            JSON.stringify(e.args),
          ),
        ),
    )
    await sql.batch(
      events
        .filter((e) => e.jobId === null)
        .map((e) =>
          stmt(
            'INSERT OR REPLACE INTO protocol_events (chain_id,contract,block,log_index,tx_hash,name,args_json) VALUES (?,?,?,?,?,?,?)',
            e.chainId,
            e.contract,
            e.block,
            e.logIndex,
            e.txHash,
            e.name,
            JSON.stringify(e.args),
          ),
        ),
    )
    for (const id of new Set(events.flatMap((e) => (e.jobId === null ? [] : [e.jobId]))))
      await sql.batch(
        foldJob(
          contracts,
          ctx.deployment.chainId,
          id,
          events.filter((e) => e.jobId === id),
        ),
      )
    await sql.batch([
      stmt(
        'INSERT OR REPLACE INTO checkpoint (chain_id,next_block,block_hash,updated_at) VALUES (?,?,?,?)',
        ctx.deployment.chainId,
        Number(block.number! + 1n),
        block.hash,
        Number(block.timestamp),
      ),
    ])
  }
  async function listed(token: Address = ctx.stack.factory) {
    for (const wallet of [f.creator, f.worker]) {
      const state = await sdk.getBacking(ctx, wallet.account.address)
      if (state.available < parseEther('10'))
        await sdk.sendAll(wallet, ctx.publicClient, (await board.stake(actor(wallet), { amount: '100' })).transactions)
    }
    const now = Number((await ctx.publicClient.getBlock()).timestamp)
    boardNow = now
    const created = await board.createTask(actor(f.creator), {
      title: 'Collect fork',
      brief: 'Real contracts',
      acceptanceCriteria: ['finished'],
      token,
      reward: '1',
      creatorBond: '10',
      workerBond: '10',
      deliveryDeadline: now + 3600,
      windows: { reviewSeconds: 3600, disputeSeconds: 3600, arbitrationSeconds: 43200 },
      invite: { agentId: agentId.toString() },
    })
    const hashes = await sdk.sendAll(f.creator, ctx.publicClient, created.transactions)
    const task = await board.reportTransaction(actor(f.creator), { taskId: created.taskId, txHash: hashes.at(-1)! })
    const selected = await board.selectWorker(actor(f.creator), {
      taskId: created.taskId,
      applicationId: created.applicationId!,
    })
    await board.submitSelection(actor(f.creator), {
      taskId: created.taskId,
      nonce: selected.nonce,
      signature: await sdk.signTypedDataJson(f.creator, selected.sign.typedData),
    })
    const prep = await board.prepareActivation(actor(f.worker), { taskId: created.taskId })
    const act = await board.buildActivation(actor(f.worker), {
      taskId: created.taskId,
      budgetSignature: await sdk.signTypedDataJson(f.worker, prep.sign.typedData),
    })
    await sdk.sendAll(f.worker, ctx.publicClient, act.transactions)
    return { ...created, jobId: BigInt(task.jobId!) }
  }
  it('prepares exact stake amounts, fee quotes, top-ups and unreserved cooldown withdrawals', async () => {
    for (const wallet of [f.creator, f.worker]) {
      const prep = await board.stake(actor(wallet), { amount: '100' })
      expect(prep.amount).toBe(parseEther('100').toString())
      const args = decodeFunctionData({ abi: sdk.factoryV2Abi, data: prep.transactions[0]!.data }).args as readonly [
        string,
        bigint,
      ]
      expect([args[0]!.toLowerCase(), args[1]]).toEqual([
        ctx.deployment.sidequest!.vault.toLowerCase(),
        parseEther('100'),
      ])
      const stakeHashes = await sdk.sendAll(wallet, ctx.publicClient, prep.transactions)
      const stakeReport = await board.reportOperation(actor(wallet), {
        operationId: prep.operationId,
        txHash: stakeHashes.at(-1)!,
      })
      expect(stakeReport).toMatchObject({
        operationId: prep.operationId,
        kind: 'stake',
        status: 'confirmed',
        txHash: stakeHashes.at(-1)!,
      })
    }
    const x = await listed()
    expect(await board.getStake({}, { wallet: f.worker.account.address })).toMatchObject({
      staked: parseEther('100').toString(),
      reserved: parseEther('10').toString(),
      available: parseEther('90').toString(),
    })
    expect(await board.feeQuote({}, { taskId: x.taskId, worker: f.worker.account.address })).toEqual({
      feeBps: 3000,
      fee: parseEther('0.3').toString(),
      net: parseEther('0.7').toString(),
    })
    await expect(board.requestUnstake(actor(f.worker), { amount: '101' })).rejects.toThrow('owned position')
    const top = await board.topUp(actor(f.contributor), { taskId: x.taskId, amount: '0.25' })
    expect(top.transactions).toHaveLength(2)
    const topHashes = await sdk.sendAll(f.contributor, ctx.publicClient, top.transactions)
    await board.reportTransaction(actor(f.worker), { taskId: x.taskId, txHash: topHashes.at(-1)! })
    expect(db.prepare('SELECT status FROM operations WHERE id=?').get(top.operationId)).toEqual({ status: 'confirmed' })
    expect((await sdk.getV1Listing(ctx, x.jobId)).bonus).toBe(parseEther('0.25'))
    await expect(
      board.topUp(actor(f.contributor), { taskId: x.taskId, amount: '0.0000000000000000001' }),
    ).rejects.toThrow('fractional')
    const unstake = await board.requestUnstake(actor(f.contributor), { amount: '1' }).catch(() => null)
    expect(unstake).toBeNull()
    const contributorStake = await board.stake(actor(f.contributor), { amount: '2' })
    await sdk.sendAll(f.contributor, ctx.publicClient, contributorStake.transactions)
    const contributorUnstake = await board.requestUnstake(actor(f.contributor), { amount: '1' })
    const contributorUnstakeHashes = await sdk.sendAll(f.contributor, ctx.publicClient, contributorUnstake.transactions)
    expect(
      (
        await board.reportOperation(actor(f.contributor), {
          operationId: contributorUnstake.operationId,
          txHash: contributorUnstakeHashes.at(-1)!,
        })
      ).status,
    ).toBe('confirmed')
    await expect(board.withdrawStake(actor(f.contributor))).rejects.toThrow('cooldown')
    await sdk.submit(ctx, f.worker, x.jobId, sdk.hashText('finished'))
    await sdk.accept(ctx, f.creator, x.jobId)
    await indexNow()
    const actions = await board.collectActions({}, { wallet: f.creator.account.address })
    expect(
      actions.find((a) => a.jobId === x.jobId.toString() && a.kind === 'settle')?.transactions.map((t) => t.gas),
    ).toEqual(['1000000'])
    await sdk.sendAll(
      f.creator,
      ctx.publicClient,
      actions.find((a) => a.jobId === x.jobId.toString() && a.kind === 'settle')!.transactions,
    )
    await indexNow()
    expect(
      (await board.collectActions({}, { wallet: f.creator.account.address })).some(
        (a) => a.jobId === x.jobId.toString(),
      ),
    ).toBe(false)
    const state = await sdk.getPosition(ctx, f.contributor.account.address, f.contributor.account.address)
    await f.rpc('evm_setNextBlockTimestamp', [state.unlockAt])
    await f.rpc('evm_mine')
    await indexNow()
    const stake = (await board.collectActions({}, { wallet: f.contributor.account.address })).find(
      (a) => a.kind === 'stakeWithdraw',
    )!
    expect(stake.amount).toBe(parseEther('1').toString())
    const withdrawal = await board.withdrawStake(actor(f.contributor))
    const withdrawalHashes = await sdk.sendAll(f.contributor, ctx.publicClient, withdrawal.transactions)
    expect(
      (
        await board.reportOperation(actor(f.contributor), {
          operationId: withdrawal.operationId,
          txHash: withdrawalHashes.at(-1)!,
        })
      ).status,
    ).toBe('confirmed')
    await indexNow()
    expect(
      (await board.collectActions({}, { wallet: f.contributor.account.address })).some(
        (a) => a.kind === 'stakeWithdraw',
      ),
    ).toBe(false)
  }, 180_000)
  it('collects a deferred decision in one retryDeferred+settle step and refunds a third-party top-up', async () => {
    const x = await listed()
    await sdk.sendAll(
      f.contributor,
      ctx.publicClient,
      (await board.topUp(actor(f.contributor), { taskId: x.taskId, amount: '0.2' })).transactions,
    )
    await sdk.submit(ctx, f.worker, x.jobId, sdk.hashText('deferred'))
    await f.send(ctx.deployment.core, sdk.coreAbi, 'pause')
    await sdk.accept(ctx, f.creator, x.jobId)
    await f.send(ctx.deployment.core, sdk.coreAbi, 'unpause')
    await indexNow()
    const action = (await board.collectActions({}, { wallet: f.worker.account.address })).find(
      (a) => a.jobId === x.jobId.toString(),
    )!
    expect(action.kind).toBe('settle')
    expect(action.transactions.map((t) => t.gas)).toEqual(['300000', '1000000'])
    await sdk.sendAll(f.worker, ctx.publicClient, action.transactions)
    const y = await listed()
    await sdk.sendAll(
      f.contributor,
      ctx.publicClient,
      (await board.topUp(actor(f.contributor), { taskId: y.taskId, amount: '0.4' })).transactions,
    )
    await sdk.submit(ctx, f.worker, y.jobId, sdk.hashText('refund'))
    await sdk.reject(ctx, f.creator, y.jobId, 'None', sdk.hashText('not accepted'))
    const rejectedAt = Number(
      await ctx.publicClient.readContract({
        address: ctx.stack.evaluator,
        abi: sdk.sidequestEvaluatorAbi,
        functionName: 'rejectedAt',
        args: [y.jobId],
      }),
    )
    await f.rpc('evm_setNextBlockTimestamp', [rejectedAt + 3601])
    await f.rpc('evm_mine')
    await sdk.rejectAfterWindow(ctx, f.creator, y.jobId)
    await indexNow()
    const contributorSettlement = (await board.collectActions({}, { wallet: f.contributor.account.address })).find(
      (a) => a.kind === 'settle' && a.jobId === y.jobId.toString(),
    )!
    expect(contributorSettlement.transactions.map((t) => t.data.slice(0, 10))).toEqual([
      encodeFunctionData({ abi: sdk.sidequestHoldingAbi, functionName: 'settle', args: [y.jobId] }).slice(0, 10),
    ])
    await sdk.sendAll(f.contributor, ctx.publicClient, contributorSettlement.transactions)
    await indexNow()
    const refund = (await board.collectActions({}, { wallet: f.contributor.account.address })).find(
      (a) => a.kind === 'claimTopUpRefund' && a.jobId === y.jobId.toString(),
    )!
    expect(refund.amount).toBe(parseEther('0.4').toString())
    expect(refund.transactions[0]!.gas).toBe('450000')
    await sdk.sendAll(f.contributor, ctx.publicClient, refund.transactions)
    await indexNow()
    expect(
      (await board.collectActions({}, { wallet: f.contributor.account.address })).some(
        (a) => a.kind === 'claimTopUpRefund',
      ),
    ).toBe(false)
  }, 180_000)
  it.each(['elapsed-rejection', 'deferred-refund'])(
    'a contributor alone recovers %s, then discovers its exact top-up refund',
    async (path) => {
      const x = await listed()
      await sdk.sendAll(
        f.contributor,
        ctx.publicClient,
        (await board.topUp(actor(f.contributor), { taskId: x.taskId, amount: '0.3' })).transactions,
      )
      await sdk.submit(ctx, f.worker, x.jobId, sdk.hashText(path))
      await sdk.reject(ctx, f.creator, x.jobId, 'None', sdk.hashText('refund'))
      const rejectedAt = Number(
        await ctx.publicClient.readContract({
          address: ctx.stack.evaluator,
          abi: sdk.sidequestEvaluatorAbi,
          functionName: 'rejectedAt',
          args: [x.jobId],
        }),
      )
      await f.rpc('evm_setNextBlockTimestamp', [rejectedAt + 3601])
      await f.rpc('evm_mine')
      if (path === 'deferred-refund') {
        await f.send(ctx.deployment.core, sdk.coreAbi, 'pause')
        await sdk.rejectAfterWindow(ctx, f.creator, x.jobId)
        await f.send(ctx.deployment.core, sdk.coreAbi, 'unpause')
      }
      await indexNow()
      const prerequisite = (await board.collectActions({}, { wallet: f.contributor.account.address })).find(
        (a) => a.kind === 'settle' && a.jobId === x.jobId.toString(),
      )!
      const first = decodeFunctionData({ abi: sdk.sidequestEvaluatorAbi, data: prerequisite.transactions[0]!.data })
      expect(first.functionName).toBe(path === 'elapsed-rejection' ? 'rejectAfterWindow' : 'retryDeferred')
      expect(
        decodeFunctionData({ abi: sdk.sidequestHoldingAbi, data: prerequisite.transactions[1]!.data }).functionName,
      ).toBe('settle')
      await sdk.sendAll(f.contributor, ctx.publicClient, prerequisite.transactions)
      await indexNow()
      const refund = (await board.collectActions({}, { wallet: f.contributor.account.address })).find(
        (a) => a.kind === 'claimTopUpRefund' && a.jobId === x.jobId.toString(),
      )!
      expect(refund.amount).toBe(parseEther('0.3').toString())
      await sdk.sendAll(f.contributor, ctx.publicClient, refund.transactions)
      await indexNow()
      expect(
        (await board.collectActions({}, { wallet: f.contributor.account.address })).some(
          (a) => a.jobId === x.jobId.toString(),
        ),
      ).toBe(false)
    },
    180_000,
  )
  it('deduplicates pooled refused-token withdrawals and re-reads their canonical balances', async () => {
    const abi = parseAbi(['function mint(address,uint256)', 'function setBlocked(address,bool)'])
    const token = await f.deploy('BlocklistUSD', [f.admin.account.address], 'OddTokens')
    await f.send(token, abi, 'mint', [f.creator.account.address, 10_000_000n])
    const x = await listed(token)
    await sdk.submit(ctx, f.worker, x.jobId, sdk.hashText('blocked'))
    await f.send(token, abi, 'setBlocked', [f.worker.account.address, true])
    await sdk.accept(ctx, f.creator, x.jobId)
    await sdk.sendAll(
      f.creator,
      ctx.publicClient,
      (await board.settlementActions({}, { taskId: x.taskId })).transactions,
    )
    await f.send(token, abi, 'setBlocked', [f.worker.account.address, false])
    await indexNow()
    const owed = (await board.collectActions({}, { wallet: f.worker.account.address })).filter(
      (a) => a.kind === 'withdraw' && a.token?.toLowerCase() === token.toLowerCase(),
    )
    expect(owed).toHaveLength(1)
    expect(owed[0]!.amount).toBe('700000')
    await sdk.sendAll(f.worker, ctx.publicClient, owed[0]!.transactions)
    await indexNow()
    expect(
      (await board.collectActions({}, { wallet: f.worker.account.address })).some(
        (a) => a.kind === 'withdraw' && a.token?.toLowerCase() === token.toLowerCase(),
      ),
    ).toBe(false)
  }, 180_000)
  it('missing, stale and divergent indices refuse instead of returning an empty Collect list', async () => {
    await indexNow()
    index.prepare('UPDATE checkpoint SET block_hash=?').run(`0x${'0'.repeat(64)}`)
    await expect(board.collectActions({}, { wallet: f.worker.account.address })).rejects.toThrow('divergent')
    index.prepare('UPDATE checkpoint SET updated_at=0').run()
    await expect(board.collectActions({}, { wallet: f.worker.account.address })).rejects.toThrow('behind')
    index.prepare('DELETE FROM checkpoint').run()
    await expect(board.collectActions({}, { wallet: f.worker.account.address })).rejects.toThrow('unavailable')
  })
})
