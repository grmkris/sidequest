import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { startSidequestFork, forkEnabled } from '../../packages/sdk/test/sidequest-fixture.ts'
import { FlowJournal, flowJson, parseFlowJson, type FlowState } from '../../packages/sdk/src/flow-journal.ts'
import { epochDistributorAbi } from '../../packages/sdk/src/abi/epochDistributor.ts'
import { stakeVaultAbi } from '../../packages/sdk/src/abi/stakeVault.ts'
import { factoryV2Abi } from '../../packages/sdk/src/abi/factoryV2.ts'
import { holdingLogs, reserveAbi } from '../../scripts/mining/chain.ts'
import { buildTree, proofOf } from '../../scripts/mining/tree.ts'
import { computeEpoch } from '../../scripts/mining/compute.ts'
import { registerAgent, delegate as stake } from '../../packages/sdk/src/actions.ts'
import { runV1CoreFlow } from '../../packages/sdk/src/v1-flows.ts'
import { createPublicClient, custom, decodeEventLog, encodeFunctionResult, encodeFunctionData, parseAbi, parseEther, zeroAddress, type Address, type Hex } from '../../scripts/mining/viem.ts'
import { context, wallet } from '../../packages/sdk/src/client.ts'
import { privateKeyToAccount } from '../../scripts/mining/viem.ts'
import { epochCalls, runEpoch, runEpoch0, safeEpochAbi, safeEpochCall, type Epoch0File } from './epoch0-transactions.ts'

const fork = forkEnabled ? describe : describe.skip

it('publish-only resumes a matching root without preparing a claim or requiring a claimant', async () => {
  const base = context('monad-testnet', 'main', 'http://rpc.invalid'), h = base.deployment.sidequest!
  const root = `0x${'11'.repeat(32)}` as const, dataHash = `0x${'22'.repeat(32)}` as const
  const file: Epoch0File = { chainId: 10143, epoch: '45', root, total: '1', dataHash, claims: {}, calls: {
    setRoot: { to: h.distributor, data: encodeFunctionData({ abi: epochDistributorAbi, functionName: 'setRoot', args: [45n, root, 1n, dataHash] }) },
  } }
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_chainId') return '0x279f'
    if (method === 'eth_call') return encodeFunctionResult({ abi: epochDistributorAbi, functionName: 'rootOf', result: { root, total: 1n, claimed: 0n, dataHash } })
    throw new Error(`unexpected method ${method}`)
  })
  const ctx = { ...base, publicClient: createPublicClient({ transport: custom({ request }) }) }
  const state: FlowState = { binding: 'unit', values: {}, sends: {} }, j = new FlowJournal(ctx, state, () => {}, () => {})
  const owner = wallet('monad-testnet', privateKeyToAccount(`0x${'01'.padStart(64, '0')}`), 'http://rpc.invalid')
  const publish = vi.fn(async () => {}), sign = vi.fn(async () => dataHash)
  await runEpoch(ctx, j, owner, sign, file, publish, undefined, 45n)
  await runEpoch(ctx, j, owner, sign, file, publish, undefined, 45n)
  expect(publish).toHaveBeenCalledTimes(2)
  expect(sign).not.toHaveBeenCalled()
  expect(state.sends).toEqual({})
  expect(state.values).toEqual({})
})

