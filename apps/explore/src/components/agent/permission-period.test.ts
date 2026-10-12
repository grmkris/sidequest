import { expect, it } from 'vitest'
import { periodText } from './PermissionApproval.tsx'

it('words a permission period in its largest whole unit, never as zero hours', () => {
  expect(periodText(600)).toBe('10 min')
  expect(periodText(1800)).toBe('30 min')
  expect(periodText(3600)).toBe('1 h')
  expect(periodText(5400)).toBe('1.5 h')
  expect(periodText(86_400)).toBe('day')
  expect(periodText(3 * 86_400)).toBe('3 days')
  expect(periodText(604_800)).toBe('week')
  expect(periodText(2 * 604_800)).toBe('2 weeks')
})
