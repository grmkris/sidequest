/**
 * The media library's view model (ADR-0029): what `/media`, an asset's page, a share and the team's library show, from
 * the `list_media` / `get_media` / `get_media_share` replies. Pure, so the pages only lay it out.
 */

type MediaLevel = 'internal' | 'public'
type MediaKind = 'video' | 'image' | 'audio' | 'document' | 'file'
type MediaRole = 'operator' | 'member'

export interface MediaFile {
  readonly name: string
  readonly role: 'main' | 'poster' | 'captions' | 'extra'
  readonly label?: string
  readonly bytes: number
  readonly type: string
  readonly sha256: string
  /** Null when this viewer may not open it (an internal file without a preview or share). */
  readonly url: string | null
}

interface MediaCaption {
  readonly where: string
  readonly text: string
  readonly note?: string
}

export interface MediaAsset {
  readonly id: string
  readonly level: MediaLevel
  readonly public: boolean
  readonly kind: MediaKind
  readonly title: string
  readonly description?: string
  readonly note?: string
  readonly section?: string
  readonly campaign?: string
  readonly batch?: string
  readonly picked: boolean
  readonly position: number
  readonly width?: number
  readonly height?: number
  readonly duration?: number
  readonly captions: readonly MediaCaption[]
  readonly createdAt: number
  readonly publishedAt?: number
  readonly revision: number
  readonly files: readonly MediaFile[]
}

export interface MediaGroup {
  readonly id: string
  readonly kind: 'section' | 'campaign'
  readonly title: string
  readonly note?: string
  readonly level: MediaLevel
  readonly position: number
  readonly featured: boolean
  readonly briefAsset?: string
  readonly startsOn?: string
  readonly endsOn?: string
  readonly status?: string
  readonly revision: number
}

export interface MediaPost {
  readonly id: string
  readonly campaign?: string
  readonly channel: string
  readonly account?: string
  readonly day?: string
  readonly time?: string
  readonly text: string
  readonly note?: string
  readonly assets: readonly string[]
  readonly status: 'draft' | 'approved' | 'posted' | 'skipped'
  readonly approvedBy?: string
  readonly url?: string
  readonly postedAt?: number
  readonly revision: number
}

export interface MediaLibrary {
  readonly viewer: { readonly role: MediaRole | null }
  readonly groups: readonly MediaGroup[]
  readonly assets: readonly MediaAsset[]
}

export interface Shelf {
  readonly id: string
  readonly title: string
  readonly note?: string
  readonly featured: boolean
  readonly assets: readonly MediaAsset[]
}

const newestFirst = (a: MediaAsset, b: MediaAsset) => a.position - b.position || b.createdAt - a.createdAt

/**
 * The public page's shelves: each section in its order with its assets, the featured one first, then what is public
 * without a section. Empty sections are left out.
 */
export function shelves(library: Pick<MediaLibrary, 'groups' | 'assets'>): Shelf[] {
  const sections = library.groups
    .filter((group) => group.kind === 'section')
    .toSorted((a, b) => Number(b.featured) - Number(a.featured) || a.position - b.position)
  const known = new Set(sections.map((section) => section.id))
  const shelved = sections.map((section) => ({
    id: section.id,
    title: section.title,
    ...(section.note === undefined ? {} : { note: section.note }),
    featured: section.featured,
    assets: library.assets.filter((asset) => asset.section === section.id).toSorted(newestFirst),
  }))
  const loose = library.assets.filter((asset) => asset.section === undefined || !known.has(asset.section))
  return [
    ...shelved,
    ...(loose.length === 0
      ? []
      : [{ id: 'more', title: 'More', featured: false, assets: loose.toSorted(newestFirst) }]),
  ].filter((shelf) => shelf.assets.length > 0)
}

export const mainFile = (asset: Pick<MediaAsset, 'files'>): MediaFile | undefined =>
  asset.files.find((file) => file.role === 'main')
export const posterOf = (asset: Pick<MediaAsset, 'files'>): MediaFile | undefined =>
  asset.files.find((file) => file.role === 'poster')
/** The WebVTT captions a player can show; other caption files are downloads. */
export const captionTrack = (asset: Pick<MediaAsset, 'files'>): MediaFile | undefined =>
  asset.files.find((file) => file.role === 'captions' && file.type === 'text/vtt')

/** What the page offers to download: the main file first, then every extra, each named. */
export function downloads(asset: Pick<MediaAsset, 'files'>): { label: string; file: MediaFile }[] {
  return asset.files
    .filter((file) => file.role === 'main' || file.role === 'extra' || file.role === 'captions')
    .filter((file) => file.url !== null)
    .map((file) => ({ label: file.role === 'main' ? 'Download' : (file.label ?? file.name), file }))
}

/** A link to the file that downloads instead of opening. */
export const downloadUrl = (url: string): string => `${url}${url.includes('?') ? '&' : '?'}dl=1`

/** The frame a picture or film sits in, from its pixels. */
export function shapeOf(asset: Pick<MediaAsset, 'width' | 'height'>): 'vertical' | 'square' | 'landscape' {
  if (asset.width === undefined || asset.height === undefined || asset.height === 0) return 'landscape'
  const ratio = asset.width / asset.height
  if (ratio < 0.85) return 'vertical'
  return ratio > 1.15 ? 'landscape' : 'square'
}

