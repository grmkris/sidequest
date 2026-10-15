import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerTokens } from '../../format.ts'
import { deployment } from '../../wallet.ts'
import { ServiceWallCard } from './ServiceWallCard.tsx'
import { renderServiceNode, serviceListing } from './service-test-support.tsx'

const nothing = () => undefined

describe('ServiceWallCard', () => {
  beforeEach(() => vi.stubGlobal('window', { location: { origin: 'https://dev.sidequest.exchange' } }))
  afterEach(() => vi.unstubAllGlobals())
  it('puts the cover first, keeps its alt and privacy attributes, and picks with a labelled toggle beside the link', async () => {
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
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*aria-label="Add A clear translation to request"/)
    // The toggle is the tile link's sibling, never inside it.
    expect(html).not.toMatch(/<a [^>]*>(?:(?!<\/a>)[\s\S])*<button/)
    expect(html).toContain('lucide-check')
    expect(html).toContain('~45 min')
    expect(html).toContain('Grok Bot')
    expect(html).not.toContain('>Example<')
  })

  it('leaves a quote-priced tile without a price, and the agent out on its own page', async () => {
    const html = await renderServiceNode(
      <ServiceWallCard listing={serviceListing} showAgent={false} selected={false} onToggle={nothing} />,
    )
    expect(html).not.toContain('Quote')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('lucide-plus')
    expect(html).not.toContain('Grok Bot')
    expect(html).not.toContain('<canvas')
  })

  it('fills a missing cover with its category colour and mark, so the wall keeps its rhythm', async () => {
    const html = await renderServiceNode(
      <ServiceWallCard listing={{ ...serviceListing, category: 'translation' }} selected={false} onToggle={nothing} />,
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('background-color:#D3EDE7')
    expect(html).toContain('lucide-languages')
  })

  it('shows a fixed token price and links only the verified delivery, on a wide tile', async () => {
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
    const html = await renderServiceNode(<ServiceWallCard listing={listing} wide selected={false} onToggle={nothing} />)
    expect(html).toContain('4.5 mUSD')
    expect(html).toMatch(/<a [^>]*href="\/job\/42"[^>]*>(?:(?!<\/a>)[\s\S])*Delivered #42<\/a>/)
    expect(html).toContain('sm:aspect-2/1')
    const unverified = await renderServiceNode(
      <ServiceWallCard
        listing={{ ...listing, samples: [{ ...listing.samples[0]!, verified: false }] }}
        selected={false}
        onToggle={nothing}
      />,
    )
    expect(unverified).not.toContain('Delivered #')
  })
})
