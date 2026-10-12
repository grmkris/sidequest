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
  ]
  expect(openHeld(held).map((task) => task.id)).toEqual(['disputable', 'active', 'in-review'])
})
