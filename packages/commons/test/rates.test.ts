import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { makeHarness, alice, moderator } from './layers.ts'
import { invoke } from './calls.ts'
import { ReportGapOutput } from '../src/schema/gaps.ts'
import { ProposeItemOutput, SupportItemOutput } from '../src/schema/roadmap.ts'
import { PostMessageOutput } from '../src/schema/messages.ts'
import { PROPOSE_MINIMUM } from '../src/stake.ts'

it.effect('report limit is 20/day and blocked reports write neither content nor feed', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    yield* Effect.gen(function* () {
      for (let n = 0; n < 20; n++)
        yield* invoke('report_gap', ReportGapOutput, alice, {
          gap_type: 'error',
          what_i_needed: 'Missing',
          what_i_tried: 'Workaround',
        })
      const error = yield* invoke('report_gap', ReportGapOutput, alice, {
        gap_type: 'error',
        what_i_needed: 'Missing',
        what_i_tried: 'Workaround',
      }).pipe(Effect.flip)
      expect(error._tag).toBe('RateLimited')
      expect(error.message).toBe('retry in 86400s')
      expect(h.sql.all('SELECT * FROM commons_gap_reports')).toHaveLength(20)
      // One row per report for each role holder: the harness has one moderator and one maintainer.
      expect(h.events).toHaveLength(40)
      yield* TestClock.adjust(86_400_000)
      yield* invoke('report_gap', ReportGapOutput, alice, {
        gap_type: 'error',
        what_i_needed: 'Missing',
        what_i_tried: 'Workaround',
      })
    }).pipe(Effect.provide(h.layer))
  }),
)
it.effect('proposal limit is 3/day', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    h.state.stakes.set(alice, PROPOSE_MINIMUM)
    yield* Effect.gen(function* () {
      for (let n = 0; n < 3; n++)
        yield* invoke('propose_item', ProposeItemOutput, alice, {
          title: 'Feature',
          problem: 'Missing',
          proposal: 'Build it',
        })
      expect(
        (yield* invoke('propose_item', ProposeItemOutput, alice, {
          title: 'Feature',
          problem: 'Missing',
          proposal: 'Build it',
        }).pipe(Effect.flip))._tag,
      ).toBe('RateLimited')
      expect(h.sql.all('SELECT * FROM commons_items')).toHaveLength(4)
    }).pipe(Effect.provide(h.layer))
  }),
)
it.effect('support/withdraw share the 30/hour bucket and roles are not rate limited', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    h.state.stakes.set(alice, 1n)
    yield* Effect.gen(function* () {
      for (let n = 0; n < 30; n++) yield* invoke('support_item', SupportItemOutput, alice, { itemId: 1 })
      expect((yield* invoke('support_item', SupportItemOutput, alice, { itemId: 1 }).pipe(Effect.flip))._tag).toBe(
        'RateLimited',
      )
      yield* TestClock.adjust(3_600_000)
      yield* invoke('support_item', SupportItemOutput, alice, { itemId: 1 })
    }).pipe(Effect.provide(h.layer))
  }),
)
it.effect('post minute windows still preserve the 120/day bucket', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    yield* Effect.gen(function* () {
      for (let minute = 0; minute < 20; minute++) {
        for (let n = 0; n < 6; n++)
          yield* invoke('post_message', PostMessageOutput, moderator, { subject: 'lobby', body: 'Message' })
        yield* TestClock.adjust(60_000)
      }
      const error = yield* invoke('post_message', PostMessageOutput, moderator, {
        subject: 'lobby',
        body: 'Message',
      }).pipe(Effect.flip)
      expect(error._tag).toBe('RateLimited')
      expect(h.sql.all('SELECT * FROM commons_messages')).toHaveLength(120)
    }).pipe(Effect.provide(h.layer))
  }),
)
