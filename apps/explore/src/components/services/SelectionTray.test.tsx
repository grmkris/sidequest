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
  it('shows the count, the prompt and a labelled clear, and posts nothing from the page', () => {
    const html = renderToStaticMarkup(<SelectionTray selection={selection(true)} />)
    expect(html).toContain('2 services')
    expect(html).toContain('Get prompt')
    expect(html).toContain('aria-label="Clear picked services"')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).not.toContain('<form')
  })

  it('floats above the tab bar and beside the sidebar in the app, and near the bottom edge on the landing', () => {
    const app = renderToStaticMarkup(<SelectionTray selection={selection(true)} />)
    expect(app).toContain('bottom-[calc(4.25rem+var(--safe-bottom))]')
    expect(app).toContain('lg:ps-[calc(15rem+1rem)]')
    const landing = renderToStaticMarkup(<SelectionTray selection={selection(true)} app={false} />)
    expect(landing).toContain('bottom-[calc(1rem+var(--safe-bottom))]')
    expect(landing).not.toContain('4.25rem')
  })

  it('takes no room with no picks', () => {
    expect(renderToStaticMarkup(<SelectionTray selection={selection(false)} />)).toBe('')
  })
})
