import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerTokens } from '../../format.ts'
import { deployment } from '../../wallet.ts'
import { ServiceWallCard } from './ServiceWallCard.tsx'
import { ServiceCard } from './ServiceCard.tsx'
import { renderServiceNode, serviceListing } from './service-test-support.tsx'

const nothing = () => undefined

describe('ServiceWallCard', () => {
  beforeEach(() => vi.stubGlobal('window', { location: { origin: 'https://dev.sidequest.exchange' } }))
  afterEach(() => vi.unstubAllGlobals())
  it('puts the cover first, keeps its alt and privacy attributes and exposes a sibling toggle', async () => {
    const listing = {
      ...serviceListing,
      samples: [{ url: '/samples/one.webp', caption: 'A sample translation', kind: 'example' as const }],
    }
    const html = await renderServiceNode(<ServiceWallCard listing={listing} selected onToggle={nothing} />)
    expect(html.indexOf('<img')).toBeLessThan(html.indexOf('<h3'))
    expect(html).toContain('alt="A sample translation"')
    expect(html.toLowerCase()).toContain('referrerpolicy="no-referrer"')
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('decoding="async"')
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>[\s\S]*Select<\/button>/)
    expect(html.indexOf('</a>')).toBeLessThan(html.indexOf('<button'))
    expect(html).toContain('lucide-check')
    expect(html).toContain('Quote')
    expect(html).toContain('~45 min')
    expect(html).toContain('Grok Bot')
    expect(html).not.toContain('>Example<')
  })

  it('renders legacy fields alone and omits the agent on its own page', async () => {
    const html = await renderServiceNode(
      <ServiceWallCard listing={serviceListing} showAgent={false} selected={false} onToggle={nothing} />,
    )
    expect(html).toContain('font-display')
    expect(html).toContain('aria-pressed="false"')
    expect(html).not.toContain('Grok Bot')
    expect(html).not.toContain('<canvas')
  })

  it('shows a fixed token price and only verifies the labelled delivery', async () => {
    const token = deployment.rewardTokens[0]!
    registerTokens([{ address: token, symbol: 'mUSD', decimals: 6 }])
    const listing = {
      ...serviceListing,
      price: { model: 'fixed' as const, amountBaseUnits: '4500000', token },
      samples: [
        {
          url: '/samples/result.webp',
          caption: 'Delivered text',
          kind: 'delivery' as const,
          jobId: '42',
          verified: true,
        },
      ],
    }
    const html = await renderServiceNode(<ServiceWallCard listing={listing} selected={false} onToggle={nothing} />)
    expect(html).toContain('4.5 mUSD')
    expect(html).toContain('Delivered #42')
  })

  it('keeps sample provenance, example briefs, tags and the single-service prompt in the rich card', async () => {
    const listing = {
      ...serviceListing,
      tags: ['English', 'Slovenian'],
      examples: ['Translate my launch note.'],
      samples: [
        { url: '/samples/art.webp', caption: 'An illustration', kind: 'illustration' as const },
        { url: '/samples/draft.webp', caption: 'An outside example', kind: 'example' as const },
        {
          url: '/samples/work.webp',
          caption: 'A completed job',
          kind: 'delivery' as const,
          jobId: '7',
          verified: true,
        },
        { url: '/samples/unverified.webp', caption: 'Unverified work', kind: 'delivery' as const, jobId: '8' },
      ],
    }
    const html = await renderServiceNode(<ServiceCard listing={listing} now={1_000} selected onToggle={nothing} />)
    expect(html).toContain('target="_blank"')
    expect(html).toContain('Illustration')
    expect(html).toContain('Delivered #7')
    expect(html).not.toContain('Delivered #8')
    expect(html).toContain('Briefs it takes')
    expect(html).toContain('“Translate my launch note.”')
    expect(html).toContain('Slovenian')
    expect(html).toContain('Add to request')
    expect(html).toContain('Read https://dev.sidequest.exchange/start.md.')
    expect(html).toContain('You send')
    expect(html).toContain('You get')
  })
})
