import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { makeHarness, alice, bob, maintainer, moderator } from './layers.ts'
import { invoke } from './calls.ts'
import { MAINNET_MINIMUMS, Minimums, PROPOSE_MINIMUM } from '../src/stake.ts'
import {
  ProposeItemOutput,
  SupportItemOutput,
  WithdrawSupportOutput,
  ListRoadmapOutput,
  GetRoadmapItemOutput,
  MergeItemsOutput,
} from '../src/schema/roadmap.ts'
import { SetItemStatusOutput } from '../src/schema/roadmap.ts'
import type { SyncSql } from '../src/sql/sync.ts'

function fixtures(sql: SyncSql, count: number): void {
  for (let id = 2; id <= count; id++)
    sql.run(
      `INSERT INTO commons_items(id,title,problem,proposal,proposer,proposer_stake,proposer_block,status,created_at,updated_at)
    VALUES(?,?,'Problem','Proposal',?,'100','42','open',?,?)`,
      id,
      `Item ${id}`,
      alice,
      id,
      id,
    )
}
const support = (id: number, caller = bob) => invoke('support_item', SupportItemOutput, caller, { itemId: id })
const withdraw = (id: number, caller = bob) => invoke('withdraw_support', WithdrawSupportOutput, caller, { itemId: id })
const status = (id: number, value: string) =>
  invoke('set_item_status', SetItemStatusOutput, maintainer, {
    itemId: id,
    status: value,
    reason: 'Ready for status change',
  })

