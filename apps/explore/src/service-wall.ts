import type { ServiceListing, ServiceCategory, ServiceSample } from './services.ts'

export const CATEGORY_LABELS: readonly { value: ServiceCategory; label: string }[] = [
  { value: 'video', label: 'Video' },
  { value: 'audio', label: 'Audio' },
  { value: 'image', label: 'Image' },
  { value: '3d', label: '3D' },
  { value: 'site', label: 'Sites' },
  { value: 'game', label: 'Games' },
  { value: 'research', label: 'Research' },
  { value: 'writing', label: 'Writing' },
  { value: 'translation', label: 'Translation' },
  { value: 'data', label: 'Data' },
  { value: 'code', label: 'Code' },
  { value: 'onchain', label: 'Onchain' },
]

export function categoriesOf(list: readonly ServiceListing[]) {
  const counts = new Map<ServiceCategory, number>()
  for (const listing of list)
    if (listing.category !== undefined) counts.set(listing.category, (counts.get(listing.category) ?? 0) + 1)
  return CATEGORY_LABELS.filter(({ value }) => counts.has(value)).map(({ value, label }) => ({
    value,
    label,
    count: counts.get(value)!,
  }))
}

export function filterServices(list: readonly ServiceListing[], q: string, category?: ServiceCategory | null) {
  const terms = q.trim().toLowerCase().split(/\s+/u).filter(Boolean)
  return list.filter((listing) => {
    if (category !== undefined && category !== null && listing.category !== category) return false
    const text = [
      listing.name,
      listing.description,
      listing.inputs,
      listing.outputs,
      listing.agentName,
      ...(listing.tags ?? []),
      listing.category ?? '',
    ]
      .join(' ')
      .toLowerCase()
    return terms.every((term) => text.includes(term))
  })
}

/**
 * Each category's colour field, the seamless background its covers are shot on. A cover that cannot load falls back to
 * the same field, so the wall keeps its rhythm. These are picture colours: they read the same in both themes.
 */
export const CATEGORY_TINTS: Readonly<Record<ServiceCategory, string>> = {
  video: '#E7DDF7',
  audio: '#F9DCCB',
  image: '#F6E7B8',
  '3d': '#F3D5DD',
  site: '#D6E6F7',
  game: '#FBD8B0',
  research: '#DCE8D5',
  writing: '#EFE7DA',
  translation: '#D3EDE7',
  data: '#D8EEF2',
  code: '#DEE1E8',
  onchain: '#DDD8F6',
}

/** The delivery a service can prove: a sample checked against a completed job on this chain. */
export const provenDelivery = (listing: Pick<ServiceListing, 'samples'>): ServiceSample | null =>
  listing.samples?.find((sample) => sample.kind === 'delivery' && sample.verified === true) ?? null

/** Proof first: services with a verified delivery lead the wall as wide tiles, in their own order, then the rest. */
export function splitFeatured<T extends Pick<ServiceListing, 'samples'>>(
  list: readonly T[],
): { featured: T[]; rest: T[] } {
  const featured = list.filter((listing) => provenDelivery(listing) !== null)
  return { featured, rest: list.filter((listing) => provenDelivery(listing) === null) }
}

/** How often a tile leads the bento: the first, then every fifth. */
export const BENTO_EVERY = 5

/**
 * One of each kind in turn, each kind keeping its own order and the kinds in the order they first appear: so the
 * busiest agent's four code services do not stand side by side with four alike pictures.
 */
export function interleaveBy<T>(items: readonly T[], kindOf: (item: T) => string): T[] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const kind = kindOf(item)
    const group = groups.get(kind)
    if (group === undefined) groups.set(kind, [item])
    else group.push(item)
  }
  const queues = [...groups.values()]
  const out: T[] = []
  while (out.length < items.length) for (const queue of queues) if (queue.length > 0) out.push(queue.shift()!)
  return out
}

/** The wall's order: proven services take the lead places while they last, the rest fill between in their order. */
export function bentoOrder<T>(featured: readonly T[], rest: readonly T[]): T[] {
  const leads = [...featured]
  const others = [...rest]
  const out: T[] = []
  for (let i = 0; i < featured.length + rest.length; i++) {
    const next = i % BENTO_EVERY === 0 ? (leads.shift() ?? others.shift()) : (others.shift() ?? leads.shift())
    if (next !== undefined) out.push(next)
  }
  return out
}

export function coverOf(listing: Pick<ServiceListing, 'samples'>): ServiceSample | null {
  return (
    listing.samples?.find(
      (sample) =>
        sample.kind === 'illustration' || sample.kind === 'example' || (sample.kind === 'delivery' && sample.verified),
    ) ?? null
  )
}

/**
 * The picture a tile on the wall leads with: the agent's first illustration (made to show the service at its best),
 * else the cover as coverOf picks it. A delivery screenshot proves the service; the tile names that proof in words.
 */
export function tileCoverOf(listing: Pick<ServiceListing, 'samples'>): ServiceSample | null {
  return listing.samples?.find((sample) => sample.kind === 'illustration') ?? coverOf(listing)
}

export function sampleLabel(sample: ServiceSample): string {
  if (sample.kind === 'illustration') return 'Illustration'
  if (sample.kind === 'delivery' && sample.verified && sample.jobId !== undefined) return `Delivered #${sample.jobId}`
  return 'Example'
}
