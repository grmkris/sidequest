import { expect, it } from 'vitest'
import { publisherFunding, publisherNextAction, settlementNote } from './publisher-view.ts'
import type { ChainView } from './service.ts'

const view: ChainView = {
  status: 'active',
  coreStatus: 'Funded',
  listingMatchesOffer: true,
  provider: '0x1111111111111111111111111111111111111111',
  submittedAt: null,
  timely: true,
  deliveryDeadline: 2000,
  reviewEndsAt: 2100,
  disputeEndsAt: 2200,
  arbitrationEndsAt: 2300,
  violation: null,
}
it('derives deadlines and permissionless timeout actors from the frozen chain windows', () => {
  expect(publisherNextAction(view, 1000)).toEqual({ actor: 'worker', action: 'submit_work', deadline: 2000 })
  expect(publisherNextAction(view, 2001)).toEqual({ actor: 'anyone', action: 'settle_missed_delivery', deadline: null })
  expect(publisherNextAction({ ...view, status: 'submitted' }, 2100)).toEqual({
    actor: 'approver',
    action: 'approve_or_reject',
    deadline: 2100,
  })
  expect(publisherNextAction({ ...view, status: 'submitted' }, 2101)?.actor).toBe('anyone')
  expect(publisherNextAction({ ...view, status: 'rejected-pending' }, 2100)?.deadline).toBe(2200)
  expect(publisherNextAction({ ...view, status: 'disputed' }, 2100)?.deadline).toBe(2300)
  expect(publisherNextAction({ ...view, status: 'completed', deferredDecision: true }, 2100)?.action).toBe(
    'retry_deferred_then_settle',
  )
  expect(publisherFunding({ ...view, status: 'completed' }).state).toBe('terminal-see-settlement')
  expect(publisherFunding({ ...view, listingMatchesOffer: false }).state).toBe('unknown')
})

it('sends a lapsed hire to its creator to cancel, and ends at a final state', () => {
  expect(publisherNextAction({ ...view, status: 'open' }, 1000)).toEqual({
    actor: 'creator',
    action: 'select_worker',
    deadline: 2000,
  })
  expect(publisherNextAction({ ...view, status: 'lapsed' }, 2001)).toEqual({
    actor: 'creator',
    action: 'cancel_task',
    deadline: null,
  })
  for (const status of ['completed', 'rejected', 'cancelled', 'expired'] as const)
    expect(publisherNextAction({ ...view, status }, 2001)).toBeNull()
})

it('explains an empty settlement: who acts next, a lapsed hire to cancel, or nothing left', () => {
  expect(settlementNote({ ...view, status: 'lapsed' }, 2001)).toContain('cancel_task')
  expect(settlementNote({ ...view, status: 'rejected' }, 2001)).toBe(
    'Nothing left to settle for this wallet: the job is final and nothing is owed to it.',
  )
  expect(settlementNote(view, 1000)).toBe(
    'Nothing to settle yet: the worker acts next (submit_work) until 1970-01-01T00:33:20.000Z.',
  )
  expect(settlementNote({ ...view, status: 'submitted' }, 2050)).toContain('the approver acts next (approve_or_reject)')
})