fork('testnet epoch script on real Safe and v1 contracts (local Monad fork only)', () => {
  let f: Awaited<ReturnType<typeof startSidequestFork>>, snapshot: unknown, file: Epoch0File
  beforeAll(async () => {
    f = await startSidequestFork()
    const factory = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67', singleton = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762'
    const setup = parseAbi(['function setup(address[],uint256,address,bytes,address,address,uint256,address)'])
    const proxyFactory = parseAbi(['function createProxyWithNonce(address,bytes,uint256) returns (address)', 'event ProxyCreation(address indexed proxy,address singleton)'])
    const initialization = encodeFunctionData({ abi: setup, functionName: 'setup', args: [[f.admin.account.address], 1n, zeroAddress, '0x', zeroAddress, zeroAddress, 0n, zeroAddress] })
    const tx = await f.admin.writeContract({ address: factory, abi: proxyFactory, functionName: 'createProxyWithNonce', args: [singleton, initialization, BigInt(Date.now())] })
    const receipt = await f.ctx.publicClient.waitForTransactionReceipt({ hash: tx })
    let safe: Address | undefined
    for (const log of receipt.logs) {
      try { const event = decodeEventLog({ abi: proxyFactory, data: log.data, topics: log.topics }); if (event.eventName === 'ProxyCreation') safe = event.args.proxy } catch { /* other Safe setup logs */ }
    }
    if (!safe) throw new Error('fork Safe was not created')
    const h = f.ctx.deployment.sidequest!
    f.ctx = { ...f.ctx, deployment: { ...f.ctx.deployment, sidequest: { ...h, safe, block: await f.ctx.publicClient.getBlockNumber({ cacheTime: 0 }) } } }
    const ownable = parseAbi(['function transferOwnership(address)', 'function acceptOwnership()'])
    for (const target of [h.miningReserve, h.distributor]) {
      await f.send(target, ownable, 'transferOwnership', [safe])
      // Only fixture setup uses the prevalidated path; tested fund uses ECDSA.
      const signature = `0x${f.admin.account.address.slice(2).padStart(64, '0')}${'0'.repeat(64)}01` as Hex
      await f.send(safe, safeEpochAbi, 'execTransaction', [target, 0n, encodeFunctionData({ abi: ownable, functionName: 'acceptOwnership' }), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signature])
    }
    await f.send(h.factory, factoryV2Abi, 'transfer', [h.miningReserve, parseEther('500000000')])
    const end = await f.ctx.publicClient.readContract({ address: h.miningReserve, abi: reserveAbi, functionName: 'epochEnd', args: [0n] })
    await f.rpc('evm_setNextBlockTimestamp', [Number(end) + 1]); await f.rpc('evm_mine')
    const total = parseEther('100'), tree = buildTree([['0', f.worker.account.address.toLowerCase() as Address, total.toString()]])
    const root = tree.tree[0]!, dataHash = `0x${'11'.repeat(32)}` as Hex
    file = { chainId: 10143, epoch: '0', root, total: total.toString(), dataHash,
      claims: { [f.worker.account.address.toLowerCase()]: { amount: total.toString(), proof: [] } },
      calls: {
        fund: { to: h.miningReserve, data: encodeFunctionData({ abi: reserveAbi, functionName: 'fund', args: [0n, total] }), expect: { totalFunded: '0', fundedForEpoch: '0' } },
        setRoot: { to: h.distributor, data: encodeFunctionData({ abi: epochDistributorAbi, functionName: 'setRoot', args: [0n, root, total, dataHash] }) },
      } }
    snapshot = await f.rpc('evm_snapshot')
  }, 180_000)
  beforeEach(async () => { await f.rpc('evm_revert', [snapshot]); snapshot = await f.rpc('evm_snapshot') })
  afterAll(() => f?.close())
  const sign = (hash: Hex) => f.admin.account.sign!({ hash })
  const journal = (state: FlowState = { binding: 'fork', values: {}, sends: {} }, save = (_state: FlowState) => {}) => new FlowJournal(f.ctx, state, save, () => {})

  it('funds and publishes without a claimant, then resumes the original Safe operations', async () => {
    const j = journal(), signer = vi.fn(sign), publish = vi.fn(async () => {})
    await runEpoch(f.ctx, j, f.admin, signer, file, publish)
    const sends = flowJson(j.state.sends), h = f.ctx.deployment.sidequest!
    expect(Object.keys(j.state.sends).toSorted()).toEqual(['epoch0/fund', 'epoch0/setRoot'])
    expect(await f.ctx.publicClient.readContract({ address: h.distributor, abi: epochDistributorAbi, functionName: 'isClaimed', args: [0n, f.worker.account.address] })).toBe(false)
    await runEpoch(f.ctx, j, f.admin, signer, file, publish)
    expect(flowJson(j.state.sends)).toBe(sends)
    expect(signer).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenCalledTimes(2)
  }, 120_000)

  it('stops at failed publication, resumes identical fund/root, and claims only after readback', async () => {
    const j = journal(), signer = vi.fn(sign), publisher = vi.fn(async (): Promise<void> => { throw new Error('readback failed') })
    await expect(runEpoch0(f.ctx, j, f.admin, signer, file, publisher, f.worker)).rejects.toThrow('readback failed')
    const h = f.ctx.deployment.sidequest!, safeNonce = await f.ctx.publicClient.readContract({ address: h.safe, abi: safeEpochAbi, functionName: 'nonce' })
    const beforeSends = flowJson(j.state.sends)
    expect(await f.ctx.publicClient.readContract({ address: h.distributor, abi: epochDistributorAbi, functionName: 'isClaimed', args: [0n, f.worker.account.address] })).toBe(false)
    publisher.mockImplementation(async () => {})
    await runEpoch0(f.ctx, j, f.admin, signer, file, publisher, f.worker)
    expect(signer).toHaveBeenCalledTimes(2)
    expect(publisher).toHaveBeenCalledTimes(2)
    expect(flowJson({ 'epoch0/fund': j.state.sends['epoch0/fund'], 'epoch0/setRoot': j.state.sends['epoch0/setRoot'] })).toBe(beforeSends)
    expect(await f.ctx.publicClient.readContract({ address: h.safe, abi: safeEpochAbi, functionName: 'nonce' })).toBe(safeNonce)
    expect(await f.ctx.publicClient.readContract({ address: h.vault, abi: stakeVaultAbi, functionName: 'stakeOf', args: [f.worker.account.address] })).toBe(parseEther('100'))
    const sends = flowJson(j.state.sends)
    await runEpoch0(f.ctx, j, f.admin, signer, file, publisher, f.worker)
    expect(flowJson(j.state.sends)).toBe(sends)
  }, 120_000)

  it('persists raw outer bytes before send and resumes after a process crash without re-signing', async () => {
    let durable: FlowState = { binding: 'fork', values: {}, sends: {} }
    const signer = vi.fn(sign), fund = file.calls.fund!
    const j = journal(durable, state => { durable = parseFlowJson(flowJson(state)); if (state.sends['epoch0/fund']) throw new Error('crash after durable save') })
    await expect(safeEpochCall(f.ctx, j, f.admin, signer, 'fund', fund.to, fund.data, fund.expect)).rejects.toThrow('crash')
    expect(durable.sends['epoch0/fund']!.raw).toMatch(/^0x/)
    expect(await f.ctx.publicClient.readContract({ address: fund.to, abi: reserveAbi, functionName: 'totalFunded' })).toBe(0n)
    const raw = durable.sends['epoch0/fund']!.raw
    await safeEpochCall(f.ctx, journal(durable), f.admin, signer, 'fund', fund.to, fund.data, fund.expect)
    expect(signer).toHaveBeenCalledTimes(1)
    expect(durable.sends['epoch0/fund']!.raw).toBe(raw)
    expect(await f.ctx.publicClient.readContract({ address: fund.to, abi: reserveAbi, functionName: 'totalFunded' })).toBe(parseEther('100'))
  }, 120_000)

  it('refuses a restored draft after another Safe transaction moves its nonce', async () => {
    const signer = vi.fn(sign), fund = file.calls.fund!, j = journal(undefined, state => { if (state.values['epoch0/fund/draft']) throw new Error('stop after draft') })
    await expect(safeEpochCall(f.ctx, j, f.admin, signer, 'fund', fund.to, fund.data, fund.expect)).rejects.toThrow('stop')
    const h = f.ctx.deployment.sidequest!, signature = `0x${f.admin.account.address.slice(2).padStart(64, '0')}${'0'.repeat(64)}01` as Hex
    await f.send(h.safe, safeEpochAbi, 'execTransaction', [f.admin.account.address, 0n, '0x', 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signature])
    await expect(safeEpochCall(f.ctx, journal(j.state), f.admin, signer, 'fund', fund.to, fund.data, fund.expect)).rejects.toThrow('snapshot moved')
    expect(j.state.sends).toEqual({}); expect(signer).toHaveBeenCalledTimes(1)
  }, 120_000)

  it('refuses prevalidated fund signatures and altered call destinations before sending', async () => {
    const fund = file.calls.fund!, j = journal()
    await expect(safeEpochCall(f.ctx, j, f.admin, async () => `0x${'0'.repeat(128)}01`, 'fund', fund.to, fund.data, fund.expect)).rejects.toThrow('must be ECDSA')
    expect(j.state.sends).toEqual({})
    expect(() => epochCalls(f.ctx, { ...file, calls: { ...file.calls, fund: { ...fund, to: f.worker.account.address } } })).toThrow('fund calldata mismatch')
  }, 120_000)

  it('funds and claims a later epoch with separate journal keys and never replays its sends', async () => {
    const h = f.ctx.deployment.sidequest!, epoch = 2n, total = parseEther('17')
    const end = await f.ctx.publicClient.readContract({ address: h.miningReserve, abi: reserveAbi, functionName: 'epochEnd', args: [epoch] })
    await f.rpc('evm_setNextBlockTimestamp', [Number(end) + 1]); await f.rpc('evm_mine')
    const tree = buildTree([[epoch.toString(), f.worker.account.address.toLowerCase() as Address, total.toString()]])
    const later: Epoch0File = { ...file, epoch: epoch.toString(), root: tree.tree[0]!, total: total.toString(),
      claims: { [f.worker.account.address.toLowerCase()]: { amount: total.toString(), proof: [] } }, calls: {
        fund: { to: h.miningReserve, data: encodeFunctionData({ abi: reserveAbi, functionName: 'fund', args: [epoch, total] }), expect: { totalFunded: '0', fundedForEpoch: '0' } },
        setRoot: { to: h.distributor, data: encodeFunctionData({ abi: epochDistributorAbi, functionName: 'setRoot', args: [epoch, tree.tree[0]!, total, file.dataHash] }) },
      } }
    const j = journal(), signer = vi.fn(sign), publish = vi.fn(async () => {})
    await runEpoch(f.ctx, j, f.admin, signer, later, publish, f.worker, epoch)
    expect(Object.keys(j.state.sends).toSorted()).toEqual(['epoch2/fund', 'epoch2/setRoot', `epoch2/claim/${f.worker.account.address.toLowerCase()}`].toSorted())
    expect(await f.ctx.publicClient.readContract({ address: h.distributor, abi: epochDistributorAbi, functionName: 'isClaimed', args: [epoch, f.worker.account.address] })).toBe(true)
    expect(await f.ctx.publicClient.readContract({ address: h.distributor, abi: epochDistributorAbi, functionName: 'isClaimed', args: [0n, f.worker.account.address] })).toBe(false)
    expect(await f.ctx.publicClient.readContract({ address: h.vault, abi: stakeVaultAbi, functionName: 'stakeOf', args: [f.worker.account.address] })).toBe(total)
    const saved = flowJson(j.state.sends)
    await runEpoch(f.ctx, j, f.admin, signer, later, publish, f.worker, epoch)
    expect(flowJson(j.state.sends)).toBe(saved)
    expect(signer).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenCalledTimes(2)
    expect(() => epochCalls(f.ctx, later, 1n)).toThrow('selected epoch')
    expect(() => epochCalls(f.ctx, { ...later, calls: { ...later.calls, ...(file.calls.fund === undefined ? {} : { fund: file.calls.fund }) } }, epoch)).toThrow('fund calldata mismatch')
  }, 120_000)

  it('mines fees earned after empty epoch 0 and stakes the worker leaf of the later epoch', async () => {
    const h = f.ctx.deployment.sidequest!, epoch = 1n
    const from = await f.ctx.publicClient.getBlockNumber({ cacheTime: 0 })
    const agentId = await registerAgent(f.ctx, f.worker, 'https://sidequest.exchange/later-epoch-fork')
    await stake(f.ctx, f.creator, parseEther('100')); await stake(f.ctx, f.worker, parseEther('100'))
    await runV1CoreFlow({ ...f, journal: journal(), agentId, relay: f.contributor, token: h.factory,
      reward: parseEther('1'), bond: parseEther('10'), waitUntil: async () => { throw new Error('quick hire must not wait') }, log: () => {} }, 'hire')
    const to = await f.ctx.publicClient.getBlockNumber({ cacheTime: 0 })
    const logs = await holdingLogs(f.ctx.publicClient, [f.ctx.stack.holding], from, to, 1000n)
    const computed = computeEpoch({ ...logs, prices: { epoch, tokens: [{ token: h.factory.toLowerCase() as Address, decimals: 18, usdPrice: parseEther('1') }], factoryUsdPrice: 100000000000000n }, budget: parseEther('1000000') })
    expect(computed.feeUsd).toBeGreaterThan(0n)
    expect(computed.leaves).toHaveLength(2)
    const tree = buildTree(computed.leaves.map(leaf => [epoch.toString(), leaf.account, leaf.amount.toString()]))
    const claims = Object.fromEntries(tree.values.map(({ value }, index) => [value[1], { amount: value[2], proof: proofOf(tree, index) }]))
    const later: Epoch0File = { ...file, epoch: '1', root: tree.tree[0]!, total: computed.total.toString(), claims, calls: {
      fund: { to: h.miningReserve, data: encodeFunctionData({ abi: reserveAbi, functionName: 'fund', args: [epoch, computed.total] }), expect: { totalFunded: '0', fundedForEpoch: '0' } },
      setRoot: { to: h.distributor, data: encodeFunctionData({ abi: epochDistributorAbi, functionName: 'setRoot', args: [epoch, tree.tree[0]!, computed.total, file.dataHash] }) },
    } }
    const end = await f.ctx.publicClient.readContract({ address: h.miningReserve, abi: reserveAbi, functionName: 'epochEnd', args: [epoch] })
    await f.rpc('evm_setNextBlockTimestamp', [Number(end) + 1]); await f.rpc('evm_mine')
    const before = await f.ctx.publicClient.readContract({ address: h.vault, abi: stakeVaultAbi, functionName: 'stakeOf', args: [f.worker.account.address] })
    await runEpoch(f.ctx, journal(), f.admin, sign, later, async () => {}, f.worker, epoch)
    expect(await f.ctx.publicClient.readContract({ address: h.vault, abi: stakeVaultAbi, functionName: 'stakeOf', args: [f.worker.account.address] })).toBe(before + BigInt(claims[f.worker.account.address.toLowerCase()]!.amount))
  }, 120_000)
})
