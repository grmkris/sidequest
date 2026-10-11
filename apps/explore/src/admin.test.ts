import { describe, expect, it } from 'vitest'
import * as sdk from '@sidequest/sdk'
import { type Abi, encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  type AdminContext,
  bpsOf,
  fundProblem,
  readAdminOp,
  readAdminTx,
  readEpochFile,
  epochStatus,
  readEpochArtifact,
  resizeProblem,
  scheduleProposal,
} from './admin.ts'

import {
  MULTI_SEND_CALL_ONLY,
  atomically,
  calldata,
  execSigned,
  execTransaction,
  multiSend,
  preValidated,
  safeAbi,
  safeTxTypedData,
} from './safe.ts'

describe('mining epoch status', () => {
  const root = `0x${'1'.repeat(64)}`
  const base = { prices: true, pending: { root }, root: null, funding: 'due' as const, published: false }
  it.each([
    [{ ...base, prices: false, pending: null }, 'waiting-prices', 'Sign and upload prices'],
    [{ ...base, pending: null }, 'pending', 'Computing'],
    [base, 'pending', 'Fund the epoch'],
    [{ ...base, pending: { root: null } }, 'empty', 'Empty epoch'],
    [{ ...base, funding: 'done' }, 'funded', 'Set the root'],
    [{ ...base, root: { root } }, 'rooted', 'Publishing'],
    [{ ...base, prices: false, pending: null, published: true }, 'published', 'Published'],
    [{ ...base, funding: 'stale' }, 'abandoned', 'changed'],
    [{ ...base, failure: 'invalid-epoch' }, 'failed:invalid-epoch', 'Reload'],
    [{ ...base, root: { root: `0x${'2'.repeat(64)}` } }, 'failed:root-mismatch', 'differs'],
    [
      { ...base, root: { root, dataHash: '0xa' }, pending: { root, dataHash: '0xb' } },
      'failed:root-mismatch',
      'differs',
    ],
  ] as const)('returns %s', (input, status, next) => {
    expect(epochStatus(input)).toMatchObject({ status, next: expect.stringContaining(next) })
  })
})

const treasury = '0x9999999999999999999999999999999999999999'
const ok = { thresholds: ['0', '10000', '100000', '1000000'], rates: ['30', '10', '3', '1'], treasury }
const W = 10n ** 18n

describe('a fee schedule proposal', () => {
  it('becomes exactly what propose takes', () => {
    expect(scheduleProposal(ok, 3000)).toEqual({
      thresholds: [0n, 10_000n * W, 100_000n * W, 1_000_000n * W],
      bps: [3000, 1000, 300, 100],
      treasury,
    })
    expect(bpsOf('2.5')).toBe(250)
    expect(bpsOf('2.555')).toBeNull()
  })
  it('is refused for what the contract refuses, before anything is signed', () => {
    expect(scheduleProposal({ ...ok, thresholds: ['1', '10000', '100000', '1000000'] }, 3000)).toMatch(/start at 0/)
    expect(scheduleProposal({ ...ok, thresholds: ['0', '10000', '10000', '1000000'] }, 3000)).toMatch(
      /above the one before/,
    )
    expect(scheduleProposal({ ...ok, rates: ['31', '10', '3', '1'] }, 3000)).toMatch(/more than 30 %/)
    expect(scheduleProposal({ ...ok, rates: ['30', '10', '12', '1'] }, 3000)).toMatch(/higher fee/)
    expect(scheduleProposal({ ...ok, treasury: '0x0000000000000000000000000000000000000000' }, 3000)).toMatch(
      /treasury/,
    )
    expect(scheduleProposal({ ...ok, rates: ['30', 'x', '3', '1'] }, 3000)).toMatch(/Tier 2/)
  })
})

const fileProblem = (r: ReturnType<typeof readEpochFile>) => (r.ok ? null : r.problem)