export function sizeText(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1000))} kB`
}

export function durationText(seconds: number): string {
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

const CHANNELS: Readonly<Record<string, string>> = {
  x: 'X',
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  threads: 'Threads',
  bluesky: 'Bluesky',
  farcaster: 'Farcaster',
  facebook: 'Facebook',
  reddit: 'Reddit',
  telegram: 'Telegram',
  discord: 'Discord',
  hackernews: 'Hacker News',
  producthunt: 'Product Hunt',
  web: 'Web',
}
export const channelName = (channel: string): string => CHANNELS[channel] ?? channel

/** The posts that went out with this asset, newest first, for "Posted on". */
export const postedWith = (posts: readonly MediaPost[]) =>
  posts
    .filter((post) => post.status === 'posted' && post.url !== undefined)
    .toSorted((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0))

/** The library grouped for the team: each campaign's assets, its batches' variants side by side, then the rest. */
export function campaignsOf(library: Pick<MediaLibrary, 'groups' | 'assets'>) {
  const campaigns = library.groups.filter((group) => group.kind === 'campaign')
  const known = new Set(campaigns.map((campaign) => campaign.id))
  const grouped = campaigns.map((campaign) => ({
    campaign,
    batches: batchesOf(library.assets.filter((asset) => asset.campaign === campaign.id)),
  }))
  const rest = library.assets.filter((asset) => asset.campaign === undefined || !known.has(asset.campaign))
  return { grouped: grouped.filter((entry) => entry.batches.length > 0), rest: rest.toSorted(newestFirst) }
}

/** Assets in batches (a batch's variants together, the picked one first), unbatched ones each on their own. */
export function batchesOf(assets: readonly MediaAsset[]): { batch: string | undefined; assets: MediaAsset[] }[] {
  const byBatch = new Map<string, MediaAsset[]>()
  const single: { batch: undefined; assets: MediaAsset[] }[] = []
  for (const asset of assets.toSorted(newestFirst)) {
    if (asset.batch === undefined) single.push({ batch: undefined, assets: [asset] })
    else byBatch.set(asset.batch, [...(byBatch.get(asset.batch) ?? []), asset])
  }
  return [
    ...[...byBatch.entries()].map(([batch, variants]) => ({
      batch,
      assets: variants.toSorted((a, b) => Number(b.picked) - Number(a.picked)),
    })),
    ...single,
  ]
}

/** A fresh operationKey for one write from this page; a retry of the same click reuses it. */
export const newOperationKey = (): string => `explore-${crypto.randomUUID()}`

/** How long a post may be where it goes, in characters (YouTube: a description). */
export const CHANNEL_LIMITS: Readonly<Record<string, number>> = {
  x: 280,
  linkedin: 3000,
  instagram: 2200,
  tiktok: 2200,
  youtube: 5000,
  threads: 500,
  bluesky: 300,
  farcaster: 320,
  facebook: 63_206,
  reddit: 40_000,
  telegram: 4096,
  discord: 2000,
}

/** The channels a planned post can go to, in the order the planner offers them. */
export const PLAN_CHANNELS = [
  'x',
  'instagram',
  'tiktok',
  'youtube',
  'linkedin',
  'threads',
  'bluesky',
  'farcaster',
] as const

/**
 * What to fix before a post goes out: text over the channel's limit, a TikTok without a video, a vertical channel
 * given a wide film, files not public yet (approving publishes them only when asked).
 */
export function postChecks(
  post: Pick<MediaPost, 'channel' | 'text' | 'assets'>,
  assets: readonly MediaAsset[],
): string[] {
  const used = assets.filter((asset) => post.assets.includes(asset.id))
  const limit = CHANNEL_LIMITS[post.channel]
  const checks: string[] = []
  if (limit !== undefined && post.text.length > limit)
    checks.push(`${post.text.length - limit} characters over ${channelName(post.channel)}'s ${limit}`)
  const videos = used.filter((asset) => asset.kind === 'video')
  if (post.channel === 'tiktok' && videos.length === 0) checks.push('TikTok needs a video')
  if (['tiktok', 'instagram'].includes(post.channel) && videos.some((asset) => shapeOf(asset) === 'landscape'))
    checks.push(`${channelName(post.channel)} shows a wide film small; a 9:16 cut fits it`)
  const internal = used.filter((asset) => !asset.public)
  if (internal.length > 0) checks.push(`Not public yet: ${internal.map((asset) => asset.title).join(', ')}`)
  return checks
}

const isoDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const addDays = (day: string, days: number) => {
  const date = new Date(`${day}T12:00:00`)
  date.setDate(date.getDate() + days)
  return isoDay(date)
}
export const todayOf = (now = new Date()): string => isoDay(now)

/** A planned day as people say it: Today, Tomorrow, Yesterday, else the weekday and date. */
export function planDayLabel(day: string, today: string): string {
  if (day === today) return 'Today'
  if (day === addDays(today, 1)) return 'Tomorrow'
  if (day === addDays(today, -1)) return 'Yesterday'
  return new Date(`${day}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

/**
 * The plan by day: the last week and everything ahead in order, each day's posts by time, then the posts with no day.
 * Older days are history and stay out.
 */
export function planDays(
  posts: readonly MediaPost[],
  today: string,
): { day: string | null; label: string; posts: MediaPost[] }[] {
  const from = addDays(today, -7)
  const byDay = new Map<string, MediaPost[]>()
  const undated: MediaPost[] = []
  for (const post of posts) {
    if (post.day === undefined) undated.push(post)
    else if (post.day >= from) byDay.set(post.day, [...(byDay.get(post.day) ?? []), post])
  }
  const byTime = (a: MediaPost, b: MediaPost) => (a.time ?? '').localeCompare(b.time ?? '')
  return [
    ...[...byDay.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([day, list]) => ({ day, label: planDayLabel(day, today), posts: list.toSorted(byTime) })),
    ...(undated.length === 0 ? [] : [{ day: null, label: 'No day yet', posts: undated }]),
  ]
}
