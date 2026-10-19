/** Board preparations executed against real v1 bytecode on a local Monad fork. No remote broadcasts. */
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { decodeFunctionData, encodeFunctionData, erc20Abi, formatEther, getAddress, parseEther } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { forkEnabled, forkSetupTimeout, startSidequestFork } from '../../sdk/test/sidequest-fixture.ts'
import { Board } from './service.ts'
import { fromNodeSqlite } from './store.ts'
import { admissionFailure, parseHostedAdmission } from './admission.ts'
import { ROOT_AUTHORITY, delegationTypedData, redeemCalldata } from '@sidequest/sdk'

const fork = forkEnabled ? describe : describe.skip
fork('Sidequest board on a local Monad fork', () => {
  let f: Awaited<ReturnType<typeof startSidequestFork>>
  let board: Board
  let db: DatabaseSync
  let agentId: bigint
  let now: number
  const windows = { reviewSeconds: 3600, disputeSeconds: 7200, arbitrationSeconds: 43200 }
  beforeAll(async () => {
    f = await startSidequestFork()
    db = new DatabaseSync(':memory:')
    now = Number((await f.ctx.publicClient.getBlock()).timestamp)
    board = new Board(fromNodeSqlite(db), {
      network: 'monad-testnet',
      contexts: { main: f.ctx },
      domain: 'fork.test',
      uri: 'https://fork.test',
      manifestBaseUrl: 'https://fork.test/offers',
      now: () => now,
    })
    agentId = await sdk.registerAgent(f.ctx, f.worker, 'https://sidequest.exchange/board-local-fork')
    await sdk.delegate(f.ctx, f.creator, parseEther('100'))
    await sdk.delegate(f.ctx, f.worker, parseEther('100'))
  }, forkSetupTimeout())
  afterAll(() => {
    db?.close()
    f?.close()
  })

  const offer = () => ({
    title: 'Board fork hire',
    brief: 'Real local bytecode',
    acceptanceCriteria: ['finished'],
    token: f.ctx.stack.factory,
    reward: '0.000000000000000101',
    creatorBond: '10',
    workerBond: '10',
    deliveryDeadline: now + 3600,
    windows,
    invite: { agentId: agentId.toString() },
  })
  async function listed() {
    const created = await board.createTask({ address: f.creator.account.address }, offer())
    expect(created.applicationId).toBeDefined()
    expect(
      (await board.listApplications({ address: f.creator.account.address }, { taskId: created.taskId }))[0],
    ).toMatchObject({ worker: f.worker.account.address, agent_id: agentId.toString() })
    const publish = decodeFunctionData({ abi: sdk.sidequestHoldingAbi, data: created.transactions.at(-1)!.data })
    expect(publish.functionName).toBe('publish')
    expect(publish.args[0]).toMatchObject({
      arbitrator: f.arbitrator.account.address,
      reviewWindow: 3600,
      disputeWindow: 7200,
      arbitrationWindow: 43200,
    })
    // The only approval is for the reward, never for a bond reservation.
    expect(created.transactions.length).toBeLessThanOrEqual(2)
    if (created.transactions.length === 2)
      expect(decodeFunctionData({ abi: erc20Abi, data: created.transactions[0]!.data }).args).toEqual([
        getAddress(f.ctx.stack.holding),
        101n,
      ])
    await sdk.sendAll(f.creator, f.ctx.publicClient, created.transactions)
    // Simulate the lost publication response. Chain recovery must retain the direct application.
    const seen = await board.getTask({ address: f.creator.account.address }, { taskId: created.taskId })
    expect(seen.chain.listingMatchesOffer).toBe(true)
    const selection = await board.selectWorker(
      { address: f.creator.account.address },
      { taskId: created.taskId, applicationId: created.applicationId! },
    )
    await expect(
      board.verifyAgentSigning(
        { address: f.creator.account.address },
        {
          tool: 'select_worker',
          args: { taskId: created.taskId, applicationId: created.applicationId! },
          typedData: selection.sign.typedData,
        },
      ),
    ).resolves.toBe(selection.sign.typedData)
    await board.submitSelection(
      { address: f.creator.account.address },
      {
        taskId: created.taskId,
        nonce: selection.nonce,
        signature: await sdk.signTypedDataJson(f.creator, selection.sign.typedData),
      },
    )
    return { taskId: created.taskId, jobId: BigInt(seen.jobId!) }
  }
  async function activate(taskId: string) {
    const prep = await board.prepareActivation({ address: f.worker.account.address }, { taskId })
    expect(prep.transactions).toEqual([])
    const built = await board.buildActivation(
      { address: f.worker.account.address },
      { taskId, budgetSignature: await sdk.signTypedDataJson(f.worker, prep.sign.typedData) },
    )
    expect(built.transactions).toHaveLength(1)
    await sdk.sendAll(f.worker, f.ctx.publicClient, built.transactions)
  }

  it.each(['arbitrary caller', 'drain recovery'])(
    'refuses a copied-hash publication reported through %s, then binds and activates the creator’s job',
    async (path) => {
      const created = await board.createTask({ address: f.creator.account.address }, offer())
      await sdk.delegate(f.ctx, f.contributor, parseEther('10'))
      const spoof = await sdk.publish(f.ctx, f.contributor, {
        token: f.ctx.stack.factory,
        reward: 101n,
        creatorBond: parseEther('10'),
        workerBond: parseEther('10'),
        deliveryDeadline: now + 3600,
        reviewWindow: windows.reviewSeconds,
        disputeWindow: windows.disputeSeconds,
        arbitrationWindow: windows.arbitrationSeconds,
        arbitrator: f.arbitrator.account.address,
        manifestHash: created.termsHash,
        termsHash: created.termsHash,
      })
      const caller = { address: f.worker.account.address }
      if (path === 'drain recovery')
        expect(
          admissionFailure(parseHostedAdmission('1'), 'monad-mainnet', 'public', 'report_transaction', caller.address),
        ).toBeUndefined()
      const reported = await board.reportTransaction(caller, {
        taskId: created.taskId,
        txHash: spoof.receipt.transactionHash,
      })
      expect(reported.jobId).toBeNull()
      expect(reported.chain.status).toBe('awaiting-publish')
      expect(db.prepare('SELECT job_id, publish_tx FROM tasks WHERE id = ?').get(created.taskId)).toEqual({
        job_id: null,
        publish_tx: null,
      })
      expect(reported.operations.find((o) => o.kind === 'publish')?.status).toBe('prepared')
      const hashes = await sdk.sendAll(f.creator, f.ctx.publicClient, created.transactions)
      const genuine = await board.reportTransaction(caller, { taskId: created.taskId, txHash: hashes.at(-1)! })
      expect(genuine.jobId).not.toBeNull()
      expect(genuine.jobId).not.toBe(spoof.jobId.toString())
      expect(db.prepare('SELECT publish_tx FROM tasks WHERE id = ?').get(created.taskId)).toEqual({
        publish_tx: hashes.at(-1),
      })
      // A later spoof receipt cannot replace the established binding.
      expect(
        (await board.reportTransaction(caller, { taskId: created.taskId, txHash: spoof.receipt.transactionHash }))
          .jobId,
      ).toBe(genuine.jobId)
      const selection = await board.selectWorker(
        { address: f.creator.account.address },
        { taskId: created.taskId, applicationId: created.applicationId! },
      )
      await board.submitSelection(
        { address: f.creator.account.address },
        {
          taskId: created.taskId,
          nonce: selection.nonce,
          signature: await sdk.signTypedDataJson(f.creator, selection.sign.typedData),
        },
      )
      await activate(created.taskId)
      expect((await board.getTask({}, { taskId: created.taskId })).chain.status).toBe('active')
      await sdk.submit(f.ctx, f.worker, BigInt(genuine.jobId!), sdk.hashText('genuine delivery'))
      await sdk.accept(f.ctx, f.creator, BigInt(genuine.jobId!))
      await sdk.settle(f.ctx, f.contributor, BigInt(genuine.jobId!))
    },
    180_000,
  )

  it.each(['batch', 'relay'])(
    'binds a genuine %s publication using the event creator, regardless of receipt.to/from',
    async (path) => {
      const created = await board.createTask({ address: f.creator.account.address }, offer())
      const approval: sdk.TxRequest = {
        chainId: f.ctx.deployment.chainId,
        to: f.ctx.stack.factory,
        value: '0',
        description: 'Approve reward',
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [f.ctx.stack.holding, 101n] }),
      }
      const publish = created.transactions.at(-1)!
      let hash
      if (path === 'batch') {
        hash = await sdk.sendBatch(
          f.creator,
          f.ctx.publicClient,
          [approval, publish],
          f.ctx.deployment.delegation.delegator,
        )
        expect((await f.ctx.publicClient.getTransactionReceipt({ hash })).to?.toLowerCase()).toBe(
          f.creator.account.address.toLowerCase(),
        )
      } else {
        await sdk.sendAll(f.creator, f.ctx.publicClient, [approval])
        const grant = {
          delegator: f.creator.account.address,
          delegate: f.contributor.account.address,
          authority: ROOT_AUTHORITY,
          salt: BigInt(created.termsHash),
          caveats: [],
          signature: '0x' as const,
        }
        const signed = {
          ...grant,
          signature: await sdk.signTypedDataJson(f.creator, delegationTypedData(f.ctx.deployment, grant)),
        }
        hash = await f.contributor.sendTransaction({
          to: f.ctx.deployment.delegation.manager,
          data: redeemCalldata(signed, { target: publish.to, value: 0n, callData: publish.data }),
        })
        expect((await f.ctx.publicClient.waitForTransactionReceipt({ hash })).from.toLowerCase()).toBe(
          f.contributor.account.address.toLowerCase(),
        )
      }
      const reported = await board.reportTransaction(
        { address: f.worker.account.address },
        { taskId: created.taskId, txHash: hash },
      )
      expect(reported.chain.listingMatchesOffer).toBe(true)
      expect(db.prepare('SELECT publish_tx FROM tasks WHERE id = ?').get(created.taskId)).toEqual({ publish_tx: hash })
      expect((await sdk.getListing(f.ctx, BigInt(reported.jobId!))).creator.toLowerCase()).toBe(
        f.creator.account.address.toLowerCase(),
      )
    },
    180_000,
  )

  it('direct hire freezes windows/arbitrator and signs the current net; a changed fee quote requires a new signature', async () => {
    const bounds = await sdk.readWindowBounds(f.ctx)
    await expect(
      board.createTask(
        { address: f.creator.account.address },
        { ...offer(), windows: { ...windows, reviewSeconds: bounds.review.min - 1 } },
      ),
    ).rejects.toThrow('review window')
    await expect(
      board.createTask({ address: f.creator.account.address }, { ...offer(), arbitrator: f.creator.account.address }),
    ).rejects.toThrow('distinct')
    const x = await listed()
    const prep = await board.prepareActivation({ address: f.worker.account.address }, { taskId: x.taskId })
    expect(prep.feeQuote).toEqual({ feeBps: 3000, fee: '31', net: '70' })
    expect(JSON.parse(prep.sign.typedData).message.amount).toBe('70')
    await expect(
      board.verifyAgentSigning(
        { address: f.worker.account.address },
        {
          tool: 'prepare_activation',
          args: { taskId: x.taskId },
          typedData: prep.sign.typedData,
        },
      ),
    ).resolves.toBe(prep.sign.typedData)
    const wrongAmount = JSON.parse(prep.sign.typedData)
    wrongAmount.message.amount = '101'
    await expect(
      board.verifyAgentSigning(
        { address: f.worker.account.address },
        {
          tool: 'prepare_activation',
          args: { taskId: x.taskId },
          typedData: JSON.stringify(wrongAmount),
        },
      ),
    ).rejects.toThrow('frozen authorized action')
    const oldSignature = await sdk.signTypedDataJson(f.worker, prep.sign.typedData)
    await sdk.delegate(f.ctx, f.worker, parseEther('10000'))
    await expect(
      board.verifyAgentSigning(
        { address: f.worker.account.address },
        {
          tool: 'prepare_activation',
          args: { taskId: x.taskId },
          typedData: prep.sign.typedData,
        },
      ),
    ).rejects.toThrow('frozen authorized action')
    await expect(
      board.buildActivation({ address: f.worker.account.address }, { taskId: x.taskId, budgetSignature: oldSignature }),
    ).rejects.toThrow('current net quote')
    await activate(x.taskId)
    expect((await sdk.getJob(f.ctx, x.jobId)).budget).toBe(90n)
    expect((await sdk.getBacking(f.ctx, f.worker.account.address)).reserved).toBe(parseEther('10'))
    await sdk.submit(f.ctx, f.worker, x.jobId, sdk.hashText('delivery'))
    const accepted = await board.approveWork({ address: f.creator.account.address }, { taskId: x.taskId })
    expect(accepted.transactions[0]!.gas).toBe('1200000')
    await sdk.sendAll(f.creator, f.ctx.publicClient, accepted.transactions)
    const collect = await board.settlementActions({}, { taskId: x.taskId })
    expect(collect.transactions[0]!.gas).toBe('1000000')
    await sdk.sendAll(f.contributor, f.ctx.publicClient, collect.transactions)
    expect((await board.settlementActions({}, { taskId: x.taskId })).transactions).toEqual([])
  }, 180_000)

  it('a deferred decision collects by retryDeferred then settle and never reopens arbitration', async () => {
    const x = await listed()
    await activate(x.taskId)
    await sdk.submit(f.ctx, f.worker, x.jobId, sdk.hashText('deferred delivery'))
    await f.send(f.ctx.deployment.core, sdk.coreAbi, 'pause')
    await sdk.accept(f.ctx, f.creator, x.jobId)
    expect((await board.settlementActions({}, { taskId: x.taskId })).transactions).toEqual([])
    await f.send(f.ctx.deployment.core, sdk.coreAbi, 'unpause')
    const collect = await board.settlementActions({}, { taskId: x.taskId })
    expect(collect.transactions).toHaveLength(2)
    expect(collect.transactions.map((t) => t.gas)).toEqual(['300000', '1000000'])
    expect(
      decodeFunctionData({ abi: sdk.sidequestEvaluatorAbi, data: collect.transactions[0]!.data }).functionName,
    ).toBe('retryDeferred')
    await sdk.sendAll(f.contributor, f.ctx.publicClient, collect.transactions)
    expect((await board.getTask({}, { taskId: x.taskId })).chain.outcome).toBe('Accepted')
  }, 120_000)

  it('the named arbitrator alone signs; cancellation confirms before a new nonce for the same decision', async () => {
    const x = await listed()
    await activate(x.taskId)
    await sdk.submit(f.ctx, f.worker, x.jobId, sdk.hashText('disputed delivery'))
    await sdk.sendAll(
      f.creator,
      f.ctx.publicClient,
      (
        await board.rejectWork(
          { address: f.creator.account.address },
          { taskId: x.taskId, violation: 'None', reason: 'The criteria were not met.' },
        )
      ).transactions,
    )
    await sdk.sendAll(
      f.worker,
      f.ctx.publicClient,
      (
        await board.disputeRejection(
          { address: f.worker.account.address },
          { taskId: x.taskId, statement: 'They were met.' },
        )
      ).transactions,
    )
    const caller = { address: f.arbitrator.account.address }
    expect(await board.listDisputes(caller)).toHaveLength(1)
    const { bundleHash } = await board.getDisputeBundle(caller, { taskId: x.taskId })
    const args = {
      taskId: x.taskId,
      forWorker: true,
      slashLoser: false,
      reason: 'The submitted work satisfies the published criteria.',
      bundleHash,
      runner: 'local-fork',
    }
    await expect(board.prepareRuling({ address: f.contributor.account.address }, args)).rejects.toThrow(
      'named arbitrator',
    )
    const first = await board.prepareRuling(caller, args)
    const oldSig = await sdk.signTypedDataJson(f.arbitrator, first.sign.typedData)
    const cancellation = await board.cancelRuling(caller, { taskId: x.taskId })
    await sdk.sendAll(f.arbitrator, f.ctx.publicClient, cancellation.transactions)
    await expect(board.submitRuling(caller, { taskId: x.taskId, signature: oldSig })).rejects.toThrow('cancelled')
    const second = await board.prepareRuling(caller, args)
    expect(second.ruling.nonce).not.toBe(first.ruling.nonce)
    expect(second.decision.forWorker).toBe(true)
    const submitted = await board.submitRuling(caller, {
      taskId: x.taskId,
      signature: await sdk.signTypedDataJson(f.arbitrator, second.sign.typedData),
    })
    if (!('transactions' in submitted)) throw new Error('Expected an unsigned ruling')
    await sdk.sendAll(f.contributor, f.ctx.publicClient, submitted.transactions!)
    expect(await board.listDisputes(caller)).toEqual([])
  }, 150_000)

  it('quote requests preserve tags, selected windows and arbitrator through pickQuote', async () => {
    const requested = await board.requestQuotes(
      { address: f.creator.account.address },
      { ...offer(), tags: ['research', 'coding'], tokens: [f.ctx.stack.factory], quoteDeadline: now + 1800 },
    )
    const quote = await board.submitQuote(
      { address: f.worker.account.address },
      {
        requestId: requested.requestId,
        agentId: agentId.toString(),
        token: f.ctx.stack.factory,
        amount: formatEther(101n),
      },
    )
    const picked = await board.pickQuote(
      { address: f.creator.account.address },
      { requestId: requested.requestId, quoteId: quote.quoteId },
    )
    expect(JSON.parse(picked.manifest)).toMatchObject({
      tags: ['coding', 'research'],
      windows,
      arbitrator: f.arbitrator.account.address,
    })
    expect(board.taskIndex({}).find((task) => task.taskId === picked.taskId)?.tags).toEqual(['coding', 'research'])
    expect(
      (await board.listQuotes({ address: f.creator.account.address }, { requestId: requested.requestId })).creator,
    ).toBe(f.creator.account.address)
    expect(picked.applicationId).toBeDefined()
  }, 120_000)

  it('refuses activation when a creator reuses the terms label with a different on-chain bond', async () => {
    const created = await board.createTask({ address: f.creator.account.address }, offer())
    await sdk.publish(f.ctx, f.creator, {
      token: f.ctx.stack.factory,
      reward: 101n,
      creatorBond: parseEther('10'),
      workerBond: parseEther('50'),
      deliveryDeadline: now + 3600,
      reviewWindow: 3600,
      disputeWindow: 7200,
      arbitrationWindow: 43200,
      arbitrator: f.arbitrator.account.address,
      manifestHash: created.termsHash,
      termsHash: created.termsHash,
    })
    const seen = await board.getTask({}, { taskId: created.taskId })
    expect(seen.chain.listingMatchesOffer).toBe(false)
    const sel = await board.selectWorker(
      { address: f.creator.account.address },
      { taskId: created.taskId, applicationId: created.applicationId! },
    )
    await board.submitSelection(
      { address: f.creator.account.address },
      {
        taskId: created.taskId,
        nonce: sel.nonce,
        signature: await sdk.signTypedDataJson(f.creator, sel.sign.typedData),
      },
    )
    await expect(
      board.prepareActivation({ address: f.worker.account.address }, { taskId: created.taskId }),
    ).rejects.toThrow('does not match')
  }, 120_000)
})
