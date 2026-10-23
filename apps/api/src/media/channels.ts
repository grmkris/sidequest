/** Where Sidequest posts, read from a post's public URL the way the media kit did; one record per cleaned URL. */
const PLATFORMS: readonly (readonly [RegExp, string])[] = [
  [/(^|\.)(x|twitter)\.com$/, 'x'],
  [/(^|\.)linkedin\.com$/, 'linkedin'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
  [/(^|\.)threads\.(net|com)$/, 'threads'],
  [/(^|\.)bsky\.app$/, 'bluesky'],
  [/(^|\.)(warpcast\.com|farcaster\.xyz)$/, 'farcaster'],
  [/(^|\.)facebook\.com$/, 'facebook'],
  [/(^|\.)reddit\.com$/, 'reddit'],
  [/(^|\.)(t\.me|telegram\.org)$/, 'telegram'],
  [/(^|\.)(discord\.com|discord\.gg)$/, 'discord'],
  [/(^|\.)news\.ycombinator\.com$/, 'hackernews'],
  [/(^|\.)producthunt\.com$/, 'producthunt'],
]

export const MEDIA_CHANNELS = [...PLATFORMS.map(([, id]) => id), 'web'] as const

export const channelOf = (url: string): string => {
  const host = new URL(url).hostname.toLowerCase()
  return PLATFORMS.find(([pattern]) => pattern.test(host))?.[1] ?? 'web'
}

const TRACKING = /^(utm_.*|fbclid|gclid|igsh|igshid|si|ref_src|ref_url)$/

/** A post's URL without tracking parameters (and X's share-sheet `s`/`t`), so a re-shared link is the same post. */
export function cleanPostUrl(raw: string): string {
  const url = new URL(raw)
  const x = channelOf(raw) === 'x'
  for (const key of Array.from(url.searchParams.keys()))
    if (TRACKING.test(key) || (x && (key === 's' || key === 't'))) url.searchParams.delete(key)
  url.hash = ''
  return url.toString()
}
