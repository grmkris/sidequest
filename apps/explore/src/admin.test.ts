import { describe, expect, it } from 'vitest'
import * as sdk from '@sidequest/sdk'
import { type Abi, encodeFunctionData } from 'viem'
import { type AdminContext, bpsOf, readAdminOp, readAdminTx, scheduleProposal } from './admin.ts'

import {
  MULTI_SEND_CALL_ONLY,
  atomically,
  calldata,
  execTransaction,
  multiSend,
  preValidated,
  safeAbi,
} from './safe.ts'

const treasury = '0x9999999999999999999999999999999999999999'
const W = 10n ** 18n
const ok = { thresholds: ['0', '10000', '100000', '1000000'], rates: ['30', '10', '3', '1'], treasury }

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
})
