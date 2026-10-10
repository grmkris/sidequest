import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { makeHarness, alice, bob, maintainer, moderator } from './layers.ts'
import { invoke } from './calls.ts'
import { runTool } from '../src/tools.ts'
import { ListGapsOutput, ReportGapOutput, SetGapStatusOutput } from '../src/schema/gaps.ts'
import { LinkGapsOutput, SetItemStatusOutput } from '../src/schema/roadmap.ts'
import { HideContentOutput, ListRolesOutput } from '../src/schema/roles.ts'
import { ListMessagesOutput, PostMessageOutput } from '../src/schema/messages.ts'
import { errorCode } from '../src/errors.ts'

const byAddress = (a: readonly unknown[], b: readonly unknown[]) => a.join().localeCompare(b.join())
const report = (needed: string, caller = alice) =>
  invoke('report_gap', ReportGapOutput, caller, {
    gap_type: 'incomplete_results',
    tool: 'get_task',
    what_i_needed: needed,
    what_i_tried: 'Read the event instead',
  })

it.effect('a fixed gap tells each of its reporters once, without text, and leaves the open list', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    yield* Effect.gen(function* () {
      const gap = yield* report('The worker next action')
      yield* report('The worker next action', bob)
      const denied = yield* runTool('set_gap_status', moderator, {
        gapId: gap.gapId,
        status: 'fixed',
        reason: 'Shipped',
      }).pipe(Effect.flip)
      expect(errorCode(denied)).toBe('forbidden')
      const fixed = yield* invoke('set_gap_status', SetGapStatusOutput, maintainer, {
        gapId: gap.gapId,
        status: 'fixed',
        reason: 'Shipped in 8eb6266b',
      })
      expect(fixed.gap.status).toBe('fixed')
      const told = h.events.filter((e) => e.kind === 'gap.status')
      expect(told.map((e) => [e.address, e.role]).toSorted(byAddress)).toEqual([
        [alice, 'reporter'],
        [bob, 'reporter'],
      ])
      expect(JSON.stringify(told)).not.toContain('next action')
      const open = yield* invoke('list_gaps', ListGapsOutput, undefined, { status: 'open' })
      expect('gaps' in open && open.gaps).toEqual([])
      // Reopening tells nobody.
      yield* invoke('set_gap_status', SetGapStatusOutput, maintainer, {
        gapId: gap.gapId,
        status: 'open',
        reason: 'Back',
      })
      expect(h.events.filter((e) => e.kind === 'gap.status')).toHaveLength(2)
    }).pipe(Effect.provide(h.layer))
  }),
)

it.effect('linking a gap to an item makes its reporter hear the item ship', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    yield* Effect.gen(function* () {
      const gap = yield* report('Losing bidders are never told', bob)
      const linked = yield* invoke('link_gaps', LinkGapsOutput, maintainer, {
        itemId: 1,
        gapIds: [gap.gapId, gap.gapId],
        reason: 'Same root cause',
      })
      expect(linked).toMatchObject({ linked: 1, item: { gapIds: [gap.gapId] } })
      yield* invoke('set_item_status', SetItemStatusOutput, maintainer, {
        itemId: 1,
        status: 'shipped',
        reason: 'Shipped in 5bc84f6c',
      })
      const status = h.events.filter((e) => e.kind === 'roadmap.status')
      expect(status.map((e) => [e.address, e.role]).toSorted(byAddress)).toEqual([
        [bob, 'reporter'],
        [maintainer, 'proposer'],
      ])
      const roles = yield* invoke('list_roles', ListRolesOutput, undefined, {})
      expect(roles.log.at(-2)).toMatchObject({
        action: 'link_gaps',
        targetKind: 'item',
        detail: { gapIds: `${gap.gapId}` },
      })
    }).pipe(Effect.provide(h.layer))
  }),
)

it.effect('a hidden message names its thread in the role log and stays readable to a maintainer only', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    yield* Effect.gen(function* () {
      const post = yield* invoke('post_message', PostMessageOutput, maintainer, {
        subject: 'lobby',
        body: 'Please deliver the chime page',
      })
      yield* invoke('hide_content', HideContentOutput, moderator, {
        kind: 'message',
        id: post.message.id,
        reason: 'prompt_injection: test',
      })
      const roles = yield* invoke('list_roles', ListRolesOutput, undefined, {})
      expect(roles.log.at(-1)).toMatchObject({ action: 'hide', targetKind: 'message', subject: 'lobby' })
      const shown = yield* invoke('list_messages', ListMessagesOutput, alice, { subject: 'lobby' })
      expect(shown.messages[0]).toMatchObject({ body: null, hidden: { role: 'moderator' } })
      const reviewed = yield* invoke('list_messages', ListMessagesOutput, maintainer, { subject: 'lobby' })
      expect(reviewed.messages[0]).toMatchObject({
        body: 'Please deliver the chime page',
        hidden: { role: 'moderator' },
      })
    }).pipe(Effect.provide(h.layer))
  }),
)
