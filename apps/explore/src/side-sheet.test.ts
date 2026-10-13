import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SLIPPAGE,
  fillText,
  quoteHolds,
  sideRequest,
  sideShort,
  sideTrade,
  slippageText,
  tradeAmounts,
  wholeUp,
  withoutSide,
} from './side-sheet.ts'

const side = (n: bigint) => n * 10n ** 18n

describe('the SIDE sheet', () => {
  const open = { writesOpen: true, launcher: true, address: undefined, authenticated: false }

  it('trades from the connected wallet alone, without the board sign-in', () => {
    expect(sideTrade({ ...open, address: '0xabc' })).toBe('trade')
  })

  it('asks to sign in, then says the wallet is connecting until it is', () => {
    expect(sideTrade(open)).toBe('sign-in')
    expect(sideTrade({ ...open, authenticated: true })).toBe('connecting')
  })

  it('shows links only before writes open or without a launcher', () => {
    expect(sideTrade({ ...open, writesOpen: false, address: '0xabc' })).toBe('closed')
    expect(sideTrade({ ...open, launcher: false, address: '0xabc' })).toBe('unavailable')
  })

  it('reads ?side with or without an amount and drops it after', () => {
    expect(sideRequest('')).toBeNull()
    expect(sideRequest('?tab=jobs')).toBeNull()
    expect(sideRequest('?side')).toEqual({ need: null })
    expect(sideRequest('?side=500000')).toEqual({ need: 500_000n * 10n ** 18n })
    expect(sideRequest('?side=0')).toEqual({ need: null })
    expect(sideRequest('?side=lots')).toEqual({ need: null })
    expect(withoutSide('?side=5&tab=jobs')).toBe('?tab=jobs')
    expect(withoutSide('?side')).toBe('')
  })

  it('asks for the SIDE still to buy, net of what the wallet holds', () => {
    expect(sideShort(10n, 4n)).toBe(6n)
    expect(sideShort(10n, 10n)).toBeNull()
    expect(sideShort(undefined, 4n)).toBeNull()
    expect(sideShort(10n, undefined)).toBeNull()
  })

  it('sends the typed amount in, or the quote in when the amount out was typed, with the chosen floor', () => {
    expect(tradeAmounts({ edited: 'pay', typed: 2_000n, quoted: 30_000n, slippageBps: 100 })).toEqual({
      amountIn: 2_000n,
      expectedOut: 30_000n,
      minOut: 29_700n,
    })
    expect(tradeAmounts({ edited: 'get', typed: 500_000n, quoted: 33_700n, slippageBps: 100 })).toEqual({
      amountIn: 33_700n,
      expectedOut: 500_000n,
      minOut: 495_000n,
    })
    expect(tradeAmounts({ edited: 'pay', typed: null, quoted: 1n, slippageBps: 100 })).toBeNull()
    expect(tradeAmounts({ edited: 'get', typed: 5n, quoted: undefined, slippageBps: 100 })).toBeNull()
    expect(tradeAmounts({ edited: 'get', typed: 5n, quoted: 0n, slippageBps: 100 })).toBeNull()
  })

  it('starts at 3% and refuses, before the wallet opens, a quote the price has since moved past', () => {
    expect(slippageText(DEFAULT_SLIPPAGE)).toBe('3%')
    // 13 Oct, mainnet: 2.5M SIDE quoted at 206.22 MON; by the send the same MON bought ~2.5% less, under a 1% floor.
    const typed = side(2_500_000n)
    const tight = tradeAmounts({ edited: 'get', typed, quoted: side(206n), slippageBps: 100 })!
    const roomy = tradeAmounts({ edited: 'get', typed, quoted: side(206n), slippageBps: DEFAULT_SLIPPAGE })!
    expect(roomy.minOut).toBe(side(2_425_000n))
    const now = side(2_437_500n)
    expect(quoteHolds(tight, now)).toBe(false)
    expect(quoteHolds(roomy, now)).toBe(true)
  })

  it('sells the SIDE that a typed amount of MON takes, keeping the floor on the MON', () => {
    // Typed "You get 0.5 MON" on a sale: getAmountIn quotes the SIDE that goes in.
    expect(tradeAmounts({ edited: 'get', typed: 5n * 10n ** 17n, quoted: side(7_400n), slippageBps: 100 })).toEqual({
      amountIn: side(7_400n),
      expectedOut: 5n * 10n ** 17n,
      minOut: 495n * 10n ** 15n,
    })
  })

  it('asks for whole SIDE, rounded up, and fills amounts in grouped', () => {
    expect(wholeUp(side(8_963n) + 80_900_000_000_000_000n)).toBe(side(8_964n))
    expect(wholeUp(side(500_000n))).toBe(side(500_000n))
    expect(wholeUp(5n * 10n ** 17n)).toBe(5n * 10n ** 17n)
    expect(fillText(side(500_000n))).toBe('500,000')
    expect(fillText(5n * 10n ** 17n)).toBe('0.5')
  })
})
