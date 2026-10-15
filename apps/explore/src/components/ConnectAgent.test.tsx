import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mcpUrl, startPrompt } from './AgentStartLink.tsx'
import { ConnectAgent, ConnectPanel } from './ConnectAgent.tsx'

const origin = 'https://dev.sidequest.exchange'

async function render(node: ReactNode) {
  vi.stubGlobal('window', { location: { origin } })
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return renderToStaticMarkup(<RouterProvider router={router} />)
}

afterEach(() => vi.unstubAllGlobals())

describe('Connect agent', () => {
  it('shows the connector URL before the start prompt with a separate Copy URL button', async () => {
    const html = await render(<ConnectPanel />)
    expect(html).toContain(mcpUrl(origin))
    expect(html).toContain('Add Sidequest as a connector (MCP server)')
    expect(html).toContain('Copy URL')
    expect(html.indexOf(mcpUrl(origin))).toBeLessThan(html.indexOf(startPrompt(origin)))
  })

  it('shows the exact start prompt read-only beneath its second step', async () => {
    const html = await render(<ConnectPanel />)
    expect(html).toContain('Connect your agent</h2>')
    expect(html).toContain('Then send it this')
    expect(html).toContain(`>${startPrompt(origin)}</div>`)
    expect(html).not.toContain('contenteditable')
    expect(html).not.toContain('<input')
  })

  it('offers Copy prompt and a link to the full connection guide', async () => {
    const html = await render(<ConnectPanel />)
    expect(html).toMatch(/<button[^>]*class="[^"]*w-full[^"]*"[^>]*>.*Copy prompt<\/button>/)
    expect(html).toMatch(/<a[^>]*href="\/connect"[^>]*>More ways to connect<\/a>/)
  })

  it('names the supported agent apps', async () => {
    expect(await render(<ConnectPanel />)).toContain('Works with ChatGPT, Claude, Codex, Cursor and Grok.')
  })

  it.each(['header', 'sidebar', 'icon'] as const)('gives the %s trigger an accessible name', async (variant) => {
    const html = await render(<ConnectAgent variant={variant} />)
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-expanded="false"')
    if (variant === 'icon') expect(html).toContain('aria-label="Connect your agent"')
    else if (variant === 'sidebar') expect(html).toContain('Connect your agent</button>')
    else {
      expect(html).toContain('>Connect agent</span>')
      expect(html).toContain('>Connect</span>')
    }
    expect(html).not.toContain('Copy prompt')
  })
})
