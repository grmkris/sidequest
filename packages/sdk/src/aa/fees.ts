/**
 * What a user operation's gas can cost in the paymaster's token. Monad bills the whole gas limit, so the bound is the
 * limits at the max fee, converted at the paymaster's quoted rate, with a margin for the rate moving before inclusion.
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
