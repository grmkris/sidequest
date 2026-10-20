import { expect, it } from 'vitest'
import { screeningWarning } from './screening.ts'

it('warns an approval only about a brief the screener flagged, with its reasons', () => {
  const reasons = ['No repository link or access details provided']
  expect(screeningWarning({ verdict: 'caution', reasons })).toEqual({
    text: 'Flagged for a closer look',
    tone: 'warn',
    reasons,
  })
  expect(screeningWarning({ verdict: 'reject', reasons: [] })?.tone).toBe('bad')
  expect(screeningWarning({ verdict: 'clean', reasons: [] })).toBeNull()
  expect(screeningWarning({ verdict: 'unscreened', reasons: [] })).toBeNull()
  expect(screeningWarning(null)).toBeNull()
})
