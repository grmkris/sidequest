import { describe, expect, it } from 'vitest'
import { parseEther } from 'viem'
import { postingReadiness } from './bond-policy.ts'

describe('postingReadiness', () => {
  const minimum = parseEther('10')

  it('is short by the whole floor with no backing', () => {
    expect(postingReadiness(0n, minimum)).toEqual({ minimum, available: 0n, short: minimum, ready: false })
  })

  it('is short by the difference below the floor', () => {
    expect(postingReadiness(parseEther('4'), minimum).short).toBe(parseEther('6'))
  })

  it('is ready at the floor and above it', () => {
    expect(postingReadiness(minimum, minimum)).toMatchObject({ short: 0n, ready: true })
    expect(postingReadiness(parseEther('50'), minimum)).toMatchObject({ short: 0n, ready: true })
  })
})
