import { describe, expect, it } from 'vitest'
import {
  type LifecycleInput,
  lifecycle,
  lifecycleFromIndexed,
  lifecycleFromTask,
  phaseText,
  quoteRequestPhase,
} from './lifecycle.ts'

const NOW = 1_000_000
const CREATOR = '0x1111111111111111111111111111111111111111'
const APPROVER = '0x2222222222222222222222222222222222222222'
const WORKER = '0x3333333333333333333333333333333333333333'
const parties = { creator: CREATOR, approver: APPROVER, worker: WORKER }
const job = (over: Partial<LifecycleInput>): LifecycleInput => ({
  status: 'open',
  deliveryDeadline: NOW + 3600,
  workerBond: '1000',
  parties,
  ...over,
})

describe('v1 final decisions and collection', () => {
  it('advances minute-clock phases at the per-job second, independent of production defaults', () => {
    const row = {
      kind: 'sidequest-v1' as const,
      status: 'submitted',
      creator: CREATOR,
      approver: APPROVER,
      worker: WORKER,
      delivery_deadline: NOW + 3600,
      worker_bond: '10',
      submitted_at: NOW,
      review_window: 120,
      rejected_at: NOW + 60,
      dispute_window: 120,
      disputed_at: NOW + 120,
      arbitration_window: 300,
    }
    const input = lifecycleFromIndexed(row)
    expect(input).toMatchObject({ reviewEndsAt: NOW + 120, disputeEndsAt: NOW + 180, arbitrationEndsAt: NOW + 420 })
    expect(lifecycle(input, WORKER, NOW + 120).key).toBe('in-review')
    expect(lifecycle(input, WORKER, NOW + 121).key).toBe('accepted-by-silence')
    expect(lifecycle({ ...input, status: 'rejected-pending' }, WORKER, NOW + 180).key).toBe('rejected-pending')
    expect(lifecycle({ ...input, status: 'rejected-pending' }, WORKER, NOW + 181).key).toBe('rejection-final')
    expect(lifecycle({ ...input, status: 'disputed' }, WORKER, NOW + 420).key).toBe('disputed')
    expect(lifecycle({ ...input, status: 'disputed' }, WORKER, NOW + 421).key).toBe('arbitration-lapsed')
  })
  it('keeps a worker ruling final while the core call is deferred, even after arbitration expiry', () => {
    const phase = lifecycle(
      job({
        kind: 'sidequest-v1',
        status: 'disputed',
        arbitrationEndsAt: NOW - 1,
        outcome: 'ruled-worker',
        deferredDecision: true,
      }),
      WORKER,
      NOW,
    )
    expect(phase).toMatchObject({
      key: 'payout-deferred',
      terminal: true,
      beneficiary: 'worker',
      timeout: 'retryDeferred',
      actions: ['settle'],
    })
  })

  it('offers terminal collection through a pause, but cannot retry the paused core', () => {
    const input = job({
      kind: 'sidequest-v1',
      status: 'rejected',
      outcome: 'accepted',
      collectPending: true,
      paused: true,
    })
    expect(lifecycle(input, WORKER, NOW)).toMatchObject({ key: 'collect', beneficiary: 'worker', actions: ['settle'] })
    expect(lifecycle({ ...input, deferredDecision: true }, WORKER, NOW).actions).toEqual([])
    expect(lifecycle({ ...input, listingMatchesOffer: false }, WORKER, NOW).actions).toEqual([])
  })

  it('the recorded worker outcome remains paid after the deferred route finishes as core Rejected', () => {
    expect(lifecycle(job({ kind: 'sidequest-v1', status: 'rejected', outcome: 'silence' }), WORKER, NOW)).toMatchObject(
      { key: 'completed', beneficiary: 'worker', terminal: true, timeout: null },
    )
    expect(
      lifecycle(
        job({ kind: 'sidequest-v1', status: 'rejected', outcome: 'arbitration-timeout', collectPending: true }),
        CREATOR,
        NOW,
      ).beneficiary,
    ).toBe('creator')
  })

  it('uses the indexed job windows and clears historical deferred flags once settled', () => {
    const row = {
      kind: 'sidequest-v1' as const,
      status: 'disputed',
      creator: CREATOR,
      approver: APPROVER,
      worker: WORKER,
      delivery_deadline: NOW + 100,
      worker_bond: '1000',
      outcome: 'RuledForWorker',
      settlement_outcome: 'None',
      payout_deferred: 1,
      refund_deferred: 0,
      submitted_at: NOW - 20,
      review_window: 3600,
      rejected_at: NOW - 10,
      dispute_window: 7200,
      disputed_at: NOW - 5,
      arbitration_window: 43200,
    }
    const input = lifecycleFromIndexed(row)
    expect(input).toMatchObject({
      reviewEndsAt: NOW + 3580,
      disputeEndsAt: NOW + 7190,
      arbitrationEndsAt: NOW + 43195,
      deferredDecision: true,
    })
    expect(
      lifecycle(lifecycleFromIndexed({ ...row, status: 'rejected', settlement_outcome: 'Paid' }), WORKER, NOW).key,
    ).toBe('completed')
  })
})