describe('an epoch file', () => {
  const ctx = {
    chainId: 10143,
    reserve: '0x00000000000000000000000000000000000000a5',
    distributor: '0x00000000000000000000000000000000000000d5',
  }
  const root = `0x${'ab'.repeat(32)}` as const
  const dataHash = `0x${'cd'.repeat(32)}` as const
  const total = 5000n * W
  const setRoot = {
    to: ctx.distributor,
    data: encodeFunctionData({
      abi: sdk.epochDistributorAbi as Abi,
      functionName: 'setRoot',
      args: [1n, root, total, dataHash],
    }),
  }
  const fund = (amount: bigint, totalFunded: bigint, fundedForEpoch: bigint) => ({
    to: ctx.reserve,
    data: encodeFunctionData({ abi: sdk.miningReserveAbi as Abi, functionName: 'fund', args: [1n, amount] }),
    expect: { totalFunded: totalFunded.toString(), fundedForEpoch: fundedForEpoch.toString() },
  })
  // The shape mining:epoch writes (scripts/mining/README.md): chainId a number, integers as decimal strings.
  const file = {
    chainId: 10143,
    epoch: '1',
    window: {},
    priceList: { message: {}, signer: '0x1111111111111111111111111111111111111111', signature: '0x' },
    budget: (10_000n * W).toString(),
    feeUsd: '0',
    factoryUsdPrice: '0',
    demand: '0',
    emission: total.toString(),
    total: total.toString(),
    root,
    dataHash,
    inputs: {},
    tree: { values: [{}, {}, {}] },
    claims: {},
    calls: { fund: fund(total, 0n, 0n), setRoot },
  }
  const read = (patch: Record<string, unknown>) => readEpochFile(JSON.stringify({ ...file, ...patch }), ctx)
  const base = {
    epoch: 1n,
    root,
    total,
    dataHash,
    emission: total,
    budget: 10_000n * W,
    leaves: 3,
    priceSigner: '0x1111111111111111111111111111111111111111',
  }

  it('shows empty artifacts without admitting transaction buttons or relaxing nonempty validation', () => {
    const empty = JSON.stringify({ ...file, root: null, total: '0', calls: {} })
    expect(readEpochArtifact(empty, ctx)).toEqual({ ok: true, file: { epoch: 1n, root: null } })
    expect(readEpochArtifact(JSON.stringify({ ...file, root: null }), ctx).ok).toBe(false)
    expect(
      readEpochArtifact(JSON.stringify({ ...file, root: null, total: '0', calls: {}, chainId: 143 }), ctx).ok,
    ).toBe(false)
    expect(readEpochArtifact('bad', ctx).ok).toBe(false)
    expect(readEpochArtifact(JSON.stringify(file), ctx)).toEqual(readEpochFile(JSON.stringify(file), ctx))
  })

  it('funds the whole total, the remainder, or nothing, as the run computed', () => {
    expect(read({})).toEqual({
      ok: true,
      file: { ...base, fund: { amount: total, expectTotalFunded: 0n, fundedForEpoch: 0n } },
    })
    expect(read({ calls: { fund: fund(3000n * W, 7000n * W, 2000n * W), setRoot } })).toEqual({
      ok: true,
      file: { ...base, fund: { amount: 3000n * W, expectTotalFunded: 7000n * W, fundedForEpoch: 2000n * W } },
    })
    expect(read({ calls: { setRoot } })).toEqual({ ok: true, file: { ...base, fund: null } })
  })

  it('refuses a file not in the pinned shape, for another chain, or whose calls do not match it', () => {
    expect(fileProblem(readEpochFile('not json', ctx))).toMatch(/not JSON/)
    expect(fileProblem(readEpochFile('[]', ctx))).toMatch(/not an epoch file/)
    expect(fileProblem(read({ chainId: undefined }))).toMatch(/names no chain/)
    expect(fileProblem(read({ chainId: '10143' }))).toMatch(/names no chain/)
    expect(fileProblem(read({ chainId: 143 }))).toMatch(/chain 143, not this network/)
    expect(fileProblem(read({ epoch: 1 }))).toMatch(/epoch number/)
    expect(fileProblem(read({ root: null, tree: null, calls: {} }))).toMatch(/No fee counted in epoch 1/)
    expect(fileProblem(read({ root: '0x12' }))).toMatch(/root/)
    expect(fileProblem(read({ total: 5000 }))).toMatch(/total/)
    expect(fileProblem(read({ dataHash: undefined }))).toMatch(/data hash/)
    expect(fileProblem(read({ emission: (4000n * W).toString() }))).toMatch(/more than its emission/)
    expect(fileProblem(read({ calls: undefined }))).toMatch(/no calls/)
    expect(fileProblem(read({ calls: { fund: file.calls.fund } }))).toMatch(/setRoot call/)
    expect(fileProblem(read({ calls: { ...file.calls, setRoot: { ...setRoot, to: ctx.reserve } } }))).toMatch(
      /setRoot call/,
    )
    expect(fileProblem(read({ total: (4000n * W).toString(), calls: { setRoot } }))).toMatch(/setRoot call/)
    expect(fileProblem(read({ calls: { setRoot, fund: { ...fund(total, 0n, 0n), to: ctx.distributor } } }))).toMatch(
      /fund call is not the reserve/,
    )
    expect(fileProblem(read({ calls: { setRoot, fund: { ...fund(total, 0n, 0n), expect: undefined } } }))).toMatch(
      /what was funded/,
    )
    expect(fileProblem(read({ calls: { setRoot, fund: fund(total, 2000n * W, 2000n * W) } }))).toMatch(
      /not what is left/,
    )
    expect(fileProblem(read({ calls: { setRoot, fund: fund(total + 1n, 0n, 0n) } }))).toMatch(/not what is left/)
  })
})

