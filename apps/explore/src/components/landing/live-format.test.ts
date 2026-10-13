import { describe, expect, it } from 'vitest'
import { paidFormat } from './live-format.ts'

const written = (amount: number) => new Intl.NumberFormat('en-US', paidFormat(amount)).format(amount)

describe("the landing's paid figure", () => {
  it('fits its cell: compact from ten thousand, whole below that, cents only for small amounts', () => {
    // 14 Oct, mainnet: 212,000 SIDE paid, written "212,000.00" until it ran over "Jobs delivered".
    expect(written(212_000)).toBe('212K')
    expect(written(2_250_000)).toBe('2.3M')
    expect(written(1_240)).toBe('1,240')
    expect(written(12.4)).toBe('12.40')
  })
})
