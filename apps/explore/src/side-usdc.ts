/**
 * A SIDE trade paid or paid out in USDC, as the trade card shows it. The route is the SDK's (swap.ts): one batch
 * through the MON/USDC pool and nad.fun, each leg bound by the slippage. These read its plan into the card's amounts,
 * texts and limits, kept pure so the card stays plain.
 */
import type { UsdcPlan } from '@sidequest/sdk'
import { formatAmount } from './format.ts'

/** What a trade is paid with (Buy) or paid out in (Sell). */
export type Coin = 'mon' | 'usdc'

export const USDC_DECIMALS = 6

/**
 * A USDC plan in the card's terms, each side in its own units (USDC 6 decimals, SIDE 18):
 * - `amountIn`: what the wallet must hold (a buy's USDC maximum, a sale's SIDE);
 * - `shownIn`: what "You pay" shows (a buy's quoted USDC);
 * - `expectedOut` and `minOut`: what comes back and its floor;
 * - `nadLeg`: the nad.fun leg, which price impact is measured on (the Uniswap pool moves no measurable amount at the
 *   sizes this card trades);
 * - `monLeft`: MON a sale leaves in the wallet, above the floor its swap sells.
 */
export function usdcAmounts(plan: UsdcPlan) {
  if (plan.trade === 'buy')
    return {
      amountIn: plan.usdcMax,
      shownIn: plan.usdcIn,
      expectedOut: plan.sideOut,
      minOut: plan.sideMin,
      nadLeg: { amountIn: plan.mon, expectedOut: plan.sideOut },
      monLeft: 0n,
    }
  return {
    amountIn: plan.sideIn,
    shownIn: plan.sideIn,
    expectedOut: plan.usdcOut,
    minOut: plan.usdcMin,
    nadLeg: { amountIn: plan.sideIn, expectedOut: plan.mon },
    monLeft: plan.mon - plan.monMin,
  }
}

/**
 * The most USDC a buy may spend: the balance less twice the per-operation gas ceiling, which the paymaster charges
 * after the swap has spent its USDC.
 */
export function usdcBuyCap(usdc: bigint, maxCostPerOp: bigint): bigint {
  const cap = usdc - 2n * maxCostPerOp
  return cap > 0n ? cap : 0n
}

/** USDC per million SIDE at this plan's rate: what 1M SIDE costs on a buy or returns on a sale, in base units. */
export function usdcPerMillion(plan: UsdcPlan): bigint {
  const million = 1_000_000n * 10n ** 18n
  const [usdc, side] = plan.trade === 'buy' ? [plan.usdcIn, plan.sideOut] : [plan.usdcOut, plan.sideIn]
  return side === 0n ? 0n : (usdc * million) / side
}

/** USDC rounded up to the cent: a maximum is never shown below what it allows. */
const centsUp = (amount: bigint) => ((amount + 9_999n) / 10_000n) * 10_000n

/** A USDC maximum as the card writes it: rounded up to the cent ("5.35" for 5.349874). */
export const usdcMaxText = (amount: bigint) => formatAmount(centsUp(amount), USDC_DECIMALS)

/** The card's lines under the amounts for a USDC trade: the rate, the floor (with a buy's ceiling), and a sale's MON. */
export function usdcTexts(plan: UsdcPlan, mon: string) {
  const a = usdcAmounts(plan)
  const rate = `1M SIDE ≈ $${formatAmount(usdcPerMillion(plan), USDC_DECIMALS)}`
  if (plan.trade === 'buy')
    return {
      rate,
      floor: `You’ll get at least ${formatAmount(a.minOut, 18)} SIDE for at most ${usdcMaxText(a.amountIn)} USDC`,
      note: null,
    }
  return {
    rate,
    floor: `You’ll get at least ${formatAmount(a.minOut, USDC_DECIMALS)} USDC`,
    note:
      a.monLeft > 0n
        ? `About ${formatAmount(a.monLeft, 18)} ${mon} stays in your wallet: the swap sells the sale’s floor.`
        : null,
  }
}