describe('resizing a posted root', () => {
  const root = { total: 5000n * 10n ** 18n, claimed: 1000n * 10n ** 18n }
  it('shrinks to the leaf sum, never below what is claimed', () => {
    expect(resizeProblem('4200', root)).toBeNull()
    expect(resizeProblem('1000', root)).toBeNull()
    expect(resizeProblem('999.9', root)).toMatch(/already been claimed/)
    expect(resizeProblem('5000', root)).toMatch(/below the posted/)
    expect(resizeProblem('6000', root)).toMatch(/below the posted/)
    expect(resizeProblem('', root)).toMatch(/Enter the new total/)
    expect(resizeProblem('x', root)).toMatch(/Enter the new total/)
    expect(resizeProblem('0', { total: root.total, claimed: 0n })).toBeNull()
  })
})

const fn = (to: `0x${string}`, abi: Abi, functionName: string, contract = 'x') =>
  calldata({ contract, to, abi, functionName })
const tx = (to: string, data: `0x${string}`, more: object = {}) => ({ chainId: 10143, to, data, value: '0', ...more })

describe('reading an admin transaction back from its calldata', () => {
  const owner = '0x1111111111111111111111111111111111111111'
  const other = '0x2222222222222222222222222222222222222222'
  const safe = '0x3333333333333333333333333333333333333333'
  const fees = '0x4444444444444444444444444444444444444444'
  const core = '0x5555555555555555555555555555555555555555'
  const evaluator = '0x6666666666666666666666666666666666666666'
  const token = '0x7777777777777777777777777777777777777777'
  const ctx: AdminContext = {
    chainId: 10143,
    safe,
    owner,
    targets: {
      [fees]: {
        name: 'FeeSchedule',
        abi: sdk.feeScheduleAbi as Abi,
        safe: ['acceptOwnership', 'cancel'],
        direct: ['execute'],
      },
      [core]: { name: 'Core', abi: sdk.coreAbi as unknown as Abi, safe: ['pause', 'unpause'], direct: [] },
      [evaluator]: {
        name: 'SidequestEvaluator',
        abi: sdk.sidequestEvaluatorAbi as Abi,
        safe: ['acceptOwnership', 'notePause'],
        direct: ['notePause'],
      },
    },
  }
  const pause = fn(core, sdk.coreAbi as unknown as Abi, 'pause')
  const note = fn(evaluator, sdk.sidequestEvaluatorAbi as Abi, 'notePause')
  const raw = (
    to: string,
    data: `0x${string}`,
    operation: number,
    signer = owner,
    refund = '0x0000000000000000000000000000000000000000',
  ) =>
    encodeFunctionData({
      abi: safeAbi,
      functionName: 'execTransaction',
      args: [
        to as `0x${string}`,
        0n,
        data,
        operation,
        0n,
        0n,
        0n,
        '0x0000000000000000000000000000000000000000',
        refund as `0x${string}`,
        preValidated(signer as `0x${string}`),
      ],
    })

  it('reads what the console builds', () => {
    const one = readAdminTx(
      tx(safe, execTransaction(owner, { to: fees, data: fn(fees, sdk.feeScheduleAbi as Abi, 'acceptOwnership') })),
      ctx,
    )
    expect(one).toMatchObject({
      ok: true,
      via: 'safe',
      calls: [{ contract: 'FeeSchedule', functionName: 'acceptOwnership' }],
    })
    const pair = readAdminTx(
      tx(
        safe,
        atomically(owner, [
          { to: core, data: pause },
          { to: evaluator, data: note },
        ]),
      ),
      ctx,
    )
    expect(pair).toMatchObject({
      ok: true,
      via: 'atomic',
      calls: [
        { contract: 'Core', functionName: 'pause' },
        { contract: 'SidequestEvaluator', functionName: 'notePause' },
      ],
    })
    expect(readAdminTx(tx(fees, fn(fees, sdk.feeScheduleAbi as Abi, 'execute')), ctx)).toMatchObject({
      ok: true,
      via: 'direct',
    })
  })

  it('refuses anything else', () => {
    const problem = (t: ReturnType<typeof tx>) => {
      const r = readAdminTx(t, ctx)
      return r.ok ? null : r.problem
    }
    const accept = fn(fees, sdk.feeScheduleAbi as Abi, 'acceptOwnership')
    expect(problem(tx(safe, execTransaction(owner, { to: fees, data: accept }), { chainId: 143 }))).toMatch(
      /another network/,
    )
    expect(problem(tx(safe, execTransaction(owner, { to: fees, data: accept }), { value: '1' }))).toMatch(/sends value/)
    expect(problem(tx(safe, raw(fees, accept, 0, other)))).toMatch(/not signed as you/)
    expect(problem(tx(safe, raw(fees, accept, 0, owner, other)))).toMatch(/refund/)
    expect(problem(tx(safe, execTransaction(owner, { to: token, data: '0xa9059cbb' })))).toMatch(
      /not a Sidequest contract/,
    )
    expect(
      problem(tx(safe, execTransaction(owner, { to: fees, data: fn(fees, sdk.feeScheduleAbi as Abi, 'execute') }))),
    ).toMatch(/not something this console sends as the Safe/)
    expect(problem(tx(fees, accept))).toMatch(/not something this console sends directly/)
    expect(problem(tx(safe, raw(fees, accept, 1)))).toMatch(/not to MultiSendCallOnly/)
    expect(problem(tx(safe, raw(MULTI_SEND_CALL_ONLY, multiSend([{ to: core, data: pause }]), 1)))).toMatch(
      /not a pause pair/,
    )
    expect(
      problem(
        tx(
          safe,
          raw(
            MULTI_SEND_CALL_ONLY,
            multiSend([
              { to: evaluator, data: note },
              { to: core, data: pause },
            ]),
            1,
          ),
        ),
      ),
    ).toMatch(/not a pause pair/)
    expect(
      problem(
        tx(
          safe,
          raw(
            MULTI_SEND_CALL_ONLY,
            multiSend([
              { to: core, data: pause },
              { to: fees, data: accept },
            ]),
            1,
          ),
        ),
      ),
    ).toMatch(/not a pause pair|not something/)
    expect(problem(tx(safe, raw(fees, accept, 2)))).toMatch(/unknown Safe operation/)
    expect(problem(tx(safe, '0x1234'))).toMatch(/does not decode/)
  })

  // U5-SEC-002: the core's pause and unpause go out only inside the atomic pair; a lone notePause stays allowed.
  it('refuses a standalone pause or unpause, and a pause split over two transactions', () => {
    const unpause = fn(core, sdk.coreAbi as unknown as Abi, 'unpause')
    const alonePause = tx(safe, execTransaction(owner, { to: core, data: pause }))
    const aloneUnpause = tx(safe, execTransaction(owner, { to: core, data: unpause }))
    const noteAsSafe = tx(safe, execTransaction(owner, { to: evaluator, data: note }))
    const pair = tx(
      safe,
      atomically(owner, [
        { to: core, data: pause },
        { to: evaluator, data: note },
      ]),
    )
    const refused = (txs: Array<ReturnType<typeof tx>>) => readAdminOp(txs, ctx).find((r) => !r.ok)
    for (const alone of [alonePause, aloneUnpause]) {
      expect(readAdminTx(alone, ctx)).toMatchObject({
        ok: false,
        problem: expect.stringMatching(/goes out only with the Evaluator’s notePause/),
      })
      expect(refused([alone])).toBeDefined()
    }
    expect(refused([alonePause, noteAsSafe])).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/Core\.pause goes out only with/),
    })
    // Even two transactions that each read as allowed are not one operation.
    expect(refused([noteAsSafe, noteAsSafe])).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/holds 2 transactions/),
    })
    expect(refused([pair])).toBeUndefined()
    expect(readAdminOp([pair], ctx)).toMatchObject([{ ok: true, via: 'atomic' }])
    expect(readAdminOp([noteAsSafe], ctx)).toMatchObject([
      { ok: true, via: 'safe', calls: [{ functionName: 'notePause' }] },
    ])
    expect(readAdminOp([tx(evaluator, note)], ctx)).toMatchObject([{ ok: true, via: 'direct' }])
  })

  it('sends MiningReserve.fund only signed for one Safe nonce (D18), and nothing else that way', async () => {
    // A public anvil test key, never a real one.
    const key = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
    const reserve = '0x7777777777777777777777777777777777777777'
    const fundCtx: AdminContext = {
      ...ctx,
      owner: key.address,
      targets: {
        ...ctx.targets,
        [reserve]: { name: 'MiningReserve', abi: sdk.miningReserveAbi as Abi, safe: ['fund'], direct: [] },
      },
    }
    const call = {
      to: reserve as `0x${string}`,
      data: encodeFunctionData({ abi: sdk.miningReserveAbi as Abi, functionName: 'fund', args: [1n, 3000n * W] }),
    }
    const signature = await key.signTypedData(safeTxTypedData(10143, safe, call, 7n))
    expect(readAdminTx(tx(safe, execSigned(signature, call)), fundCtx)).toMatchObject({
      ok: true,
      via: 'safe',
      calls: [{ contract: 'MiningReserve', functionName: 'fund' }],
      signature,
    })
    expect(readAdminTx(tx(safe, execTransaction(key.address, call)), fundCtx)).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/fund goes out only signed for one Safe nonce/),
    })
    // An ECDSA signature on any other call, or through MultiSend, is not something this console sends.
    expect(readAdminTx(tx(safe, execSigned(signature, { to: evaluator, data: note })), fundCtx)).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/not signed as you/),
    })
    expect(
      readAdminTx(
        tx(
          safe,
          execSigned(signature, {
            to: MULTI_SEND_CALL_ONLY,
            data: multiSend([
              { to: core, data: pause },
              { to: evaluator, data: note },
            ]),
            operation: 1,
          }),
        ),
        fundCtx,
      ),
    ).toMatchObject({ ok: false, problem: expect.stringMatching(/not signed as you/) })
  })
})

