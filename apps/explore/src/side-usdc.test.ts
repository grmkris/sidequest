import type { UsdcPlan } from '@sidequest/sdk'
import { parseEther } from 'viem'
import { describe, expect, it } from 'vitest'
import { usdcAmounts, usdcBuyCap, usdcPerMillion, usdcTexts } from './side-usdc.ts'

// 14 Oct, mainnet: 2.5M SIDE for 211.91 MON, which costs 5.194052 USDC; at 3% slippage.
const buy: UsdcPlan = {
  trade: 'buy',
  usdcIn: 5_194_052n,
  usdcMax: 5_349_874n,
  mon: parseEther('211.91'),
  sideOut: parseEther('2500000'),
  sideMin: parseEther('2425000'),
}
const sell: UsdcPlan = {
  trade: 'sell',
  sideIn: parseEther('2500000'),
  mon: parseEther('211.91'),
  monMin: parseEther('205.5527'),
  usdcOut: 5_030_000n,
  usdcMin: 4_879_100n,
}

describe('a SIDE trade in USDC, as the card shows it', () => {
  it('holds the buy’s USDC maximum against the wallet, shows the quote, and measures impact on the nad.fun leg', () => {
    expect(usdcAmounts(buy)).toEqual({
      amountIn: 5_349_874n,
      shownIn: 5_194_052n,
      expectedOut: parseEther('2500000'),
      minOut: parseEther('2425000'),
      nadLeg: { amountIn: parseEther('211.91'), expectedOut: parseEther('2500000') },
      monLeft: 0n,
    })
    expect(usdcAmounts(sell)).toMatchObject({ amountIn: parseEther('2500000'), monLeft: parseEther('6.3573') })
  })

  it('keeps twice the gas ceiling for the paymaster, and writes the rate and the floors', () => {
    expect(usdcBuyCap(5_000_000n, 100_000n)).toBe(4_800_000n)
    expect(usdcBuyCap(150_000n, 100_000n)).toBe(0n)
    expect(usdcPerMillion(buy)).toBe(2_077_620n)
    expect(usdcTexts(buy, 'MON')).toEqual({
      rate: '1M SIDE ≈ $2.07',
      floor: 'You’ll get at least 2,425,000 SIDE for at most 5.35 USDC', // 5.349874, rounded up
      note: null,
    })
    expect(usdcTexts(sell, 'MON').note).toBe('About 6.35 MON stays in your wallet: the swap sells the sale’s floor.')
  })
})
