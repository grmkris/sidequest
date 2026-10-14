import { describe, expect, it } from 'vitest'
import type { AccountAbstraction } from '@sidequest/sdk'
import {
  type PaymentModeInput,
  atomicRefusal,
  ceilingRefusal,
  maxCostCopy,
  maxNativeCostCopy,
  paymentMode,
  paymentRefusal,
  paymentRoute,
  userOpCostCopy,
} from './aa-mode.ts'

const aa: AccountAbstraction = {
  entryPoint: '0x1111111111111111111111111111111111111111',
  paymaster: '0x2222222222222222222222222222222222222222',
  paymasterKind: 'sidequest-testnet',
  gasToken: '0x3333333333333333333333333333333333333333',
  standingApproval: 1_000_000n,
  maxCostPerOp: 250_000n,
  maxNativeCostPerOp: null,
  nativeReserve: 0n,
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

  it('sends a batch that funds its own MON as one USDC operation only, with twice the ceiling left after its spend', () => {
    const base: PaymentModeInput = {
      aa,
      gasTokenBalance: 5_000_000n,
      carriedGasToken: 0n,
      nativeBalance: 0n,
      nativeValue: 0n,
      delegated: false,
      canBatch: false,
      canSignAuthorization: true,
      sponsor: false,
    }
    const spend = 5_000_000n - 2n * aa.maxCostPerOp
    expect(paymentMode({ ...base, funded: { gasTokenSpend: spend } })).toBe('userop')
    // One unit less USDC and the paymaster's charge could fail after the swap: refused, not split into MON sends.
    expect(paymentMode({ ...base, funded: { gasTokenSpend: spend + 1n } })).toBe('unfunded')
    expect(paymentMode({ ...base, nativeBalance: 10n ** 21n, funded: { gasTokenSpend: spend + 1n } })).toBe('unfunded')
    expect(paymentMode({ ...base, aa: { ...aa, paymaster: null }, funded: { gasTokenSpend: 0n } })).toBe('unfunded')
    expect(paymentMode({ ...base, canSignAuthorization: false, funded: { gasTokenSpend: 0n } })).toBe('unfunded')
  })

  it('allows a faucet user operation with zero USDC', () => {
    expect(
      paymentMode({
        aa: { ...aa, paymaster: null },
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

const MON = 10n ** 18n
const native: AccountAbstraction = { ...aa, maxNativeCostPerOp: 4n * MON, nativeReserve: 10n * MON }
/** A Privy wallet holding only MON, not yet upgraded: the agent-registration case. */
const monOnly: PaymentModeInput = {
  aa: native,
  gasTokenBalance: 0n,
  carriedGasToken: 0n,
  nativeBalance: 14n * MON,
  nativeValue: 0n,
  delegated: false,
  canBatch: false,
  canSignAuthorization: true,
  sponsor: false,
}

/** The steps an action that must be one atomic batch renders for a selected mode. */
const atomic = (mode: ReturnType<typeof paymentMode> | undefined, extra = {}) =>
  paymentRoute({ savedAa: false, legacy: false, mode, requireAtomic: true, ...extra })

describe('MON-paid user operations', () => {
  it.each<[string, Partial<PaymentModeInput>, string]>([
    ['a MON-only wallet that can authorize its upgrade', {}, 'userop-native'],
    ['an upgraded MON-only wallet', { delegated: true, canBatch: true, canSignAuthorization: false }, 'userop-native'],
    ['USDC first, whenever it covers the gas', { gasTokenBalance: aa.maxCostPerOp }, 'userop'],
    ['a faucet claim stays sponsored', { sponsor: true }, 'userop'],
    ['MON short of the reserve plus the ceiling', { nativeBalance: 14n * MON - 1n }, 'mon-sequential'],
    [
      'an upgraded wallet short of it batches plain',
      { nativeBalance: MON, delegated: true, canBatch: true },
      'mon-batch',
    ],
    ['a wallet that cannot authorize and is not upgraded', { canSignAuthorization: false }, 'mon-sequential'],
    ['an action that sends MON value', { nativeValue: 1n }, 'mon-sequential'],
    ['a network without the MON-paid lane', { aa: { ...native, maxNativeCostPerOp: null } }, 'mon-sequential'],
    ['no AA at all', { aa: null }, 'mon-sequential'],
    ['no MON and no USDC', { nativeBalance: 0n }, 'unfunded'],
  ])('%s', (_case, patch, mode) => {
    expect(paymentMode({ ...monOnly, ...patch })).toBe(mode)
  })

  it('sends an action that must be one atomic batch from a MON-only wallet as a MON-paid operation', () => {
    expect(atomic(paymentMode(monOnly))).toBe('userop-native')
    expect(atomic('userop')).toBe('userop')
    expect(atomic('mon-sequential')).toBe('atomic-refused')
    expect(atomic('mon-batch')).toBe('mon')
    expect(atomic('mon-sequential', { requireAtomic: false })).toBe('mon')
    expect(atomic('mon-sequential', { savedAa: true, legacy: true })).toBe('userop')
    expect(atomic('userop-native', { legacy: true })).toBe('mon')
    expect(atomic(undefined)).toBe('waiting')
    expect(atomic('unfunded')).toBe('waiting')
  })

  it('tells a MON-only wallet what MON suffices instead of asking for USDC', () => {
    expect(atomicRefusal(native)).toBe(
      'This action needs one atomic batch. Use your Sidequest wallet with USDC, or with at least 14 MON (Monad keeps 10 MON in an upgraded wallet).',
    )
    expect(atomicRefusal(aa)).toBe('This action needs one atomic batch. Add USDC and use your Sidequest wallet.')
    expect(ceilingRefusal(true, native)).toBe(
      'Gas would exceed the per-action MON limit or leave less than 10 MON in your wallet. Nothing was signed or sent.',
    )
    expect(ceilingRefusal(false, native)).toBe('Gas exceeds the per-action USDC limit. Nothing was signed or sent.')
  })

  it('shows a MON-paid cost in MON, rounded up, and a paymaster-paid one in USDC', () => {
    expect(maxNativeCostCopy(1n)).toBe('up to 0.0001 MON gas')
    expect(maxNativeCostCopy(123_456_789_000_000_000n)).toBe('up to 0.1235 MON gas')
    expect(maxNativeCostCopy(4n * MON)).toBe('up to 4.0000 MON gas')
    expect(userOpCostCopy({ op: {}, maxCost: MON / 10n })).toBe('up to 0.1000 MON gas')
    expect(userOpCostCopy({ op: { paymaster: aa.paymaster! }, maxCost: 7_000n })).toBe('up to $0.0070 gas in USDC')
  })
})
