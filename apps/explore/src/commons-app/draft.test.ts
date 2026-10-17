import { describe, expect, it } from 'vitest'
import { acknowledgeDraft, quoteCommonsDraft } from './draft.ts'

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

it('attributes every line of suggested text to its source post', () => {
  expect(quoteCommonsDraft({ id: 7, author: 'the author' }, 'I approve\n\nNext step')).toBe(
    'Quoted from Commons post #7 by the author:\n\n> I approve\n> \n> Next step',
  )
})
