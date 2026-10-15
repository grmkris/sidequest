import { describe, expect, it } from 'vitest'
import type { ServiceListing } from './services.ts'
import { CATEGORY_LABELS, categoriesOf, coverOf, filterServices, sampleLabel } from './service-wall.ts'

const listing = (overrides: Partial<ServiceListing> = {}): ServiceListing => ({
  serviceId: 's',
  name: 'Site design',
  description: 'A polished page',
  inputs: 'a brief',
  outputs: 'a working site',
  turnaroundSeconds: 600,
  price: { model: 'quote', amountBaseUnits: '0', token: '0x0000000000000000000000000000000000000001' },
  adHash: 'hash',
  expiresAt: null,
  agentId: '7',
  agentName: 'Patch',
  wallet: '0x0000000000000000000000000000000000000001',
  presence: { freshness: 'unknown', state: null, accepting: false, lastSeenBucket: null },
  lastMcpCallAt: null,
  delivered: 0,
  delivered7d: 0,
  ...overrides,
})

describe('service wall helpers', () => {
  it('keeps the agreed category labels and order', () => {
    expect(CATEGORY_LABELS.map(({ label }) => label)).toEqual([
      'Video',
      'Audio',
      'Image',
      '3D',
      'Sites',
      'Games',
      'Research',
      'Writing',
      'Translation',
      'Data',
      'Code',
      'Onchain',
    ])
    expect(categoriesOf([listing()])).toEqual([])
  })

  it('returns categories in display order with counts', () => {
    expect(
      categoriesOf([
        listing({ category: 'writing' }),
        listing({ serviceId: 'b', category: 'site' }),
        listing({ serviceId: 'c', category: 'writing' }),
      ]),
    ).toEqual([
      { value: 'site', label: 'Sites', count: 1 },
      { value: 'writing', label: 'Writing', count: 2 },
    ])
  })

  it('matches every query term across card fields and filters by category', () => {
    const one = listing({ tags: ['solidity'], category: 'code' })
    expect(filterServices([one], 'PATCH solidity site')).toEqual([one])
    expect(filterServices([one], 'solidity', 'writing')).toEqual([])
    expect(filterServices([one], '  PATCH\tpolished\nbrief working code  ', 'code')).toEqual([one])
    expect(filterServices([one], 'patch missing')).toEqual([])
    expect(filterServices([one], ' \n ')).toEqual([one])
  })

  it('handles old listings and refuses an unverified delivery as a cover', () => {
    expect(coverOf(listing())).toBeNull()
    expect(coverOf({ samples: [] })).toBeNull()
    expect(coverOf({ samples: [{ url: 'a', caption: 'Work', kind: 'delivery', jobId: '1' }] })).toBeNull()
  })

  it('uses the first eligible sample in its original order', () => {
    const illustration = { url: 'a', caption: 'Art', kind: 'illustration' as const }
    const delivery = { url: 'b', caption: 'Work', kind: 'delivery' as const, jobId: '1', verified: true }
    expect(coverOf({ samples: [illustration, delivery] })).toEqual(illustration)
    expect(coverOf({ samples: [delivery, illustration] })).toEqual(delivery)
    expect(sampleLabel(illustration)).toBe('Illustration')
    expect(sampleLabel({ ...delivery, verified: false })).toBe('Example')
  })

  it('chooses a useful cover and labels verified deliveries', () => {
    const samples = [
      { url: 'a', caption: 'An unverified delivery', kind: 'delivery' as const, jobId: '8' },
      { url: 'b', caption: 'A real result', kind: 'example' as const },
      { url: 'c', caption: 'A delivered result', kind: 'delivery' as const, jobId: '9', verified: true },
    ]
    expect(coverOf({ samples })).toEqual(samples[1])
    expect(sampleLabel(samples[0]!)).toBe('Example')
    expect(sampleLabel(samples[2]!)).toBe('Delivered #9')
  })
})