describe('lifecycle phases', () => {
  const cases: Array<[string, Partial<LifecycleInput>, string]> = [
    ['board draft', { status: 'awaiting-publish' }, 'draft'],
    ['list draft', { status: 'awaiting publish' }, 'draft'],
    ['stale draft', { status: 'awaiting-publish', deliveryDeadline: NOW - 1 }, 'draft-stale'],
    ['open hire', { status: 'open' }, 'hire-open'],
    ['open hire at its deadline', { status: 'open', deliveryDeadline: NOW }, 'hire-open'],
    ['indexer open hire past its deadline', { status: 'open', deliveryDeadline: NOW - 1 }, 'hire-lapsed'],
    ['board lapsed', { status: 'lapsed' }, 'hire-lapsed'],
    ['active', { status: 'active' }, 'active'],
    ['active at the deadline', { status: 'active', deliveryDeadline: NOW }, 'active'],
    ['active past the deadline', { status: 'active', deliveryDeadline: NOW - 1 }, 'overdue'],
    ['submitted, review open', { status: 'submitted', timely: true, reviewEndsAt: NOW + 60 }, 'in-review'],
    ['submitted, review ends now', { status: 'submitted', timely: true, reviewEndsAt: NOW }, 'in-review'],
    ['submitted, review passed', { status: 'submitted', timely: true, reviewEndsAt: NOW - 1 }, 'accepted-by-silence'],
    ['submitted late', { status: 'submitted', timely: false, reviewEndsAt: NOW + 60 }, 'delivered-late'],
    ['indexer submitted (no windows)', { status: 'submitted' }, 'in-review'],
    [
      'rejected, window open',
      { status: 'rejected-pending', disputeEndsAt: NOW + 60, violation: 'Quality' },
      'rejected-pending',
    ],
    ['rejected, window passed', { status: 'rejected-pending', disputeEndsAt: NOW - 1 }, 'rejection-final'],
    ['disputed', { status: 'disputed', arbitrationEndsAt: NOW + 60 }, 'disputed'],
    ['disputed, arbitrator late', { status: 'disputed', arbitrationEndsAt: NOW - 1 }, 'arbitration-lapsed'],
    ['completed', { status: 'completed' }, 'completed'],
    ['rejected', { status: 'rejected' }, 'rejected'],
    ['cancelled hire', { status: 'cancelled' }, 'cancelled'],
    ['expired hire', { status: 'expired' }, 'expired'],
    ['unknown', { status: 'unknown' }, 'unknown'],
  ]
  for (const [name, over, key] of cases) {
    it(name, () => expect(lifecycle(job(over), undefined, NOW).key).toBe(key))
  }
})

const actions = (over: Partial<LifecycleInput>, viewer: string) => lifecycle(job(over), viewer, NOW).actions

