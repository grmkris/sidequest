import { describe, expect, it } from 'vitest'
import {
  batchesOf,
  campaignsOf,
  channelName,
  downloads,
  downloadUrl,
  durationText,
  type MediaAsset,
  type MediaFile,
  type MediaGroup,
  postedWith,
  shapeOf,
  shelves,
  sizeText,
} from './media.ts'

const file = (
  name: string,
  role: MediaFile['role'],
  url: string | null = `https://x/media/f/a/${name}?v=1`,
): MediaFile => ({
  name,
  role,
  bytes: 1_500_000,
  type: name.endsWith('.vtt') ? 'text/vtt' : 'video/mp4',
  sha256: '0'.repeat(64),
  url,
})
const asset = (id: string, extra: Partial<MediaAsset> = {}): MediaAsset => ({
  id,
  level: 'public',
  public: true,
  kind: 'video',
  title: id,
  picked: false,
  position: 0,
  captions: [],
  createdAt: 100,
  revision: 1,
  files: [file(`${id}.mp4`, 'main')],
  ...extra,
})
const group = (id: string, extra: Partial<MediaGroup> = {}): MediaGroup => ({
  id,
  kind: 'section',
  title: id,
  level: 'public',
  position: 0,
  featured: false,
  revision: 1,
  ...extra,
})

const post = (id: string, status: 'posted' | 'draft', postedAt?: number) => ({
  id,
  channel: 'x',
  text: '',
  assets: [],
  status,
  revision: 1,
  ...(status === 'posted' ? { url: `https://x.com/s/${id}` } : {}),
  ...(postedAt === undefined ? {} : { postedAt }),
})

describe('the public shelves', () => {
  it('puts the featured section first, then the rest in order, then what has no section; empty ones go', () => {
    const groups = [
      group('promos', { position: 2 }),
      group('launch', { position: 1, featured: true }),
      group('empty', { position: 0 }),
    ]
    const assets = [
      asset('a', { section: 'promos', createdAt: 1 }),
      asset('b', { section: 'promos', createdAt: 2 }),
      asset('c', { section: 'launch' }),
      asset('d'),
      asset('e', { section: 'gone' }),
    ]
    expect(shelves({ groups, assets }).map((shelf) => [shelf.id, shelf.assets.map((x) => x.id)])).toEqual([
      ['launch', ['c']],
      ['promos', ['b', 'a']],
      ['more', ['d', 'e']],
    ])
  })
  it('orders a shelf by position, then newest first', () => {
    const assets = [
      asset('old', { section: 's', createdAt: 1 }),
      asset('new', { section: 's', createdAt: 9 }),
      asset('first', { section: 's', position: -1 }),
    ]
    expect(shelves({ groups: [group('s')], assets })[0]!.assets.map((x) => x.id)).toEqual(['first', 'new', 'old'])
  })
})

describe('files and facts', () => {
  it('offers the main file first, then extras and captions, and nothing this viewer cannot open', () => {
    const shown = asset('a', {
      files: [
        file('poster.jpg', 'poster'),
        file('a.mp4', 'main'),
        file('source.zip', 'extra'),
        file('a.vtt', 'captions'),
        file('secret.zip', 'extra', null),
      ],
    })
    expect(downloads(shown).map((entry) => entry.label)).toEqual(['Download', 'source.zip', 'a.vtt'])
    expect(downloadUrl('https://x/f?v=1')).toBe('https://x/f?v=1&dl=1')
    expect(downloadUrl('https://x/f')).toBe('https://x/f?dl=1')
  })
  it('reads a shape from the pixels, and sizes and lengths as people say them', () => {
    expect(shapeOf({ width: 1080, height: 1920 })).toBe('vertical')
    expect(shapeOf({ width: 1080, height: 1080 })).toBe('square')
    expect(shapeOf({ width: 1920, height: 1080 })).toBe('landscape')
    expect(shapeOf({})).toBe('landscape')
    expect([sizeText(999), sizeText(20_451_770), sizeText(1_440_000_000)]).toEqual(['1 kB', '20.5 MB', '1.4 GB'])
    expect([durationText(75), durationText(9.6), durationText(105)]).toEqual(['1:15', '0:10', '1:45'])
    expect([channelName('x'), channelName('instagram'), channelName('mastodon')]).toEqual([
      'X',
      'Instagram',
      'mastodon',
    ])
  })
  it('lists the posts that went out, newest first', () => {
    expect(postedWith([post('a', 'posted', 1), post('b', 'draft'), post('c', 'posted', 5)]).map((p) => p.id)).toEqual([
      'c',
      'a',
    ])
  })
})

describe('the team library', () => {
  it('groups by campaign with each batch’s variants together, the picked one first, then the rest', () => {
    const groups = [group('since-launch', { kind: 'campaign', level: 'internal' })]
    const assets = [
      asset('v1', { campaign: 'since-launch', batch: 'main' }),
      asset('v2', { campaign: 'since-launch', batch: 'main', picked: true }),
      asset('still', { campaign: 'since-launch' }),
      asset('loose'),
    ]
    const { grouped, rest } = campaignsOf({ groups, assets })
    expect(
      grouped.map((entry) => [entry.campaign.id, entry.batches.map((b) => [b.batch, b.assets.map((x) => x.id)])]),
    ).toEqual([
      [
        'since-launch',
        [
          ['main', ['v2', 'v1']],
          [undefined, ['still']],
        ],
      ],
    ])
    expect(rest.map((x) => x.id)).toEqual(['loose'])
    expect(batchesOf([])).toEqual([])
  })
})
