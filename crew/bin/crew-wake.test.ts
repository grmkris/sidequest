/** `bun test crew/bin/crew-wake.test.ts`: which held jobs wake a crew worker. */
import { expect, test } from 'bun:test'
import { openHeld } from './crew-wake.ts'

test('a settled rejection no longer wakes the worker, but one it may still dispute does', () => {
  const held = [
    { id: 'done', chain: { status: 'completed' }, nextAction: null },
    { id: 'settled-rejection', chain: { status: 'rejected' }, nextAction: null },
    { id: 'disputable', chain: { status: 'rejected' }, nextAction: { actor: 'worker' } },
    { id: 'cancelled', chain: { status: 'cancelled' } },
    { id: 'expired', chain: { status: 'expired' } },
    { id: 'active', chain: { status: 'active' }, nextAction: { actor: 'worker' } },
    { id: 'in-review', chain: { status: 'submitted' }, nextAction: { actor: 'approver' } },
    { id: 'in-dispute', chain: { status: 'disputed' }, nextAction: { actor: 'arbitrator' } },
    { id: 'unknown-turn', chain: { status: 'active' } },
  ]
  // Someone else's turn (review, ruling) waits; a job with no named next actor wakes while it is not done.
  expect(openHeld(held).map((task) => task.id)).toEqual(['disputable', 'active', 'unknown-turn'])
})
