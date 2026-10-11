import * as sdk from '@sidequest/sdk'
import { decodeFunctionData, slice } from 'viem'
import { describe as group, expect, it } from 'vitest'
import {
  MULTI_SEND_CALL_ONLY,
  atomically,
  calldata,
  describe,
  execTransaction,
  multiSend,
  preValidated,
  safeAbi,
  unpackMultiSend,
} from './safe.ts'

const owner = '0x1111111111111111111111111111111111111111'
const vault = '0x2222222222222222222222222222222222222222'

group('acting as the Safe', () => {
  it('signs as a pre-validated owner: r = the owner, s = 0, v = 1', () => {
    const sig = preValidated(owner)
    expect(sig.length).toBe(2 + 65 * 2)
    expect(slice(sig, 12, 32)).toBe(owner)
    expect(slice(sig, 32, 64)).toBe(`0x${'0'.repeat(64)}`)
    expect(slice(sig, 64)).toBe('0x01')
  })
  it('wraps the inner call in execTransaction as a plain call with no refund', () => {
    const inner = calldata({
      contract: 'StakeVault',
      to: vault,
      abi: sdk.stakeVaultAbi,
      functionName: 'revokeHolding',
      args: ['0x3333333333333333333333333333333333333333'],
    })
    const { functionName, args } = decodeFunctionData({
      abi: safeAbi,
      data: execTransaction(owner, { to: vault, data: inner }),
    })
    expect(functionName).toBe('execTransaction')
    expect(args).toEqual([
      vault,
      0n,
      inner,
      0,
      0n,
      0n,
      0n,
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      preValidated(owner),
    ])
  })
  it('reads a call back from its calldata, arguments by name', () => {
    const data = calldata({
      contract: 'FeeSchedule',
      to: vault,
      abi: sdk.feeScheduleAbi,
      functionName: 'propose',
      args: [{ thresholds: [0n, 1n, 2n, 3n], bps: [3000, 1000, 300, 100], treasury: owner }],
    })
    expect(describe(sdk.feeScheduleAbi, data)).toEqual({
      functionName: 'propose',
      args: [['s', `{ thresholds: [0, 1, 2, 3], bps: [3000, 1000, 300, 100], treasury: ${owner} }`]],
    })
    expect(
      describe(
        sdk.stakeVaultAbi,
        calldata({
          contract: 'StakeVault',
          to: vault,
          abi: sdk.stakeVaultAbi,
          functionName: 'proposeHolding',
          args: [owner],
        }),
      ),
    ).toEqual({
      functionName: 'proposeHolding',
      args: [['holding', owner]],
    })
  })
})

group('one atomic Safe transaction (D13)', () => {
  const core = '0x4444444444444444444444444444444444444444'
  const evaluator = '0x5555555555555555555555555555555555555555'
  const pause = calldata({ contract: 'Core', to: core, abi: sdk.coreAbi, functionName: 'pause' })
  const note = calldata({
    contract: 'SidequestEvaluator',
    to: evaluator,
    abi: sdk.sidequestEvaluatorAbi,
    functionName: 'notePause',
  })
  it('packs plain calls for MultiSendCallOnly and reads them back', () => {
    expect(
      unpackMultiSend(
        multiSend([
          { to: core, data: pause },
          { to: evaluator, data: note },
        ]),
      ),
    ).toEqual([
      { operation: 0, to: core, value: 0n, data: pause },
      { operation: 0, to: evaluator, data: note, value: 0n },
    ])
    expect(unpackMultiSend('0x12345678')).toBeNull()
  })
  it('sends them as one execTransaction that delegatecalls MultiSendCallOnly', () => {
    const { args } = decodeFunctionData({
      abi: safeAbi,
      data: atomically(owner, [
        { to: core, data: pause },
        { to: evaluator, data: note },
      ]),
    })
    expect(args[0]).toBe(MULTI_SEND_CALL_ONLY)
    expect(args[3]).toBe(1)
    expect(args[9]).toBe(preValidated(owner))
  })
})
