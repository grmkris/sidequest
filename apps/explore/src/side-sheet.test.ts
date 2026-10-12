import { describe, expect, it } from 'vitest'
import { fillMon, sideRequest, sideShort, sideTrade, withoutSide } from './side-sheet.ts'

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

  it('fills 2% over the quoted cost, rounded up to four decimals', () => {
    expect(fillMon(67_430_796_541_204_365_692n)).toBe('68.7795')
    expect(fillMon(10n ** 18n)).toBe('1.02')
    expect(fillMon(1n)).toBe('0.0001')
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
})
