import { describe, expect, it } from 'vitest'
import { parseUnits } from 'viem'
import { TOKENS, amount, dayLabel, formatAmount, formatNumber, registerTokens, shortAgo, shortSpan } from './format.ts'

describe('token amount display', () => {
  it('does not guess decimals for unknown tokens', () => {
    expect(amount('5000000', '0x9999999999999999999999999999999999999999')).toBe('— tokens')
  })
  it('keeps the real symbol and decimals after metadata resolution', () => {
    const address = '0x9999999999999999999999999999999999999999'
    registerTokens([{ address, symbol: 'OPEN', decimals: 6 }])
    expect(amount('5000000', address)).toBe('5 OPEN')
  })
  it('does not render positive dust as zero', () => {
    expect(formatNumber(1n, 18)).toBe('<0.0001')
    expect(formatNumber(1n, 6)).toBe('<0.0001')
  })
  it('retains listed metadata', () => {
    expect(Object.keys(TOKENS).length).toBeGreaterThan(0)
  })
})

describe('list times', () => {
  it('says how long ago in the shortest unit a column needs', () => {
    const now = 1_000_000
    expect(
      [0, 59, 60, 3599, 3600, 86_399, 86_400, 7 * 86_400 - 1, 7 * 86_400, 30 * 86_400].map((s) =>
        shortAgo(now - s, now),
      ),
    ).toEqual(['now', 'now', '1m', '59m', '1h', '23h', '1d', '6d', '1w', '4w'])
    expect(shortAgo(now + 30, now)).toBe('now')
    expect([40, 720, 7200, 3 * 86_400].map(shortSpan)).toEqual(['40s', '12m', '2h', '3d'])
  })

  it('heads a day as Today, Yesterday or its date, in the reader time zone', () => {
    const noon = new Date(2026, 9, 10, 12, 0, 0).getTime() / 1000
    expect(dayLabel(noon - 3600, noon)).toBe('Today')
    expect(dayLabel(noon - 86_400, noon)).toBe('Yesterday')
    expect(dayLabel(noon - 2 * 86_400, noon)).toMatch(/8/)
  })
})

const e18 = (s: string) => parseUnits(s, 18)

describe('formatAmount', () => {
  it('reads whole units from 1,000, two decimals from 1, four significant digits below, never rounding up', () => {
    expect(formatAmount(e18('29687.2033'), 18)).toBe('29,687')
    expect(formatAmount(e18('1000000'), 18)).toBe('1,000,000')
    expect(formatAmount(e18('10.2759'), 18)).toBe('10.27')
    expect(formatAmount(e18('1.5'), 18)).toBe('1.5')
    expect(formatAmount(e18('0.064699'), 18)).toBe('0.06469')
    expect(formatAmount(e18('0.000012345'), 18)).toBe('0.00001234')
    expect(formatAmount(0n, 18)).toBe('0')
    expect(formatAmount(1_500_000n, 6)).toBe('1.5')
  })
})
