import { describe, expect, it } from 'vitest'
import * as sdk from '@sidequest/sdk'
import { decodeAaJournal, restoreBuilt, storeBuilt } from './aa-journal.ts'
import { emptyJournal, readTxJournal, writeTxJournal } from './components/txJournal.ts'

const deployment = sdk.deployment('monad-testnet')
const actionId = 'job:post:stable-id'
const op: sdk.UserOperation = {
  sender: deployment.admin,
  nonce: sdk.laneNonce(sdk.nonceKey(actionId)),
  callData: sdk.executeCalldata([{ to: deployment.core, data: '0x1234', value: 0n }]),
  callGasLimit: 100_000n,
  verificationGasLimit: 200_000n,
  preVerificationGas: 50_000n,
  maxFeePerGas: 100n,
  maxPriorityFeePerGas: 1n,
  signature: sdk.ESTIMATE_SIGNATURE,
}
const built: sdk.BuiltUserOp = {
  chainId: deployment.chainId,
  entryPoint: deployment.aa!.entryPoint,
  maxCost: 9_999n,
  userOpHash: sdk.userOpHash(op, deployment.chainId, deployment.aa!.entryPoint),
  op,
  authorization: {
    address: deployment.delegation.delegator,
    chainId: deployment.chainId,
    nonce: 7,
    r: `0x${'ab'.repeat(32)}`,
    s: `0x${'cd'.repeat(32)}`,
    yParity: 0,
  },
}

describe('user-operation journal', () => {
  it('round trips the signed operation and first-send authorization without bigint JSON', () => {
    const saved = { actionId, built: storeBuilt(built), submittedAt: 123_000, block: '0x10' }
    const parsed = decodeAaJournal(JSON.parse(JSON.stringify(saved)))
    expect(restoreBuilt(parsed)).toEqual(built)
  })

  it('keeps a MON-paid lane and refuses any other payment value', () => {
    const saved = { actionId, payment: 'native', built: storeBuilt(built), submittedAt: 123_000, block: '0x10' }
    expect(decodeAaJournal(JSON.parse(JSON.stringify(saved))).payment).toBe('native')
    expect(decodeAaJournal({ actionId }).payment).toBeUndefined()
    expect(() => decodeAaJournal({ actionId, payment: 'usdc' })).toThrow()
  })

  it('keeps the action lane and hash across reloads in the existing durable journal', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
      removeItem: (key: string) => {
        values.delete(key)
      },
    }
    const record = { ...emptyJournal(), batch: true, aa: { actionId, built: storeBuilt(built) } }
    writeTxJournal(storage, 'one-action', record)
    const reloaded = readTxJournal(storage, 'one-action', true)
    expect(reloaded).toEqual(record)
    expect(restoreBuilt(reloaded!.aa!).op.nonce).toBe(built.op.nonce)
  })

  it('refuses corrupt amounts, hashes and another action lane', () => {
    const saved = { actionId, built: storeBuilt(built) }
    expect(() => decodeAaJournal({ ...saved, built: { ...saved.built, maxCost: 'bad' } })).toThrow()
    expect(() => restoreBuilt({ ...saved, actionId: 'different-action' })).toThrow(/lane or hash/)
    expect(() =>
      restoreBuilt({ ...saved, built: { ...saved.built, op: { ...saved.built.op, callData: '0x5678' } } }),
    ).toThrow(/lane or hash/)
    expect(() => decodeAaJournal({ ...saved, submittedAt: -1 })).toThrow()
  })
})
