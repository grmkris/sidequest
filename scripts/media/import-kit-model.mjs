/**
 * ADR-0029 cutover: the media kit's manifest as the media tools' calls, in the order they must run. Pure, so the dry
 * run and the tests see exactly what the import does. Every call carries a deterministic operationKey, so a rerun
 * after any failure answers the calls that already ran and does the rest.
 */

const KIT = 'https://media.sidequest.exchange'
/** Not Sidequest: archived, not imported. */
const SKIPPED_GROUPS = new Set(['cats-mjav'])
/** The kit's public briefs, which become document assets in their own section. */
const BRIEFS = ['sidequest-style.md', 'launch-week.md', 'since-launch.md', 'promo-we-didnt-make-this.md']
const MAKERS_SECTION = 'for-makers'
/** The hidden kit material a brief links to: internal here, handed out by one share. */
const SHARED_GROUP = 'film-material'

const RESERVED = new Set(['f', 's', 'internal', 'new', 'upload'])
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const clip = (text, max) => (text === undefined || text === null ? undefined : String(text).slice(0, max))
const nameOf = (key) => key.slice(key.lastIndexOf('/') + 1)
const sha8 = (file) => file.sha256.slice(0, 8)
const defined = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))

/** A file of the kit as an add_media file, pulled from the kit by its URL and checked against its sha256. */
function fileOf(file, role, label) {
  return defined({
    name: nameOf(file.key),
    role,
    label: clip(label, 80),
    sha256: file.sha256,
    sourceUrl: `${KIT}/f/${file.key}`,
    // The kit kept parameters (`text/vtt; charset=utf-8`); a media file's type is the bare one.
    type: file.type.split(';')[0].trim().toLowerCase(),
  })
}

const isCaptions = (extra) => /caption|subtitle/i.test(extra.label ?? '') && /vtt|srt/.test(extra.type + extra.key)

/** The kit's posting copy without a day still to come: suggested captions on the asset. */
const captionsOf = (asset, today) =>
  (asset.posting ?? [])
    .filter((entry) => entry.day === undefined || entry.day < today)
    .slice(0, 12)
    .map((entry) =>
      defined({ where: clip(entry.where, 80), text: clip(entry.text, 4000), note: clip(entry.note, 500) }),
    )

/** A slug the media tools accept for a kit id, or undefined when it needs a new one. */
export const acceptedId = (id) => (SLUG.test(id) && !RESERVED.has(id) ? id : undefined)

function sectionCalls(manifest, groups) {
  const shownFirst = groups.find((group) => !group.hidden && manifest.assets.some((asset) => asset.group === group.id))
  return [
    ...groups.map((group, position) => ({
      tool: 'save_media_group',
      key: `kit-import:group:${group.id}`,
      args: defined({
        id: group.id,
        kind: 'section',
        title: clip(group.title, 120),
        note: clip(group.note, 500),
        level: group.hidden ? 'internal' : 'public',
        position,
        featured: group.id === shownFirst?.id,
      }),
    })),
    {
      tool: 'save_media_group',
      key: `kit-import:group:${MAKERS_SECTION}`,
      args: {
        id: MAKERS_SECTION,
        kind: 'section',
        title: 'For makers',
        note: 'The house style and the briefs for people and agents who make Sidequest media.',
        level: 'public',
        position: groups.length,
      },
    },
  ]
}

function assetCall(asset, group, position, today) {
  const files = [
    fileOf(asset.file, 'main'),
    ...(asset.poster === undefined ? [] : [fileOf(asset.poster, 'poster')]),
    ...(asset.extras ?? []).map((extra) => fileOf(extra, isCaptions(extra) ? 'captions' : 'extra', extra.label)),
  ]
  const document = asset.kind === 'file' && /markdown|text\/plain/.test(asset.file.type)
  return {
    tool: 'add_media',
    key: `kit-import:asset:${asset.id}:${sha8(asset.file)}`,
    args: defined({
      id: asset.id,
      title: clip(asset.title, 160),
      kind: document ? 'document' : asset.kind,
      description: clip(asset.description, 2000),
      note: clip(asset.note, 500),
      section: group.id,
      position,
      width: asset.width,
      height: asset.height,
      duration: asset.duration,
      captions: captionsOf(asset, today),
      files,
    }),
  }
}

