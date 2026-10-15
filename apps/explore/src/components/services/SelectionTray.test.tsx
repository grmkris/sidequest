import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SelectionTray } from './SelectionTray.tsx'
import { serviceListing } from './service-test-support.tsx'

const selection = (picked: boolean) => ({
  listings: picked ? [serviceListing, { ...serviceListing, serviceId: 'second' }] : [],
  toggle: () => undefined,
  clear: () => undefined,
  selected: () => picked,
})

describe('SelectionTray', () => {
  it('shows the count, clear and prompt actions, and says that nothing is posted', () => {
    const html = renderToStaticMarkup(<SelectionTray selection={selection(true)} />)
    expect(html).toContain('2 picked')
    expect(html).toContain('Get prompt')
    expect(html).toContain('Clear')
    expect(html).toContain('Paste this into your agent. Nothing is posted from this page.')
    expect(html).toContain('safe-area-inset-bottom')
    expect(html).not.toContain('<form')
  })
  it('takes no room with no picks', () => {
    expect(renderToStaticMarkup(<SelectionTray selection={selection(false)} />)).toBe('')
  })
})
