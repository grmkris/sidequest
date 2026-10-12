import { describe, expect, it } from 'vitest'
import {
  type Message,
  type Viewer,
  badgeLabel,
  composerGuidance,
  hiddenLabel,
  jobSubject,
  roadmapSubject,
  side,
  shownBadges,
  sortBadges,
  supportLine,
  threadTree,
  weightShare,
} from './commons.ts'
import { commonsSearch, commonsTab, gapFilters, gapSearch, onCommons } from './commons-route.ts'

const SIDE = 10n ** 18n
const message = (id: number, replyTo: number | null = null): Message => ({
  id,
  subject: 'lobby',
  author: '0x1111111111111111111111111111111111111111',
  badges: [],
  body: `m${id}`,
  replyTo,
  mentions: [],
  hidden: null,
  createdAt: 1000 + id,
})
const viewer = (over: Partial<Viewer>): Viewer => ({
  address: '0x2222222222222222222222222222222222222222',
  roles: [],
  canPost: false,
  needs: 'stake',
  minimum: String(10n * SIDE),
  stake: '0',
  backing: '0',
  ...over,
})

describe('commons subjects', () => {
  it('names threads exactly as the board does', () => {
    expect(jobSubject('public', 'abc123')).toBe('job:public:abc123')
    expect(roadmapSubject(7)).toBe('roadmap:7')
  })
})

describe('side', () => {
  it('shows whole SIDE, compacting thousands and millions', () => {
    expect(side(String(950n * SIDE))).toBe('950')
    expect(side(String(1234n * SIDE))).toBe('1.2k')
    expect(side(String(2_000_000n * SIDE))).toBe('2M')
    expect(side(String(SIDE / 2n))).toBe('0.5')
    expect(side(null)).toBe('0')
  })
})

describe('badges', () => {
  it('labels stake and backing with their amount and subject', () => {
    expect(badgeLabel({ kind: 'staker', amount: String(1500n * SIDE) })).toBe('Staker 1.5k')
    expect(badgeLabel({ kind: 'backer', of: '0xabcdef0000000000000000000000000000001234' })).toBe(
      'Backer of 0xabcd…1234',
    )
    expect(badgeLabel({ kind: 'owner' })).toBe('Owner')
  })
  it('puts role badges before job roles and stake', () => {
    const kinds = sortBadges([{ kind: 'staker' }, { kind: 'owner' }, { kind: 'moderator' }]).map((b) => b.kind)
    expect(kinds).toEqual(['moderator', 'owner', 'staker'])
  })
  it('shows one backer chip for several backed agents, with each address in its title', () => {
    const one = '0xabcdef0000000000000000000000000000001234'
    const two = '0x1234000000000000000000000000000000005678'
    expect(shownBadges([{ kind: 'backer', of: one }, { kind: 'maintainer' }, { kind: 'backer', of: two }])).toEqual([
      { key: 'maintainer-', label: 'Maintainer', role: true },
      { key: 'backer', label: 'Backer of 2 agents', role: false, title: '0xabcd…1234, 0x1234…5678' },
    ])
    expect(shownBadges([{ kind: 'backer', of: one }])).toEqual([
      { key: `backer-${one}`, label: 'Backer of 0xabcd…1234', role: false },
    ])
  })
})

describe('hiddenLabel', () => {
  it('names the role and the public reason', () => {
    expect(hiddenLabel({ role: 'moderator', reason: 'spam: link farm', at: 1, logSeq: 3 })).toBe(
      'Hidden by Moderator: spam: link farm',
    )
  })
})

describe('composerGuidance', () => {
  it('asks signed-out readers to sign in', () => {
    expect(composerGuidance(null, false)).toBe('Sign in to post.')
  })
  it('opens the composer when the board says the viewer may post', () => {
    expect(composerGuidance(viewer({ canPost: true, needs: null }), true)).toBeNull()
  })
  it('explains the stake gate with what the viewer holds', () => {
    const text = composerGuidance(viewer({ stake: String(3n * SIDE), backing: String(2n * SIDE) }), true)
    expect(text).toBe('Posting here needs 10 SIDE staked or backing someone; you have 5.')
  })
})

describe('roadmap helpers', () => {
  it('describes support with or without weights', () => {
    expect(supportLine({ supporters: 1, weight: String(12_500n * SIDE) }, true)).toBe('1 supporter · 12.5k SIDE')
    expect(supportLine({ supporters: 3, weight: '0' }, false)).toBe('3 supporters')
  })
  it('measures each item against the leading one', () => {
    const items = [{ weight: String(400n * SIDE) }, { weight: String(100n * SIDE) }]
    expect(weightShare(items, String(100n * SIDE))).toBe(25)
    expect(weightShare([{ weight: '0' }], '0')).toBe(0)
  })
})

describe('threadTree', () => {
  it('puts replies under their post and keeps orphans as their own posts', () => {
    const tree = threadTree([message(1), message(2, 1), message(3), message(4, 99)])
    expect(tree.map((t) => [t.root.id, t.replies.map((r) => r.id)])).toEqual([
      [1, [2]],
      [3, []],
      [4, []],
    ])
  })
})

describe('commons route', () => {
  it('round-trips gap filters in a shareable URL and rejects unsupported filters', () => {
    const search = gapSearch('?x=1&tab=roles', { status: 'fixed', gapType: 'error', tool: ' list_tasks ' })
    expect(search).toBe('?x=1&tab=gaps&gapStatus=fixed&gapType=error&tool=list_tasks')
    expect(gapFilters(search)).toEqual({ status: 'fixed', gapType: 'error', tool: 'list_tasks' })
    expect(gapFilters('?gapStatus=closed&gapType=__proto__&tool=bad/tool')).toEqual({})
    expect(gapSearch(search, {})).toBe('?x=1&tab=gaps')
  })
  it('reads and writes the tab, with Lobby as the default', () => {
    expect(commonsTab('')).toBe('lobby')
    expect(commonsTab('?tab=roadmap')).toBe('roadmap')
    expect(commonsTab('?tab=nope')).toBe('lobby')
    expect(commonsSearch('?tab=gaps', 'lobby')).toBe('')
    expect(commonsSearch('?x=1', 'roles')).toBe('?x=1&tab=roles')
  })
  it('claims /commons and its roadmap pages for the Commons place', () => {
    expect(onCommons('/commons')).toBe(true)
    expect(onCommons('/commons/roadmap/3')).toBe(true)
    expect(onCommons('/commonsx')).toBe(false)
    expect(onCommons('/jobs')).toBe(false)
  })
})
