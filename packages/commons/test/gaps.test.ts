import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { makeHarness, alice, bob, maintainer, moderator, arbiter } from './layers.ts'
import { invoke } from './calls.ts'
import { ReportGapOutput, ListGapsOutput, MergeGapsOutput } from '../src/schema/gaps.ts'
import { HideContentOutput } from '../src/schema/roles.ts'
import { ProposeItemOutput } from '../src/schema/roadmap.ts'
import { PROPOSE_MINIMUM } from '../src/stake.ts'

const report = (needed: string, caller = alice) =>
  invoke('report_gap', ReportGapOutput, caller, {
    gap_type: 'missing_tool',
    tool: 'foo',
    what_i_needed: needed,
    what_i_tried: 'Tried a workaround',
    user_goal: 'Private goal',
    suggestion: 'Possible improvement',
  })

it.effect.each([moderator, maintainer, arbiter])('cluster key normalizes and user_goal is role-only for %s', (role) =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    yield* Effect.gen(function* () {
      const first = yield* report(' Missing  tool ')
      const second = yield* report('missing tool', bob)
      expect(first.duplicate).toBe(false)
      expect(second).toMatchObject({ gapId: first.gapId, duplicate: true, reports: 2, reporters: 2 })
      const publicResult = yield* invoke('list_gaps', ListGapsOutput, undefined, { gapId: first.gapId })
      if (!('reports' in publicResult)) throw new Error('Expected gap detail')
      expect(publicResult.reports.every((r) => !('userGoal' in r))).toBe(true)
      const roleResult = yield* invoke('list_gaps', ListGapsOutput, role, { gapId: first.gapId })
      if (!('reports' in roleResult)) throw new Error('Expected gap detail')
      expect(roleResult.reports[0]?.userGoal).toBe('Private goal')
      expect(roleResult.reports[0]?.whatITried).toBe('Tried a workaround')
    }).pipe(Effect.provide(h.layer))
  }),
)
it.effect('gap merge reroutes old keys and gapId reads; deduplicates linked item gaps', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    h.state.stakes.set(alice, PROPOSE_MINIMUM)
    yield* Effect.gen(function* () {
      const source = yield* report('First gap')
      const target = yield* report('Second gap')
      const item = yield* invoke('propose_item', ProposeItemOutput, alice, {
        title: 'Fix both',
        problem: 'Two gaps',
        proposal: 'Combine',
        gapIds: [source.gapId, target.gapId],
      })
      const merged = yield* invoke('merge_gaps', MergeGapsOutput, maintainer, {
        sourceGapId: source.gapId,
        targetGapId: target.gapId,
        reason: 'Same missing capability',
      })
      expect(merged.movedReports).toBe(1)
      expect(merged.gap.reports).toBe(2)
      expect(merged.gap.itemIds).toEqual([item.item.id])
      const rerouted = yield* report('first gap', bob)
      expect(rerouted).toMatchObject({ gapId: target.gapId, duplicate: true, reports: 3 })
      const detail = yield* invoke('list_gaps', ListGapsOutput, undefined, { gapId: source.gapId })
      if (!('reports' in detail)) throw new Error('Expected gap detail')
      expect(detail.gap.id).toBe(target.gapId)
      expect(detail.reports.at(-1)?.originGapId).toBe(source.gapId)
      expect(h.sql.all('SELECT * FROM commons_item_gaps WHERE gap_id=?', source.gapId)).toHaveLength(0)
      expect(
        (yield* invoke('merge_gaps', MergeGapsOutput, maintainer, {
          sourceGapId: target.gapId,
          targetGapId: source.gapId,
          reason: 'Cycle attempt',
        }).pipe(Effect.flip))._tag,
      ).toBe('Conflict')
    }).pipe(Effect.provide(h.layer))
  }),
)
it.effect('hidden gap reports are stubs to the public; a maintainer reviewing the hide still reads them', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    yield* Effect.gen(function* () {
      const gap = yield* report('Hide this report')
      yield* invoke('hide_content', HideContentOutput, moderator, {
        kind: 'gap_report',
        id: gap.reportId,
        reason: 'Spam content',
      })
      const shown = yield* invoke('list_gaps', ListGapsOutput, undefined, { gapId: gap.gapId })
      if (!('reports' in shown)) throw new Error('Expected gap detail')
      expect(shown.reports[0]).toMatchObject({
        whatINeeded: null,
        whatITried: null,
        suggestion: null,
        hidden: { logSeq: 1 },
      })
      expect(JSON.stringify(shown)).not.toContain('Private goal')
      expect(shown.gap.example).toBeNull()
      expect(JSON.stringify(shown)).not.toContain('Hide this report')
      // The maintainer can judge the hide (and unhide a false positive); the cluster summary stays clean.
      const reviewed = yield* invoke('list_gaps', ListGapsOutput, maintainer, { gapId: gap.gapId })
      if (!('reports' in reviewed)) throw new Error('Expected gap detail')
      expect(reviewed.reports[0]).toMatchObject({ whatINeeded: 'Hide this report', hidden: { logSeq: 1 } })
      expect(reviewed.gap.example).toBeNull()
    }).pipe(Effect.provide(h.layer))
  }),
)
it.effect('gap list supports filters and cursor pages', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    yield* Effect.gen(function* () {
      yield* report('One')
      yield* report('Two')
      yield* report('Three')
      const first = yield* invoke('list_gaps', ListGapsOutput, undefined, {
        tool: 'foo',
        gapType: 'missing_tool',
        limit: '2',
      })
      if (!('gaps' in first)) throw new Error('Expected gap page')
      expect(first.gaps.map((g) => g.id)).toEqual([1, 2])
      expect(first.cursor).toBe('c:2')
      const second = yield* invoke('list_gaps', ListGapsOutput, undefined, { cursor: first.cursor, limit: 2 })
      if (!('gaps' in second)) throw new Error('Expected gap page')
      expect(second.gaps.map((g) => g.id)).toEqual([3])
      expect(second.cursor).toBeNull()
    }).pipe(Effect.provide(h.layer))
  }),
)
