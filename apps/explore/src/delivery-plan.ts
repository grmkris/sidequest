/**
 * What a delivery's preview shows, best first: the landing showcase's vendored image of a curated job; the poster the
 * delivered site publishes (its `deliverable.json`, else its og:image); an image file itself; a 3D model, turned in
 * the card; else a glyph for its kind. No delivered page is ever framed, and audio and video never play here: their
 * poster opens the delivery.
 */
import type { Deliverable } from './api.ts'
import { SHOWCASE, type ShowcaseItem, showcaseJob } from './components/landing/showcase-data.ts'
import type { DeliverablePreview, PreviewType } from './delivery-preview.ts'
import { deliveryHref, httpUrl } from './delivery.ts'

export interface ModelRef {
  src: string
  format: 'gltf' | 'stl'
  name: string
}

export type PreviewPlan =
  | { from: 'showcase'; item: ShowcaseItem; href: string | null }
  | { from: 'poster'; src: string; type: PreviewType | null; href: string | null; model: ModelRef | null }
  | { from: 'image'; src: string; href: string | null }
  | { from: 'model'; model: ModelRef; href: string | null }
  | { from: 'glyph'; kind: Deliverable['kind'] | null; media: 'video' | 'audio' | null; href: string | null }

const MODEL_TYPES: Readonly<Record<string, ModelRef['format']>> = {
  'model/gltf-binary': 'gltf',
  'model/gltf+json': 'gltf',
  'model/stl': 'stl',
  'model/x.stl-binary': 'stl',
  'model/x.stl-ascii': 'stl',
  'application/sla': 'stl',
}

/** A model's format, by its media type, else by the file name or the URL's path. */
export function modelFormat(name: string, mediaType = ''): ModelRef['format'] | null {
  const typed = MODEL_TYPES[mediaType.toLowerCase().split(';')[0]?.trim() ?? '']
  if (typed !== undefined) return typed
  let path = name
  try {
    path = new URL(name).pathname
  } catch {
    // a plain file name
  }
  const ext = /\.(glb|gltf|stl)$/i.exec(path)?.[1]?.toLowerCase()
  return ext === undefined ? null : ext === 'stl' ? 'stl' : 'gltf'
}

const isHttps = (url: string) => url.startsWith('https://')

const fileName = (url: string) => {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '') || url
  } catch {
    return url
  }
}

/** A delivered site's main file, when it is a model the card can turn. */
function siteModel(media: string | null): ModelRef | null {
  if (media === null || !isHttps(media)) return null
  const format = modelFormat(media)
  return format === null ? null : { src: media, format, name: fileName(media) }
}

function mediaOf(d: Deliverable | null, type: PreviewType | null): 'video' | 'audio' | null {
  if (type === 'video' || type === 'audio') return type
  if (d?.kind !== 'artifact') return null
  if (d.mediaType.startsWith('video/')) return 'video'
  return d.mediaType.startsWith('audio/') ? 'audio' : null
}

/** An artifact shown as itself: an image file, or a model the card can turn. */
function artifactPlan(d: Deliverable, href: string | null): PreviewPlan | null {
  if (d.kind !== 'artifact') return null
  const src = httpUrl(d.url)
  if (!isHttps(src)) return null
  if (d.mediaType.startsWith('image/')) return { from: 'image', src, href }
  const format = modelFormat(d.name, d.mediaType)
  return format === null ? null : { from: 'model', model: { src, format, name: d.name }, href }
}

export function previewPlan(input: {
  jobId: string | null
  stage: string
  deliverable: Deliverable | null
  preview: DeliverablePreview | null
}): PreviewPlan {
  const { deliverable: d, preview } = input
  const href = d === null ? null : deliveryHref(d)
  const curated =
    input.jobId === null
      ? undefined
      : SHOWCASE.find((s) => {
          const job = showcaseJob(s, input.stage)
          return job.origin === null && job.jobId === input.jobId
        })
  // A curated delivery that carries a model keeps its own poster, so the model can still be turned.
  const model = siteModel(preview?.media ?? null)
  if (curated !== undefined && model === null)
    return { from: 'showcase', item: curated, href: href ?? curated.delivered.url }
  if (preview?.poster != null && isHttps(preview.poster))
    return { from: 'poster', src: preview.poster, type: preview.type, href, model }
  const shown = d === null ? null : artifactPlan(d, href)
  if (shown !== null) return shown
  return { from: 'glyph', kind: d?.kind ?? null, media: mediaOf(d, preview?.type ?? null), href }
}

const MEDIA_KINDS: ReadonlySet<string> = new Set(['video', 'documentary', 'podcast'])

export type Thumb = { showcase: ShowcaseItem; media: boolean } | { src: string; media: boolean }

/** The row's small picture: the curated image, the poster or the image file; nothing for a model or a glyph. */
export function thumbOf(plan: PreviewPlan): Thumb | null {
  switch (plan.from) {
    case 'showcase':
      return { showcase: plan.item, media: MEDIA_KINDS.has(plan.item.kind) }
    case 'poster':
      return { src: plan.src, media: plan.type === 'video' || plan.type === 'audio' }
    case 'image':
      return { src: plan.src, media: false }
    case 'model':
    case 'glyph':
      return null
  }
}
