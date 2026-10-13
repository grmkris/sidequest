/**
 * What a user operation's gas can cost in the paymaster's token. Monad bills the whole gas limit, so the bound is the
 * limits at the max fee, converted at the paymaster's quoted rate, with a margin for the rate moving before inclusion.
 * Without a paymaster the account pays in MON: the bound is the EntryPoint's prefund, and Monad's reserve rule decides
 * whether the account may pay it at all.
 */
import type { UserOperation } from './userop.ts'

/** The paymaster's quote: who it is, how many token base units one native token (1e18 wei) costs, its post-op gas. */
export interface TokenQuote {
  readonly paymaster: `0x${string}`
  readonly exchangeRate: bigint
  readonly postOpGas: bigint
}

/** Every gas unit the operation may be billed for: its limits plus the paymaster's own. */
export const gasBound = (op: UserOperation): bigint =>
  op.verificationGasLimit +
  op.callGasLimit +
  op.preVerificationGas +
  (op.paymasterVerificationGasLimit ?? 0n) +
  (op.paymasterPostOpGasLimit ?? 0n)

/** The most the paymaster can take in token base units: the gas bound plus post-op gas at the max fee, plus 20%. */
export function maxTokenCost(op: UserOperation, quote: TokenQuote): bigint {
  const wei = (gasBound(op) + quote.postOpGas) * op.maxFeePerGas
  return (((wei * quote.exchangeRate) / 10n ** 18n) * 12n) / 10n + 1n
}

/**
 * The most a MON-paid operation (no paymaster) can cost, in wei: the EntryPoint v0.7's required prefund, every gas limit
 * at the max fee. The account pays it in `validateUserOp`; what the gas does not use stays its EntryPoint deposit.
 */
export const maxNativeCost = (op: UserOperation): bigint => gasBound(op) * op.maxFeePerGas

/** What the account itself sends the EntryPoint for a prefund: the part its deposit there does not already cover. */
export const missingAccountFunds = (prefund: bigint, deposit: bigint): bigint =>
  deposit >= prefund ? 0n : prefund - deposit

/**
 * Whether paying `missing` leaves a delegated account inside Monad's reserve rule: a bundler's transaction that takes
 * another account's MON below the reserve (or below its starting balance, if lower) reverts whole.
 */
export const keepsReserve = (balance: bigint, missing: bigint, reserve: bigint): boolean =>
  missing === 0n || balance - missing >= reserve

/** The MON a wallet holds before the MON-paid lane is offered: the reserve plus the per-operation ceiling. */
export const nativeLaneFloor = (aa: {
  readonly maxNativeCostPerOp: bigint | null
  readonly nativeReserve: bigint
}): bigint | null => (aa.maxNativeCostPerOp === null ? null : aa.nativeReserve + aa.maxNativeCostPerOp)