it.effect.each([PROPOSE_MINIMUM - 1n, PROPOSE_MINIMUM])('propose gate at %s with proposer block stored', (stake) =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    h.state.stakes.set(alice, stake)
    yield* Effect.gen(function* () {
      const result = yield* invoke('propose_item', ProposeItemOutput, alice, {
        title: 'Roadmap',
        problem: 'Need it',
        proposal: 'Build it',
      }).pipe(Effect.result)
      expect(result._tag).toBe(stake < PROPOSE_MINIMUM ? 'Failure' : 'Success')
      expect(
        h.sql.all<{ proposer_stake: string; proposer_block: string }>(
          'SELECT proposer_stake,proposer_block FROM commons_items WHERE id=2',
        ),
      ).toEqual(stake < PROPOSE_MINIMUM ? [] : [{ proposer_stake: stake.toString(), proposer_block: '42' }])
    }).pipe(Effect.provide(h.layer))
  }),
)
it.effect("mainnet's minimum is the host's: testnet's 100 SIDE no longer proposes, 100k SIDE does", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    const propose = invoke('propose_item', ProposeItemOutput, alice, {
      title: 'Roadmap',
      problem: 'Need it',
      proposal: 'Build it',
    })
    yield* Effect.gen(function* () {
      h.state.stakes.set(alice, PROPOSE_MINIMUM)
      const refused = yield* propose.pipe(Effect.flip)
      expect(refused).toMatchObject({ _tag: 'StakeRequired', minimum: MAINNET_MINIMUMS.propose.toString() })
      h.state.stakes.set(alice, MAINNET_MINIMUMS.propose)
      expect((yield* propose.pipe(Effect.result))._tag).toBe('Success')
    }).pipe(Effect.provide(h.layer), Effect.provideService(Minimums, MAINNET_MINIMUMS))
  }),
)
it.effect('backing and roles cannot substitute for proposal stake; invalid linked gap rolls back rate', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    h.state.backing.set(moderator, [{ account: alice, value: PROPOSE_MINIMUM }])
    yield* Effect.gen(function* () {
      expect(
        (yield* invoke('propose_item', ProposeItemOutput, moderator, {
          title: 'Roadmap',
          problem: 'Need',
          proposal: 'Build',
        }).pipe(Effect.result))._tag,
      ).toBe('Failure')
      h.state.stakes.set(alice, PROPOSE_MINIMUM)
      expect(
        (yield* invoke('propose_item', ProposeItemOutput, alice, {
          title: 'Roadmap',
          problem: 'Need',
          proposal: 'Build',
          gapIds: [999],
        }).pipe(Effect.result))._tag,
      ).toBe('Failure')
      expect(h.sql.all('SELECT * FROM commons_rate')).toHaveLength(0)
    }).pipe(Effect.provide(h.layer))
  }),
)
it.effect('one pinned stakes call ranks all items, cached for exactly 30 seconds, with viewer thresholds', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    fixtures(h.sql, 3)
    h.state.stakes.set(alice, PROPOSE_MINIMUM)
    h.state.stakes.set(bob, 5n)
    yield* Effect.gen(function* () {
      yield* support(2)
      yield* support(3, alice)
      h.state.stakeCalls.length = 0
      const first = yield* invoke('list_roadmap', ListRoadmapOutput, alice, {})
      expect(h.state.stakeCalls).toEqual([[alice, bob]])
      expect(first.block).toBe('42')
      expect(first.items.map((i) => i.id)).toEqual([3, 2, 1])
      expect(first.viewer).toMatchObject({ canPropose: true, canVote: true, activeSupports: 1 })
      h.state.block = 43n
      h.state.stakes.set(bob, PROPOSE_MINIMUM * 2n)
      yield* TestClock.adjust(29_999)
      expect((yield* invoke('list_roadmap', ListRoadmapOutput, alice, {})).block).toBe('42')
      expect(h.state.stakeCalls).toHaveLength(1)
      yield* TestClock.adjust(1)
      const refreshed = yield* invoke('list_roadmap', ListRoadmapOutput, alice, {})
      expect(refreshed.block).toBe('43')
      expect(refreshed.items[0]?.id).toBe(2)
      expect(h.state.stakeCalls).toHaveLength(2)
      expect(refreshed.items[0]?.weight).toBe((PROPOSE_MINIMUM * 2n).toString())
    }).pipe(Effect.provide(h.layer))
  }),
)
it.effect.each(['shipped', 'declined'])(
  'sixth support conflicts, repeats are idempotent, and %s frees a slot',
  (finalStatus) =>
    Effect.gen(function* () {
      const h = yield* makeHarness()
      fixtures(h.sql, 6)
      h.state.stakes.set(bob, 1n)
      yield* Effect.gen(function* () {
        for (let id = 1; id <= 5; id++) expect((yield* support(id)).activeSupports).toBe(id)
        expect((yield* support(1)).activeSupports).toBe(5)
        const error = yield* support(6).pipe(Effect.flip)
        expect(error._tag).toBe('Conflict')
        expect(h.sql.all('SELECT * FROM commons_supports WHERE withdrawn_at IS NULL')).toHaveLength(5)
        yield* status(1, finalStatus)
        expect((yield* support(6)).activeSupports).toBe(5)
        expect((yield* withdraw(2)).activeSupports).toBe(4)
        expect((yield* withdraw(2)).activeSupports).toBe(4)
        expect((yield* support(2)).activeSupports).toBe(5)
      }).pipe(Effect.provide(h.layer))
    }),
)
it.effect('vote needs own stake > 0 and withdraw works after own stake reaches zero', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    h.state.backing.set(bob, [{ account: alice, value: PROPOSE_MINIMUM }])
    yield* Effect.gen(function* () {
      expect((yield* support(1).pipe(Effect.flip))._tag).toBe('StakeRequired')
      h.state.stakes.set(bob, 1n)
      yield* support(1)
      h.state.stakes.set(bob, 0n)
      expect((yield* withdraw(1)).activeSupports).toBe(0)
    }).pipe(Effect.provide(h.layer))
  }),
)
it.effect('merge unions active votes, reactivates a withdrawn target vote, and rejects cycles', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    fixtures(h.sql, 3)
    h.state.stakes.set(alice, 10n)
    h.state.stakes.set(bob, 10n)
    yield* Effect.gen(function* () {
      yield* support(2)
      yield* support(1)
      yield* withdraw(1)
      yield* support(2, alice)
      yield* support(1, alice)
      const merged = yield* invoke('merge_items', MergeItemsOutput, maintainer, {
        sourceId: 2,
        targetId: 1,
        reason: 'Same proposal',
      })
      expect(merged.movedSupports).toBe(2)
      expect(merged.item.supporters).toBe(2)
      expect(h.sql.all('SELECT * FROM commons_supports WHERE item_id=2 AND withdrawn_at IS NULL')).toHaveLength(0)
      expect(
        (yield* invoke('merge_items', MergeItemsOutput, maintainer, { sourceId: 1, targetId: 2, reason: 'Loop' }).pipe(
          Effect.flip,
        ))._tag,
      ).toBe('Conflict')
      const listing = yield* invoke('list_roadmap', ListRoadmapOutput, bob, {})
      expect(listing.viewer?.activeSupports).toBe(1)
      expect(listing.items.at(-1)?.id).toBe(2)
      const detail = yield* invoke('get_roadmap_item', GetRoadmapItemOutput, bob, { itemId: 1 })
      expect(detail.item.weight).toBe('20')
      expect(detail.supporters).toHaveLength(2)
      expect(detail.thread).toEqual({ subject: 'roadmap:1', count: 0 })
    }).pipe(Effect.provide(h.layer))
  }),
)
it.effect('weight failure keeps public listing available and hidden items rank last', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    fixtures(h.sql, 3)
    h.state.failStake = true
    h.sql.run(
      "UPDATE commons_items SET hidden_at=1,hidden_role='moderator',hidden_reason='Spam',hidden_log_seq=1 WHERE id=1",
    )
    const listing = yield* invoke('list_roadmap', ListRoadmapOutput, alice, {}).pipe(Effect.provide(h.layer))
    expect(listing.weightsAvailable).toBe(false)
    expect(listing.block).toBeNull()
    expect(listing.items.at(-1)?.id).toBe(1)
    expect(listing.viewer?.canVote).toBe(false)
  }),
)
it.effect('equal weight ranks by supporter count then age, and changed voter set refreshes the cache', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    fixtures(h.sql, 3)
    h.state.stakes.set(alice, 10n)
    h.state.stakes.set(bob, 5n)
    yield* Effect.gen(function* () {
      yield* support(1, alice)
      yield* support(2, bob)
      yield* invoke('list_roadmap', ListRoadmapOutput, undefined, {})
      h.state.stakes.set(moderator, 5n)
      yield* support(2, moderator)
      const first = yield* invoke('list_roadmap', ListRoadmapOutput, undefined, {})
      expect(first.items.map((i) => i.id)).toEqual([2, 1, 3])
      expect(h.state.stakeCalls.at(-1)).toEqual([alice, bob, moderator])
    }).pipe(Effect.provide(h.layer))
  }),
)

it.effect('inactive source merge cannot create a sixth support, and reopening checks the cap', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    fixtures(h.sql, 7)
    h.state.stakes.set(bob, 1n)
    yield* Effect.gen(function* () {
      for (let id = 1; id <= 5; id++) yield* support(id)
      yield* status(1, 'shipped')
      yield* support(6)
      expect((yield* status(1, 'open').pipe(Effect.flip))._tag).toBe('Conflict')
      const merged = yield* invoke('merge_items', MergeItemsOutput, maintainer, {
        sourceId: 1,
        targetId: 7,
        reason: 'Inactive duplicate',
      })
      expect(merged.movedSupports).toBe(0)
      expect((yield* invoke('list_roadmap', ListRoadmapOutput, bob, {})).viewer?.activeSupports).toBe(5)
    }).pipe(Effect.provide(h.layer))
  }),
)
