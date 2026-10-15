import { SERVICE_CATEGORIES, type ServiceAdvertisement, type ServiceSample } from '@sidequest/sdk'
import { DirectoryError } from './directory-error.ts'

const invalid = (message: string): never => {
  throw new DirectoryError('invalid', message)
}
const isString = (value: unknown): value is string => typeof value === 'string'
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function plaintext(value: unknown, label: string, max: number, tag = false): string {
  if (!isString(value) || value.trim().length === 0 || value.length > max)
    return invalid(`${label} must be bounded plaintext`)
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (tag && (code < 32 || (code >= 127 && code <= 159))) return invalid('tags must have no control characters')
    if (code < 32 && !['\n', '\r', '\t'].includes(character)) return invalid(`${label} must be bounded plaintext`)
  }
  return value
}

function texts(value: unknown, label: string, count: number, max: number): string[] {
  if (!Array.isArray(value) || value.length > count) return invalid(`${label} must have at most ${count} entries`)
  return value.map((entry) => plaintext(entry, label, max, label === 'tags'))
}

function sample(value: unknown, urlPattern: RegExp, maxUrl: number): ServiceSample {
  if (!isObject(value)) return invalid('expected a sample object')
  if (Object.keys(value).some((key) => !['url', 'caption', 'kind', 'jobId'].includes(key)))
    return invalid('unknown directory field')
  const url = plaintext(value.url, 'sample url', maxUrl)
  if (!urlPattern.test(url))
    return invalid('sample url must be on this audience under /samples/<sha256>.(png|jpg|webp)')
  const common = { url, caption: plaintext(value.caption, 'caption', 120) }
  if (value.kind === 'delivery') {
    const jobId = plaintext(value.jobId, 'jobId', 32768)
    if (!/^\d+$/u.test(jobId)) return invalid('delivery samples require a decimal jobId')
    return { ...common, kind: 'delivery', jobId }
  }
  if (value.kind !== 'illustration' && value.kind !== 'example') return invalid('unknown sample kind')
  if ('jobId' in value) return invalid('jobId is only allowed on delivery samples')
  return { ...common, kind: value.kind }
}

function samples(value: unknown, audience: string): ServiceSample[] {
  if (!Array.isArray(value) || value.length > 6) return invalid('samples must have at most six entries')
  const escaped = audience.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^${escaped}/samples/[0-9a-f]{64}\\.(png|jpg|webp)$`, 'u')
  return value.map((entry) => sample(entry, pattern, audience.length + 80))
}

export function validateCardFields(
  ad: Record<string, unknown>,
  audience: string,
): Pick<ServiceAdvertisement, 'category' | 'tags' | 'examples' | 'samples'> {
  const category = SERVICE_CATEGORIES.find((entry) => entry === ad.category)
  if (ad.category !== undefined && category === undefined) return invalid('unknown service category')
  return {
    ...(category === undefined ? {} : { category }),
    ...(ad.tags === undefined ? {} : { tags: texts(ad.tags, 'tags', 6, 32) }),
    ...(ad.examples === undefined ? {} : { examples: texts(ad.examples, 'examples', 3, 200) }),
    ...(ad.samples === undefined ? {} : { samples: samples(ad.samples, audience) }),
  }
}
