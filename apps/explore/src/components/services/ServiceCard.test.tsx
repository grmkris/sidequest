import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceCard, ServiceAsk } from './ServiceCard.tsx'
import { ServiceGallery } from './ServiceGallery.tsx'
import { renderServiceNode, serviceListing } from './service-test-support.tsx'

const nothing = () => undefined

const rich = {
  ...serviceListing,
  category: 'translation' as const,
  tags: ['English', 'Slovenian'],
  examples: ['Translate my launch note.', 'Localise a short menu.'],
  samples: [
    { url: '/samples/art.webp', caption: 'An illustration', kind: 'illustration' as const },
    { url: '/samples/draft.webp', caption: 'An outside example', kind: 'example' as const },
    { url: '/samples/work.webp', caption: 'A completed job', kind: 'delivery' as const, jobId: '7', verified: true },
    { url: '/samples/unverified.webp', caption: 'Unverified work', kind: 'delivery' as const, jobId: '8' },
  ],
}

describe('ServiceCard', () => {
  beforeEach(() => vi.stubGlobal('window', { location: { origin: 'https://dev.sidequest.exchange' } }))
  afterEach(() => vi.unstubAllGlobals())

  it('keeps sample provenance, briefs, tags, the facts and both asks in the card', async () => {
    const html = await renderServiceNode(<ServiceCard listing={rich} now={1_000} selected onToggle={nothing} />)
    expect(html).toContain('target="_blank"')
    expect(html).toContain('Illustration')
    expect(html).toContain('Delivered #7')
    expect(html).not.toContain('Delivered #8')
    expect(html).toContain('Briefs it takes')
    expect(html).toContain('Translate my launch note.')
    expect(html).toContain('Slovenian')
    expect(html).toContain('You send')
    expect(html).toContain('You get')
    expect(html).toContain('Copy prompt')
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>[\s\S]*Add to request<\/button>/)
    expect(html).toContain('invites Grok Bot to quote')
  })

  it('offers each brief it takes as a toggle that fills the brief, none picked at first', async () => {
    const html = await renderServiceNode(<ServiceAsk listing={rich} />)
    expect(html).toContain('Your brief')
    expect(html.match(/<button[^>]*aria-pressed="false"[^>]*>Translate my launch note\.<\/button>/g)).toHaveLength(1)
    expect(html.match(/<button[^>]*aria-pressed="false"[^>]*>Localise a short menu\.<\/button>/g)).toHaveLength(1)
    // Out of a sheet the actions stay in the page's flow, the prompt behind "Show prompt", and no request toggle.
    expect(html).not.toContain('sticky')
    expect(html).toMatch(/aria-expanded="false"[^>]*>Show prompt</)
    expect(html).not.toContain('Read https://dev.sidequest.exchange/start.md.')
    expect(html).not.toContain('Add to request')
  })

  it('runs the gallery one picture at a time with a dot for each, linking the proven delivery to its job', async () => {
    const html = await renderServiceNode(<ServiceGallery listing={rich} />)
    expect(html.match(/<li/g)).toHaveLength(4)
    expect(html).toContain('snap-mandatory')
    expect(html.match(/aria-label="Picture \d of 4"/g)).toHaveLength(4)
    expect(html).toMatch(/<a [^>]*href="\/job\/7"[^>]*>Delivered #7 on /)
    expect(await renderServiceNode(<ServiceGallery listing={serviceListing} />)).toBe('')
  })
})