describe('actions follow the contracts', () => {
  it('the approver approves or rejects a timely submission in review', () => {
    expect(actions({ status: 'submitted', timely: true, reviewEndsAt: NOW + 60 }, APPROVER)).toEqual([
      'approve',
      'reject',
    ])
  })
  it('a late submission can be accepted, never rejected', () => {
    expect(actions({ status: 'submitted', timely: false }, APPROVER)).toEqual(['approve', 'settle'])
  })
  it('after the review window nobody rejects; anyone releases the payment', () => {
    expect(actions({ status: 'submitted', timely: true, reviewEndsAt: NOW - 1 }, APPROVER)).toEqual([
      'approve',
      'settle',
    ])
    expect(
      actions(
        { status: 'submitted', timely: true, reviewEndsAt: NOW - 1 },
        '0x9999999999999999999999999999999999999999',
      ),
    ).toEqual(['settle'])
  })
  it('the approver can reconsider a pending rejection, but not a disputed one', () => {
    expect(actions({ status: 'rejected-pending', disputeEndsAt: NOW + 60 }, APPROVER)).toEqual(['approve'])
    expect(actions({ status: 'disputed', arbitrationEndsAt: NOW + 60 }, APPROVER)).toEqual([])
  })
  it('the worker is never offered a browser action on a rejection (it disputes over MCP)', () => {
    expect(actions({ status: 'rejected-pending', disputeEndsAt: NOW + 60 }, WORKER)).toEqual([])
  })
  it('a visitor gets no actions, even permissionless ones', () => {
    expect(lifecycle(job({ status: 'active', deliveryDeadline: NOW - 1 }), undefined, NOW).actions).toEqual([])
  })
  it('the creator selects or cancels an open hire, and cancels a lapsed one', () => {
    expect(actions({ status: 'open' }, CREATOR)).toEqual(['select', 'cancel'])
    expect(actions({ status: 'lapsed' }, CREATOR)).toEqual(['cancel'])
  })
  it('a paused core or a mismatched listing offers nothing', () => {
    const p = lifecycle(job({ status: 'submitted', timely: true, reviewEndsAt: NOW + 60, paused: true }), APPROVER, NOW)
    expect(p.actions).toEqual([])
    expect(p.warnings[0]).toMatch(/Paused/)
    expect(lifecycle(job({ status: 'open', listingMatchesOffer: false }), CREATOR, NOW).actions).toEqual([])
  })
})

