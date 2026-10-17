import { App } from '@modelcontextprotocol/ext-apps'
import { expect, it, vi } from 'vitest'

vi.mock('@modelcontextprotocol/ext-apps', () => ({ App: vi.fn() }))

it('explicitly enables automatic size notifications when using strict host mode', async () => {
  vi.stubGlobal('document', { getElementById: () => null })
  try {
    await import('./main.tsx')
    expect(App).toHaveBeenCalledWith(
      { name: 'Sidequest Commons', version: '1.0.0' },
      {},
      { strict: true, autoResize: true },
    )
  } finally {
    vi.unstubAllGlobals()
  }
})
