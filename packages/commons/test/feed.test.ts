import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { makeHarness, alice, bob, moderator, maintainer } from './layers.ts'
import { invoke } from './calls.ts'
import { postEvents, roleHolderEvents } from '../src/feed.ts'
import type { Message } from '../src/schema/messages.ts'
import { PostMessageOutput } from '../src/schema/messages.ts'
import { ReportGapOutput } from '../src/schema/gaps.ts'
import { ProposeItemOutput, SetItemStatusOutput } from '../src/schema/roadmap.ts'
import { HideContentOutput } from '../src/schema/roles.ts'
import { PROPOSE_MINIMUM } from '../src/stake.ts'

it('feed recipient precedence is reply > mention > participant, with moderator row separate', () => {
  const message: Message = {
    id: 9,
    subject: 'job:board:task',
    author: alice,
    badges: [],
    body: 'Private body',
    replyTo: 1,
    mentions: [
      { token: 'Name', address: bob },
      { token: 'Self', address: alice },
      { token: 'Mod', address: moderator },
    ],
    hidden: null,
    createdAt: 9,
  }
  const people = { creator: bob, approver: bob, worker: moderator, bidders: [], arbitrator: null, jobId: '42' }
  const events = postEvents(message, people, [moderator, moderator], bob)
  expect(events.map((event) => [event.id, event.kind, event.role])).toEqual([
    [`commons:m9:mod:${moderator}`, 'message.posted', 'moderator'],
    [`commons:m9:${bob}`, 'message.reply', 'author'],
    [`commons:m9:${moderator}`, 'message.mention', 'mentioned'],
  ])
  expect(events.every((event) => event.address !== alice && event.address !== '*')).toBe(true)
})
it.effect.prop(
  'all feed triggers omit random body, title, gap fields and reasons',
  [Schema.String.check(Schema.isMaxCodePoints(20))],
  ([random]) =>
    Effect.gen(function* () {
      const h = yield* makeHarness()
      h.state.stakes.set(alice, PROPOSE_MINIMUM)
      const marker = `user-marker-${random}`
      yield* Effect.gen(function* () {
        const post = yield* invoke('post_message', PostMessageOutput, alice, { subject: 'lobby', body: marker })
        const gap = yield* invoke('report_gap', ReportGapOutput, alice, {
          gap_type: 'error',
          what_i_needed: marker,
          what_i_tried: marker,
          suggestion: marker,
          user_goal: marker,
        })
        const item = yield* invoke('propose_item', ProposeItemOutput, alice, {
          title: marker,
          problem: marker,
          proposal: marker,
          gapIds: [gap.gapId],
        })
        yield* invoke('hide_content', HideContentOutput, moderator, {
          kind: 'message',
          id: post.message.id,
          reason: marker,
        })
        yield* invoke('set_item_status', SetItemStatusOutput, maintainer, {
          itemId: item.item.id,
          status: 'planned',
          reason: marker,
        })
        expect(h.events.some((e) => e.kind === 'message.posted')).toBe(true)
        expect(h.events.some((e) => e.kind === 'gap.reported')).toBe(true)
        expect(h.events.some((e) => e.kind === 'roadmap.proposed')).toBe(true)
        expect(h.events.some((e) => e.kind === 'message.hidden')).toBe(true)
        expect(h.events.some((e) => e.kind === 'roadmap.status')).toBe(true)
        expect(JSON.stringify(h.events)).not.toContain(marker)
        expect(h.events.every((event) => event.next !== undefined)).toBe(true)
      }).pipe(Effect.provide(h.layer))
    }),
)

it('tells each role holder once about a gap report or a proposal, a holder of both roles as maintainer', () => {
  const upper = `0x${'D'.repeat(40)}`
  const gap = roleHolderEvents(
    { kind: 'gap.reported', prefix: 'commons:r7', id: 3, now: 50 },
    { moderator: [moderator, moderator.toUpperCase().replace('0X', '0x'), upper], maintainer: [maintainer] },
  )
  expect(gap).toEqual([
    {
      id: `commons:r7:${moderator}`,
      address: moderator,
      kind: 'gap.reported',
      role: 'moderator',
      summary: 'A Commons gap was reported.',
      next: { tool: 'list_gaps', args: { gapId: '3' } },
      occurredAt: 50,
    },
    {
      id: `commons:r7:${maintainer}`,
      address: maintainer,
      kind: 'gap.reported',
      role: 'maintainer',
      summary: 'A Commons gap was reported.',
      next: { tool: 'list_gaps', args: { gapId: '3' } },
      occurredAt: 50,
    },
  ])
  const proposed = roleHolderEvents(
    { kind: 'roadmap.proposed', prefix: 'commons:i4', id: 4, now: 60 },
    { moderator: [], maintainer: [maintainer] },
  )
  expect(proposed).toEqual([
    {
      id: `commons:i4:${maintainer}`,
      address: maintainer,
      kind: 'roadmap.proposed',
      role: 'maintainer',
      summary: 'A roadmap item was proposed.',
      next: { tool: 'get_roadmap_item', args: { itemId: '4' } },
      occurredAt: 60,
    },
  ])
  expect(
    roleHolderEvents({ kind: 'gap.reported', prefix: 'commons:r1', id: 1, now: 1 }, { moderator: [], maintainer: [] }),
  ).toEqual([])
})
it.effect('a real gap report and proposal reach the moderator and the maintainer', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    h.state.stakes.set(alice, PROPOSE_MINIMUM)
    const rows = (kind: string) =>
      h.events.filter((event) => event.kind === kind).map((event) => [event.id, event.address, event.role])
    yield* Effect.gen(function* () {
      const gap = yield* invoke('report_gap', ReportGapOutput, alice, {
        gap_type: 'missing_tool',
        what_i_needed: 'A tool',
        what_i_tried: 'Another tool',
      })
      const item = yield* invoke('propose_item', ProposeItemOutput, alice, {
        title: 'Add the tool',
        problem: 'It is missing',
        proposal: 'Add it',
      })
      expect(rows('gap.reported')).toEqual([
        [`commons:r${gap.reportId}:${moderator}`, moderator, 'moderator'],
        [`commons:r${gap.reportId}:${maintainer}`, maintainer, 'maintainer'],
      ])
      expect(rows('roadmap.proposed')).toEqual([
        [`commons:i${item.item.id}:${moderator}`, moderator, 'moderator'],
        [`commons:i${item.item.id}:${maintainer}`, maintainer, 'maintainer'],
      ])
    }).pipe(Effect.provide(h.layer))
  }),
)
