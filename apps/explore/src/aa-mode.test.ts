import { describe, expect, it } from 'vitest'
import type { AccountAbstraction } from '@sidequest/sdk'
import { maxCostCopy, paymentMode, paymentRefusal } from './aa-mode.ts'

const aa: AccountAbstraction = {
  entryPoint: '0x1111111111111111111111111111111111111111',
  paymaster: '0x2222222222222222222222222222222222222222',
  paymasterKind: 'sidequest-testnet',
  gasToken: '0x3333333333333333333333333333333333333333',
  standingApproval: 1_000_000n,
  maxCostPerOp: 250_000n,
}

describe('browser payment mode', () => {
  it('uses a user operation for a funded delegated wallet', () => {
    expect(
      paymentMode({
        aa,
        gasTokenBalance: aa.maxCostPerOp,
        carriedGasToken: 0n,
        nativeBalance: 0n,
        nativeValue: 0n,
        delegated: true,
        canBatch: true,
        canSignAuthorization: true,
        sponsor: false,
      }),
    ).toBe('userop')
  })

  it('allows a faucet user operation with zero USDC', () => {
    expect(
      paymentMode({
        aa,
        gasTokenBalance: 0n,
        carriedGasToken: 0n,
        nativeBalance: 0n,
        nativeValue: 0n,
        delegated: false,
        canBatch: false,
        canSignAuthorization: true,
        sponsor: true,
      }),
    ).toBe('userop')
  })

  it('falls back to a MON batch or sequential wallet sends', () => {
    expect(
      paymentMode({
        aa,
        gasTokenBalance: 0n,
        carriedGasToken: 0n,
        nativeBalance: 1n,
        nativeValue: 0n,
        delegated: false,
        canBatch: true,
        canSignAuthorization: false,
        sponsor: false,
      }),
    ).toBe('mon-batch')
    expect(
      paymentMode({
        aa: null,
        gasTokenBalance: 0n,
        carriedGasToken: 0n,
        nativeBalance: 0n,
        nativeValue: 0n,
        delegated: false,
        canBatch: false,
        canSignAuthorization: false,
        sponsor: false,
      }),
    ).toBe('unfunded')
  })

  it('keeps the refusal and cost copy human readable', () => {
    expect(paymentRefusal('unfunded')).toBe('Add USDC or MON to your wallet to send this action.')
    expect(paymentRefusal('userop')).toBeNull()
    expect(maxCostCopy(7_000n)).toBe('up to $0.0070 gas in USDC')
    expect(maxCostCopy(100_000n)).toBe('up to $0.1000 gas in USDC')
    expect(maxCostCopy(1n)).toBe('up to $0.0001 gas in USDC')
  })

  it('requires a paymaster and authorization support, even if the batch carries USDC', () => {
    const input = {
      aa,
      gasTokenBalance: 0n,
      carriedGasToken: aa.maxCostPerOp,
      nativeBalance: 0n,
      nativeValue: 0n,
      delegated: false,
      canBatch: false,
      canSignAuthorization: true,
      sponsor: false,
    }
    expect(paymentMode(input)).toBe('userop')
    expect(paymentMode({ ...input, canSignAuthorization: false })).toBe('unfunded')
    expect(paymentMode({ ...input, aa: { ...aa, paymaster: null } })).toBe('unfunded')
    expect(paymentMode({ ...input, nativeBalance: 1n, canSignAuthorization: false })).toBe('mon-sequential')
    expect(paymentMode({ ...input, nativeBalance: 2n, nativeValue: 1n })).toBe('mon-sequential')
  })
})
