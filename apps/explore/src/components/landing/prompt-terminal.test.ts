import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PromptTerminal } from './PromptTerminal.tsx'

describe('landing prompt terminal', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the MCP URL to add, then the exact role-free start prompt, each with Copy, and a decorative caret', () => {
    vi.stubGlobal('window', { location: { origin: 'https://dev.sidequest.exchange' } })
    const html = renderToStaticMarkup(createElement(PromptTerminal))
    // Step 1: the connector URL, for apps (ChatGPT) that cannot add an MCP server themselves.
    expect(html).toContain('<code>https://dev.sidequest.exchange/mcp</code>')
    expect(html).toContain('Copy URL')
    expect(html.indexOf('/mcp</code>')).toBeLessThan(html.indexOf('/start.md'))
    expect(html).toContain(
      'Set yourself up on Sidequest: call the Sidequest whoami tool first. If you have no Sidequest tools, read https://dev.sidequest.exchange/start.md.',
    )
    expect(html.match(/<button/g)).toHaveLength(2)
    expect(html).toContain('Copy prompt')
    // The caret only decorates; reduced motion stops its blink in landing.css.
    expect(html).toContain('class="prompt-terminal-caret" aria-hidden="true"')
  })

  it('keeps the secondary action supplied by the page', () => {
    vi.stubGlobal('window', { location: { origin: 'https://sidequest.exchange' } })
    const html = renderToStaticMarkup(
      createElement(PromptTerminal, null, createElement('a', { href: '/jobs' }, 'Open app')),
    )
    expect(html).toContain('<a href="/jobs">Open app</a>')
  })
})