/** A section's assets, newest first as the kit showed them, each published when the kit showed it. */
function assetCalls(group, assets, today, skipped) {
  const own = assets
    .filter((asset) => asset.group === group.id)
    .toSorted((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
  return own.flatMap((asset, position) => {
    if (acceptedId(asset.id) === undefined) {
      skipped.push(asset.id)
      return []
    }
    const publish = !group.hidden && !asset.hidden
    return [
      assetCall(asset, group, position, today),
      ...(publish
        ? [{ tool: 'publish_media', key: `kit-import:publish:${asset.id}`, args: { id: asset.id, public: true } }]
        : []),
    ]
  })
}

function briefCalls() {
  return BRIEFS.flatMap((brief, position) => {
    const id = `brief-${brief.replace(/\.md$/, '')}`
    return [
      {
        tool: 'add_media',
        key: `kit-import:brief:${id}`,
        args: {
          id,
          title: brief.replace(/\.md$/, '').replaceAll('-', ' '),
          kind: 'document',
          section: MAKERS_SECTION,
          position,
          files: [{ name: brief, role: 'main', sourceUrl: `${KIT}/f/briefs/${brief}`, type: 'text/markdown' }],
        },
        brief,
      },
      { tool: 'publish_media', key: `kit-import:publish:${id}`, args: { id, public: true } },
    ]
  })
}

/** Posting copy with a day still to come: approved posts on that day. */
const planCalls = (assets, today) =>
  assets.flatMap((asset) =>
    (asset.posting ?? [])
      .filter((entry) => entry.day !== undefined && entry.day >= today && acceptedId(asset.id) !== undefined)
      .map((entry) => ({
        tool: 'save_media_post',
        key: `kit-import:plan:${asset.id}:${entry.day}:${entry.where}`,
        args: defined({
          channel: channelOfWhere(entry.where),
          day: entry.day,
          text: clip(entry.text, 10_000),
          note: clip(entry.note, 500),
          assets: [asset.id],
          status: 'approved',
        }),
      })),
  )

const postCalls = (manifest, assets) =>
  (manifest.posts ?? []).map((post) => ({
    tool: 'record_media_post',
    key: `kit-import:post:${post.id}`,
    args: defined({
      url: post.url,
      postedAt: post.postedAt === undefined ? undefined : Math.floor(Date.parse(post.postedAt) / 1000),
      account: clip(post.account, 80),
      text: clip(post.caption, 10_000),
      assets: post.assets.filter((id) => acceptedId(id) !== undefined && assets.some((asset) => asset.id === id)),
    }),
  }))

function shareCalls(assets) {
  const shared = assets.filter((asset) => asset.group === SHARED_GROUP).map((asset) => asset.id)
  if (shared.length === 0) return []
  return [
    {
      tool: 'share_media',
      key: 'kit-import:share:film-material',
      args: { assets: shared, label: 'Film material (since-launch film)', days: 90 },
    },
  ]
}

/**
 * The import's calls. `today` (YYYY-MM-DD) splits posting copy into captions (past or undated) and approved posts
 * (still to come). Hidden groups and assets become internal; what the kit showed becomes public. The film-material
 * share comes before the briefs, so the since-launch brief can point at it.
 */
export function planImport(manifest, today) {
  const groups = manifest.groups.filter((group) => !SKIPPED_GROUPS.has(group.id))
  const groupIds = new Set(groups.map((group) => group.id))
  const assets = manifest.assets.filter((asset) => groupIds.has(asset.group))
  const skipped = []
  const calls = [
    ...sectionCalls(manifest, groups),
    ...groups.flatMap((group) => assetCalls(group, assets, today, skipped)),
    ...shareCalls(assets),
    ...briefCalls(),
    ...planCalls(assets, today),
    ...postCalls(manifest, assets),
  ]
  return {
    calls,
    skipped,
    archived: manifest.groups.filter((group) => SKIPPED_GROUPS.has(group.id)).map((group) => group.id),
  }
}

const WHERE = [
  [/tiktok/i, 'tiktok'],
  [/instagram|reels/i, 'instagram'],
  [/youtube|shorts/i, 'youtube'],
  [/linkedin/i, 'linkedin'],
  [/threads/i, 'threads'],
  [/bluesky/i, 'bluesky'],
  [/farcaster|warpcast/i, 'farcaster'],
  [/\bx\b|twitter/i, 'x'],
]
/** The kit's free "where" ("TikTok · Reels · Shorts") as one planner channel: the first it names. */
export const channelOfWhere = (where) => WHERE.find(([pattern]) => pattern.test(where))?.[1] ?? 'web'

/** A brief's text with its kit links to film material pointed at the share instead. */
export function rewriteBrief(text, shareUrl) {
  return text.replace(
    /https:\/\/media\.sidequest\.exchange\/f\/(since-launch-live|redesign-before-after-stills|redesign-before-after-footage|sidequest-score)\/[^\s)>]+/g,
    shareUrl,
  )
}
