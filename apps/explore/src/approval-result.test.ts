import { expect, it } from 'vitest'
import { approvalResult } from './approval-result.ts'

it.each([null, undefined, {}, { status: 1 }, { status: 'unexpected' }, { approval: {} }])(
  'does not claim completion for an unreadable response: %j',
  (value) => {
    expect(approvalResult(value)).toContain('did not confirm completion')
  },
)

it('distinguishes a saved decision from completion and a fresh approval', () => {
  expect(approvalResult({ status: 'confirmed' })).toBe('Operation confirmed.')
  expect(approvalResult({ status: 'pending' })).toContain('execution is not confirmed')
  expect(approvalResult({ approval: { status: 'rejected' } })).toContain('Request rejected')
  expect(approvalResult({ status: 'approval' })).toContain('needs a fresh approval')
})
