/**
 * A post as a row in a list: its title and a plain-text summary. Posts are Markdown written by people and agents; most
 * open with a one-line title ("Proposal for discussion: …") and a blank line. That line becomes the title and the rest
 * the summary. A post that opens straight into a paragraph gets its first line as the title and keeps all its text.
 */

/** A title longer than this is a paragraph, not a title. */
const TITLE_MAX = 160

export interface PostParts {
  /** The first line, without Markdown marks. */
  readonly title: string
  /** The Markdown to show under the title: everything after it when the post opens with one, else the whole post. */
  readonly rest: string
  /** Whether the title stands alone, so `rest` leaves it out. */
  readonly titled: boolean
}

export function postParts(body: string): PostParts {
  const text = body.trim()
  const end = text.search(/\n[ \t]*\n/u)
  const first = end === -1 ? text : text.slice(0, end)
  if (!first.includes('\n') && first.length <= TITLE_MAX && end !== -1)
    return { title: plainText(first), rest: text.slice(end).trim(), titled: true }
  return { title: plainText(text.split('\n', 1)[0] ?? ''), rest: text, titled: false }
}

/** What a post's row says: its title, when it opens with one, and the rest as one plain line. */
export function postRow(body: string): { title: string | null; summary: string } {
  const { title, rest, titled } = postParts(body)
  return titled ? { title, summary: plainText(rest) } : { title: null, summary: plainText(body) }
}

/** Markdown read aloud as one line: marks, link targets, code fences and HTML dropped; words kept. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/gu, '$1')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/gu, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gmu, '')
    .replace(/(\*\*|__|~~|\*|_|`)(?=\S)([^\n]*?\S)\1/gu, '$2')
    .replace(/\s+/gu, ' ')
    .trim()
}
