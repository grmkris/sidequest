import { renderToStaticMarkup } from 'react-dom/server'
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5'
import { expect, it, vi } from 'vitest'
import { Markdown } from './Markdown.tsx'

function elements(node: DefaultTreeAdapterTypes.Node): DefaultTreeAdapterTypes.Element[] {
  return [...('tagName' in node ? [node] : []), ...('childNodes' in node ? node.childNodes.flatMap(elements) : [])]
}
const render = (body: string) => renderToStaticMarkup(<Markdown>{body}</Markdown>)
const nodes = (body: string) => elements(parseFragment(render(body)))
const attr = (node: DefaultTreeAdapterTypes.Element, name: string) => node.attrs.find((a) => a.name === name)?.value

it('renders structured proposals without introducing a second page title', () => {
  const html = render(
    '# Plan\n\n## First step\n\nUse **clear goals** and *small steps*.\n\n1. Read\n2. Build\n   - Review\n\n> Keep the scope small.\n\n~~Old plan~~',
  )
  for (const tag of ['h3', 'h4', 'strong', 'em', 'ol', 'ul', 'blockquote', 'del']) expect(html).toContain(`<${tag}`)
  expect(html).not.toContain('<h1')
  expect(html).not.toContain('<h2')
})

it('renders nested completed and incomplete tasks as read-only author content', () => {
  const checks = nodes('- [x] Read the brief\n- [ ] Build\n  - [ ] Review').filter((node) => node.tagName === 'input')
  expect(checks).toHaveLength(3)
  expect(checks.map((node) => attr(node, 'checked'))).toEqual(['', undefined, undefined])
  expect(checks.every((node) => attr(node, 'disabled') === '')).toBe(true)
  expect(checks.map((node) => attr(node, 'aria-label'))).toEqual([
    'Completed task',
    'Incomplete task',
    'Incomplete task',
  ])
})

it('keeps code literal and makes wide code and tables keyboard-scrollable', () => {
  const html = render(
    '`get_task`\n\n```html\n<script>alert(1)</script>\n```\n\n| Step | Owner |\n| --- | --- |\n| Review | Agent |',
  )
  const all = elements(parseFragment(html))
  expect(html).toContain('<code>get_task</code>')
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(all.some((node) => node.tagName === 'table')).toBe(true)
  expect(
    all
      .filter((node) => attr(node, 'tabindex') === '0' && node.tagName !== 'button')
      .map((node) => attr(node, 'aria-label')),
  ).toEqual(['Code block', 'Table'])
})

it('keeps ordinary messages and line breaks intact', () => {
  expect(render('First line\nSecond line\n\nNext paragraph')).toContain(
    '<p>First line\nSecond line</p>\n<p>Next paragraph</p>',
  )
})

it('renders safe links and reference links while refusing executable URLs', () => {
  const links = nodes(
    '[Docs](/docs) https://example.com [Mail](mailto:hello@example.com) [Reference][ref]\n\n[ref]: https://example.com/plan\n\n[Bad](javascript:alert%281%29) [Data](data:text/html;base64,PHNjcmlwdD4=) [Encoded](java&#x73;cript:alert%281%29)',
  ).filter((node) => node.tagName === 'a')
  expect(links.map((node) => attr(node, 'href'))).toEqual([
    '/docs',
    'https://example.com',
    'mailto:hello@example.com',
    'https://example.com/plan',
  ])
  expect(links.every((node) => attr(node, 'rel') === 'nofollow ugc noopener noreferrer')).toBe(true)
})

it('never executes raw HTML or loads remote images from a public post', () => {
  const all = nodes(
    '<script>alert(1)</script>\n\n<img src="https://example.com/tracker" onerror="alert(1)">\n\n<iframe src="https://example.com"></iframe>\n\n![Diagram](https://example.com/diagram.png)',
  )
  expect(all.some((node) => ['script', 'img', 'iframe'].includes(node.tagName))).toBe(false)
  expect(all.some((node) => node.attrs.some((a) => a.name.startsWith('on')))).toBe(false)
  expect(all.filter((node) => node.tagName === 'a').map((node) => attr(node, 'href'))).toEqual([
    'https://example.com/diagram.png',
  ])
})

it('discloses off-site destinations for misleading text and image labels while keeping local links plain', () => {
  vi.stubGlobal('location', new URL('https://sidequest.exchange/commons'))
  try {
    const html = render(
      '[https://sidequest.exchange/wallet](https://lookalike.example/wallet) ![Trusted](//images.example/track.png) [Local](https://sidequest.exchange/docs) [Relative](/docs)',
    )
    const links = elements(parseFragment(html)).filter((node) => node.tagName === 'a')
    expect(html).toContain('https://sidequest.exchange/wallet (lookalike.example)')
    expect(html).toContain('Trusted (images.example)')
    expect(links.map((node) => attr(node, 'target'))).toEqual(['_blank', '_blank', undefined, undefined])
    expect(html).not.toContain('Local (sidequest.exchange)')
  } finally {
    vi.unstubAllGlobals()
  }
})
