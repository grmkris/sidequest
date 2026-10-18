import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Markdown } from './Markdown.tsx'

it('shows the exact authored text before the formatting chunk has loaded', () => {
  const body = '**Plan**\nSecond line'
  const html = renderToStaticMarkup(<Markdown>{body}</Markdown>)
  expect(html).toContain('whitespace-pre-line')
  expect(html).toContain('**Plan**\nSecond line')
  expect(html).not.toContain('<strong>Plan</strong>')
})
