import type { AccountAbstraction } from '@sidequest/sdk'

export type PaymentMode = 'userop' | 'mon-batch' | 'mon-sequential' | 'unfunded'

export interface PaymentModeInput {
  readonly aa: AccountAbstraction | null
  readonly gasTokenBalance: bigint
  readonly carriedGasToken: bigint
  readonly nativeBalance: bigint
  readonly nativeValue: bigint
  readonly delegated: boolean
  readonly canBatch: boolean
  readonly canSignAuthorization: boolean
  readonly sponsor: boolean
}

/** Choose the browser's payment lane without doing any RPC work. */
export function paymentMode(input: PaymentModeInput): PaymentMode {
  if (
    input.aa !== null &&
    (input.aa.paymaster !== null || input.sponsor) &&
    input.nativeValue === 0n &&
    (input.sponsor || input.carriedGasToken + input.gasTokenBalance >= input.aa.maxCostPerOp) &&
    (input.canSignAuthorization || input.delegated)
  )
    return 'userop'
  if (input.nativeBalance <= input.nativeValue) return 'unfunded'
  if (input.canBatch && input.nativeValue === 0n) return 'mon-batch'
  return 'mon-sequential'
}

/** The pre-signing cost copy, with USDC's six decimal places rendered as dollars. */
export function maxCostCopy(baseUnits: bigint): string {
  const cents = (baseUnits + 99n) / 100n
  const amount = `${cents / 10_000n}.${(cents % 10_000n).toString().padStart(4, '0')}`
  return `up to $${amount} gas in USDC`
}

export function paymentRefusal(mode: PaymentMode): string | null {
  return mode === 'unfunded' ? 'Add USDC or MON to your wallet to send this action.' : null
}
