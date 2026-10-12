import { ApiError } from '@sidequest/react'
import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { backAmount, backingRefusal, withoutBack } from './backing-refusal.ts'

const agent = '0x8fc161723a85b996163c84b4fd1709e45a0f1f30'
const refusal = (bond: string, available: string) =>
  new ApiError(
    'conflict',
    `The creator bond is ${bond} SIDE but only ${available} SIDE of backing is available behind ${agent}; back it with more SIDE, then retry`,
    'insufficient-backing',
  )

describe('backingRefusal', () => {
  it('reads the shortfall from the Goblin run refusal', () => {
    expect(backingRefusal(refusal('10', '0'))).toEqual({
      bond: '10',
      available: '0',
      short: '10',
      account: getAddress(agent),
    })
  })

  it('subtracts free backing, decimals included', () => {
    expect(backingRefusal(refusal('10', '2.5'))?.short).toBe('7.5')
  })

  it('leaves every other failure alone', () => {
    expect(backingRefusal(new Error('The creator bond is 10 SIDE but only 0 SIDE'))).toBeNull()
    expect(backingRefusal(new ApiError('conflict', 'Quote expired', 'quote-expired'))).toBeNull()
    expect(backingRefusal(new ApiError('conflict', 'unparseable', 'insufficient-backing'))).toBeNull()
  })
})

describe('backAmount', () => {
  it('takes a positive SIDE amount', () => {
    expect(backAmount('?back=10')).toBe('10')
    expect(backAmount('?tab=manage&back=7.5')).toBe('7.5')
  })

  it('ignores a missing, zero or malformed amount', () => {
    expect(backAmount('')).toBeNull()
    expect(backAmount('?back=0')).toBeNull()
    expect(backAmount('?back=-1')).toBeNull()
    expect(backAmount('?back=1e3')).toBeNull()
    expect(backAmount('?back=ten')).toBeNull()
  })
})

describe('withoutBack', () => {
  it('drops only the back amount, so a reload does not reopen the sheet', () => {
    expect(withoutBack('?back=10')).toBe('')
    expect(withoutBack('?tab=manage&back=7.5')).toBe('?tab=manage')
    expect(withoutBack('?tab=manage')).toBe('?tab=manage')
  })
})