describe('who acts, and what they are told', () => {
  it.each(['active', 'submitted', 'rejected-pending'] as const)(
    '%s keeps timeout findings distinct from bond penalties at expiry',
    (status) => {
      const input = job({
        status,
        deliveryDeadline: NOW - 100,
        timely: false,
        violation: 'Quality',
        disputeEndsAt: NOW - 10,
        expiredAt: NOW,
      })
      const atExpiry = lifecycle(input, CREATOR, NOW)
      expect(phaseText(atExpiry.next)).toMatch(/bond is released/)
      expect(phaseText(atExpiry.next)).not.toMatch(/bond is sent to the treasury/)
      expect(phaseText(lifecycle(input, CREATOR, NOW - 1).next)).toMatch(/only if resolved before expiry/)
      expect(phaseText(lifecycle({ ...input, workerBond: '0' }, CREATOR, NOW).next)).not.toMatch(/bond/)
    },
  )

  it('silence is acceptance: the review sentence says so, with the deadline as a time', () => {
    const p = lifecycle(job({ status: 'submitted', timely: true, reviewEndsAt: NOW + 7200 }), APPROVER, NOW)
    expect(p.youAct).toBe(true)
    expect(p.deadline).toBe(NOW + 7200)
    expect(phaseText(p.toYou ?? [], () => 'T')).toBe(
      'Approve or reject by T. If you do nothing, the work is accepted and paid.',
    )
    expect(phaseText(p.next, () => 'T')).toMatch(/No answer by then counts as acceptance/)
  })
  it("a missed deadline is the creator's to close, and mentions the treasury slash only with a bond", () => {
    const p = lifecycle(job({ status: 'active', deliveryDeadline: NOW - 1 }), CREATOR, NOW)
    expect(p.youAct).toBe(true)
    expect(p.timeout).toBe('rejectAfterDeliveryDeadline')
    expect(phaseText(p.next)).toMatch(/bond is sent to the treasury/)
    expect(
      phaseText(lifecycle(job({ status: 'active', deliveryDeadline: NOW - 1, workerBond: '0' }), CREATOR, NOW).next),
    ).not.toMatch(/bond/)
  })
  it("an accepted-by-silence payment is the worker's to release", () => {
    const p = lifecycle(job({ status: 'submitted', timely: true, reviewEndsAt: NOW - 1 }), WORKER, NOW)
    expect(p.youAct).toBe(true)
    expect(p.beneficiary).toBe('worker')
  })
  it("warns when the viewer's own deadline is under two minutes away", () => {
    expect(
      lifecycle(job({ status: 'submitted', timely: true, reviewEndsAt: NOW + 90 }), APPROVER, NOW).warnings,
    ).toHaveLength(1)
    expect(
      lifecycle(job({ status: 'submitted', timely: true, reviewEndsAt: NOW + 90 }), CREATOR, NOW).warnings,
    ).toHaveLength(0)
  })
  it('terminal jobs with a reward still in escrow offer settle to anyone', () => {
    const p = lifecycle(
      job({ status: 'rejected', settlePending: true }),
      '0x9999999999999999999999999999999999999999',
      NOW,
    )
    expect(p.terminal).toBe(true)
    expect(p.actions).toEqual(['settle'])
  })
  it('roles compare addresses case-insensitively', () => {
    expect(lifecycle(job({ status: 'open' }), CREATOR.toUpperCase().replace('0X', '0x'), NOW).roles).toEqual([
      'creator',
    ])
  })
})

describe('quote requests', () => {
  const q = { quoteDeadline: NOW + 60, quotes: 3, picked: false, creator: CREATOR }
  it('taking quotes, then closed, then picked', () => {
    expect(quoteRequestPhase(q, CREATOR, NOW).key).toBe('quotes-open')
    expect(quoteRequestPhase({ ...q, quoteDeadline: NOW - 1 }, CREATOR, NOW).key).toBe('quotes-closed')
    expect(quoteRequestPhase({ ...q, picked: true }, CREATOR, NOW).key).toBe('quote-picked')
  })
  it('the creator can pick after quoting closes (pick_quote has no deadline)', () => {
    expect(quoteRequestPhase({ ...q, quoteDeadline: NOW - 1 }, CREATOR, NOW).actions).toEqual(['pick'])
    expect(quoteRequestPhase({ ...q, quoteDeadline: NOW - 1 }, WORKER, NOW).actions).toEqual([])
  })
})

describe('adapters', () => {
  it('reads an indexer row', () => {
    const input = lifecycleFromIndexed({
      status: 'active',
      creator: CREATOR,
      approver: APPROVER,
      worker: WORKER,
      delivery_deadline: NOW - 1,
      worker_bond: '1',
    })
    expect(lifecycle(input, CREATOR, NOW).key).toBe('overdue')
  })
  it('reads a board task', () => {
    const input = lifecycleFromTask({
      creator: CREATOR,
      approver: APPROVER,
      deliveryDeadline: NOW + 100,
      workerBond: '1',
      chain: {
        status: 'submitted',
        provider: WORKER,
        timely: true,
        submittedAt: NOW - 10,
        reviewEndsAt: NOW + 50,
        disputeEndsAt: null,
        arbitrationEndsAt: null,
        violation: null,
        listingMatchesOffer: true,
        paused: false,
      },
    })
    expect(lifecycle(input, APPROVER, NOW).key).toBe('in-review')
    expect(input.parties.worker).toBe(WORKER)
  })
})
