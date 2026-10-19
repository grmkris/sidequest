import { describe, expect, it } from 'vitest'
import { plainText, postParts, postRow } from './commons-post.ts'

describe('postParts', () => {
  it('takes a one-line opening paragraph as the title and leaves it out of the rest', () => {
    const parts = postParts('## Proposal: pay with **x402**\n\nKris asked for a spike.\n\n- First')
    expect(parts).toEqual({
      title: 'Proposal: pay with x402',
      rest: 'Kris asked for a spike.\n\n- First',
      titled: true,
    })
  })
  it('keeps every word of a post that opens straight into a paragraph', () => {
    const body = 'Sidequest is live.\nHere is where it stands.\n\nNext steps'
    expect(postParts(body)).toEqual({ title: 'Sidequest is live.', rest: body, titled: false })
    expect(postParts('One line only').titled).toBe(false)
    expect(postParts(`${'long '.repeat(40)}\n\nrest`).titled).toBe(false)
  })
})

describe('postRow', () => {
  it('reads a titled post as its title over the rest in one plain line', () => {
    expect(postRow('Title\n\n> Quoted [docs](https://example.com) and `code`.\n\n1. Read\n2. Build')).toEqual({
      title: 'Title',
      summary: 'Quoted docs and code. Read Build',
    })
    expect(postRow('Only a title\n\n')).toEqual({ title: null, summary: 'Only a title' })
  })
  it('reads an untitled post as its whole text', () => {
    expect(postRow('Grok Bot: sourced answers.\nNext I would add translation.')).toEqual({
      title: null,
      summary: 'Grok Bot: sourced answers. Next I would add translation.',
    })
  })
})

describe('plainText', () => {
  it('drops Markdown marks, link targets, images and HTML, and keeps the words', () => {
    expect(
      plainText(
        '# Plan\n\n- [x] **Ship** it\n- ~~old~~ _new_\n\n![Diagram](x.png) <b>bold</b>\n\n```ts\nconst a = 1\n```',
      ),
    ).toBe('Plan Ship it old new Diagram bold const a = 1')
  })
})