describe('a funding signed for one Safe nonce', () => {
  const guard = { nonce: '7', totalFunded: (2000n * W).toString() }
  const me = '0x1111111111111111111111111111111111111111'
  const live = { nonce: 7n, totalFunded: 2000n * W }
  it('stands only while the nonce, the reserve total and the signer are what it was signed against', () => {
    expect(fundProblem(guard, live, me, me, '1')).toBeNull()
    expect(fundProblem(guard, { ...live, nonce: 8n }, me, me, '1')).toMatch(
      /Safe nonce 7, now 8\), so the Safe would refuse it\. Run bun run mining:epoch 1 again/,
    )
    expect(fundProblem(guard, { ...live, totalFunded: 2500n * W }, me, me, '1')).toMatch(
      /funded 2,500 SIDE in all; this funding was signed when it had funded 2,000/,
    )
    expect(fundProblem(guard, live, '0x2222222222222222222222222222222222222222', me, '1')).toMatch(
      /not signed as you for the Safe’s nonce 7/,
    )
    expect(fundProblem(undefined, live, me, me, '1')).toMatch(/saved without the Safe nonce/)
    expect(fundProblem({ nonce: 'x', totalFunded: '0' }, live, me, me, '1')).toMatch(/saved without the Safe nonce/)
  })
})
