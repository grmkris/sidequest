import { describe, expect, it } from 'vitest'
import { acknowledgeDraft } from './draft.ts'

describe('acknowledgeDraft', () => {
  it('clears the exact submitted snapshot', () => {
    expect(acknowledgeDraft('first', 'first')).toBe('')
  })

  it('preserves a choice appended while the host was acknowledging', () => {
    expect(acknowledgeDraft('first\n\nsecond', 'first')).toBe('second')
  })

  it('preserves unrelated current text', () => {
    expect(acknowledgeDraft('first edited', 'first')).toBe('first edited')
  })
})
