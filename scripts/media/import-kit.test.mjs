import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acceptedId, channelOfWhere, planImport, rewriteBrief } from './import-kit-model.mjs'

const file = (key, sha = 'a'.repeat(64), type = 'video/mp4') => ({ key, bytes: 10, type, sha256: sha })
const manifest = {
  groups: [
    { id: 'launch', title: 'Launch', note: 'The launch films.' },
    { id: 'memes-drafts', title: 'Drafts', hidden: true },
    { id: 'cats-mjav', title: 'Not Sidequest', hidden: true },
    { id: 'film-material', title: 'Film material', hidden: true },
  ],
  assets: [
    {
      id: 'launch-75s',
      group: 'launch',
      kind: 'video',
      title: 'Launch 75s',
      createdAt: '2026-10-13T00:00:00Z',
      file: file('launch-75s/launch.mp4', 'b'.repeat(64)),
      poster: file('launch-75s/poster.jpg', 'c'.repeat(64), 'image/jpeg'),
      extras: [
        { ...file('launch-75s/captions.vtt', 'd'.repeat(64), 'text/vtt; charset=utf-8'), label: 'Captions (VTT)' },
        { ...file('launch-75s/source.zip', 'e'.repeat(64), 'application/zip'), label: 'Source zip' },
      ],
      posting: [
        { where: 'X', text: 'Old copy', day: '2026-10-14' },
        { where: 'TikTok · Reels · Shorts', text: 'Coming copy', day: '2026-10-30' },
        { where: 'LinkedIn', text: 'Any day' },
      ],
    },
    {
      id: 'launch-40s',
      group: 'launch',
      kind: 'video',
      title: 'Launch 40s',
      createdAt: '2026-10-14T00:00:00Z',
      file: file('launch-40s/a.mp4'),
    },
    { id: 'draft-1', group: 'memes-drafts', kind: 'video', title: 'Draft', file: file('draft-1/a.mp4') },
    { id: 'cat-1', group: 'cats-mjav', kind: 'video', title: 'Cat', file: file('cat-1/a.mp4') },
    {
      id: 'since-launch-live',
      group: 'film-material',
      kind: 'file',
      title: 'Captures',
      file: file('since-launch-live/a.zip', 'f'.repeat(64), 'application/zip'),
    },
    { id: 'Bad_ID', group: 'launch', kind: 'image', title: 'Bad', file: file('Bad_ID/a.png') },
  ],
  posts: [
    {
      id: 'p_1',
      url: 'https://www.instagram.com/reel/x/',
      assets: ['launch-40s', 'cat-1'],
      account: '@sidequest.exchange',
      postedAt: '2026-10-14T08:56:28.044Z',
      caption: 'Out',
    },
  ],
}

void test('maps the kit to the media tools in order: sections, assets and their levels, the share, briefs, plans, posts', () => {
  const { calls, skipped, archived } = planImport(manifest, '2026-10-24')
  assert.deepEqual(archived, ['cats-mjav'])
  assert.deepEqual(skipped, ['Bad_ID'])
  assert.deepEqual(
    calls
      .filter((call) => call.tool === 'save_media_group')
      .map((call) => [call.args.id, call.args.level, call.args.featured]),
    [
      ['launch', 'public', true],
      ['memes-drafts', 'internal', false],
      ['film-material', 'internal', false],
      ['for-makers', 'public', undefined],
    ],
  )
})

void test('carries each kit file with its role and source, posting copy as captions, and only shown assets published', () => {
  const { calls } = planImport(manifest, '2026-10-24')
  const adds = calls.filter((call) => call.tool === 'add_media')
  // Newest first within a section, as the kit's page showed them.
  assert.deepEqual(
    adds.slice(0, 2).map((call) => [call.args.id, call.args.position]),
    [
      ['launch-40s', 0],
      ['launch-75s', 1],
    ],
  )
  const launch = adds.find((call) => call.args.id === 'launch-75s')
  assert.deepEqual(
    launch.args.files.map((f) => [f.name, f.role, f.sourceUrl]),
    [
      ['launch.mp4', 'main', 'https://media.sidequest.exchange/f/launch-75s/launch.mp4'],
      ['poster.jpg', 'poster', 'https://media.sidequest.exchange/f/launch-75s/poster.jpg'],
      ['captions.vtt', 'captions', 'https://media.sidequest.exchange/f/launch-75s/captions.vtt'],
      ['source.zip', 'extra', 'https://media.sidequest.exchange/f/launch-75s/source.zip'],
    ],
  )
  assert.deepEqual(
    launch.args.captions.map((c) => c.where),
    ['X', 'LinkedIn'],
  )
  assert.equal(launch.key, `kit-import:asset:launch-75s:${'b'.repeat(8)}`)
  const published = calls.filter((call) => call.tool === 'publish_media').map((call) => call.args.id)
  assert.ok(
    published.includes('launch-75s') && !published.includes('draft-1') && !published.includes('since-launch-live'),
  )
  assert.ok(!adds.some((call) => call.args.id === 'cat-1'))
})

void test('shares the film material before the briefs, plans the posting still to come, and records the kit posts', () => {
  const { calls } = planImport(manifest, '2026-10-24')
  const tools = calls.map((call) => call.tool)
  assert.ok(
    tools.indexOf('share_media') < tools.findIndex((tool, i) => tool === 'add_media' && calls[i].brief !== undefined),
  )
  assert.deepEqual(calls.find((call) => call.tool === 'share_media').args.assets, ['since-launch-live'])
  const planned = calls.filter((call) => call.tool === 'save_media_post')
  assert.deepEqual(
    planned.map((call) => [call.args.channel, call.args.day, call.args.status]),
    [['tiktok', '2026-10-30', 'approved']],
  )
  const post = calls.find((call) => call.tool === 'record_media_post')
  assert.deepEqual(post.args.assets, ['launch-40s'])
  assert.equal(post.args.postedAt, 1_791_968_188)
})

void test('keeps a kit id the media tools accept, reads a channel from the kit wording, and points a brief at the share', () => {
  assert.equal(acceptedId('launch-75s'), 'launch-75s')
  assert.equal(acceptedId('internal'), undefined)
  assert.equal(acceptedId('Bad_ID'), undefined)
  assert.deepEqual(
    ['X', 'TikTok · Reels · Shorts', 'Instagram Reels', 'YouTube Shorts', 'Somewhere'].map(channelOfWhere),
    ['x', 'tiktok', 'instagram', 'youtube', 'web'],
  )
  const brief =
    'Get <https://media.sidequest.exchange/f/since-launch-live/since-launch-live.zip?dl=1> and https://media.sidequest.exchange/f/mark-svg/mark.svg'
  assert.equal(
    rewriteBrief(brief, 'https://sidequest.exchange/media/s/abc'),
    'Get <https://sidequest.exchange/media/s/abc> and https://media.sidequest.exchange/f/mark-svg/mark.svg',
  )
})
