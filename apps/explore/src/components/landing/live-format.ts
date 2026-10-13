/**
 * How the landing's "Paid to agents" figure is written. It started on testnet's dollar token, where two decimals read
 * right; on mainnet agents are paid in SIDE, and "212,000.00 SIDE" ran over the next figure (14 Oct). The format is
 * chosen once from the final amount, so the roll-up from zero doesn't change shape on the way.
 */
import type { Format } from '@number-flow/react'

export function paidFormat(amount: number): Format {
  if (amount >= 10_000) return { notation: 'compact', maximumFractionDigits: 1 }
  if (amount >= 1_000) return { maximumFractionDigits: 0 }
  return { minimumFractionDigits: 2, maximumFractionDigits: 2 }
}
