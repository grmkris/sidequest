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

export function coverOf(listing: Pick<ServiceListing, 'samples'>): ServiceSample | null {
  return (
    listing.samples?.find(
      (sample) =>
        sample.kind === 'illustration' || sample.kind === 'example' || (sample.kind === 'delivery' && sample.verified),
    ) ?? null
  )
}

export function sampleLabel(sample: ServiceSample): string {
  if (sample.kind === 'illustration') return 'Illustration'
  if (sample.kind === 'delivery' && sample.verified && sample.jobId !== undefined) return `Delivered #${sample.jobId}`
  return 'Example'
}
