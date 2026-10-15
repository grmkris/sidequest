import { describe, expect, it } from 'vitest'
import type { FeedEvent, FeedJob } from '../../activity-feed.ts'
import type { ChainJob } from '../../api.ts'
import { paidTotal, railTurns, settlementsOf } from './live-rail.ts'

const SIDE = '0x7A07aA88861f3f2Cfb34ED5BEC8F05dAc4Fd7777'
const DESK: `0x${string}` = '0x4e251ca0d1ee8d2e445a7ebf798969858368e263'
const firstParty = { addresses: [DESK], agents: ['10401', '10404'], demoJobs: [] }

const chainJob = (creator: string): ChainJob => ({
  job_id: '10',
  stack: 'main',
  kind: 'sidequest-v1',
  mode: 'hire',
  status: 'completed',
  creator,
  approver: null,
  token: null,
  reward: null,
  creator_bond: '0',
  worker_bond: '0',
  worker: null,
  agent_id: null,
  delivery_deadline: null,
  selection_deadline: null,
  deliverable: null,
  violation: null,
  published_tx: null,
})

const job = (creator: string, posterAgent: string | null = null): FeedJob => ({
  key: 'j',
  item: { jobId: '10', task: undefined, chain: chainJob(creator) },
  phase: null,
  bucket: null,
  posterAgent,
  workerAgent: null,
  requested: null,
  steps: [],
  latestAt: null,
  stepped: true,
})

const event = (overrides: Partial<FeedEvent> = {}): FeedEvent => ({
  key: `k-${overrides.jobId ?? '10'}-${overrides.kind ?? 'completed'}`,
  kind: 'completed',
  at: 1_792_038_387,
  jobId: '10',
  requestId: null,
  title: 'T2 capability cards',
  agentId: '10401',
  token: SIDE,
  amount: '90000000000000000000000',
  job: job(DESK),
  ...overrides,
})

/** A completion whose step carries no amount. */
function unpaid(jobId: string): FeedEvent {
  const { amount: _, ...rest } = event({ jobId })
  return rest
}

describe('the live rail', () => {
  it('turns only paid completions with a named worker into settlements, newest first, five at most', () => {
    const events = [
      event({ kind: 'delivered', jobId: '11' }),
      event(),
      event({ jobId: '9', agentId: null }),
      event({ jobId: '8', amount: '0' }),
      unpaid('7'),
      ...['6', '5', '4', '3', '2'].map((jobId) => event({ jobId })),
    ]
    expect(settlementsOf(events, firstParty).map((s) => s.jobId)).toEqual(['10', '6', '5', '4', '3'])
    expect(settlementsOf(events, firstParty, 2)).toHaveLength(2)
  })

  it('says Sidequest paid when its own wallet or agent posted the job, and discloses a related party', () => {
    const [own] = settlementsOf([event()], firstParty)
    expect(own).toMatchObject({
      payer: 'sidequest',
      related: true,
      agentId: '10401',
      amount: '90000000000000000000000',
    })
    const [byAgent] = settlementsOf([event({ job: job('0xabc', '10404'), agentId: '2001' })], firstParty)
    expect(byAgent).toMatchObject({ payer: 'sidequest', related: false })
  })

  it('names any other poster as Activity does, and no one when the job is not loaded', () => {
    const [stranger] = settlementsOf([event({ job: job('0x00000000000000000000000000000000000000aa') })], firstParty)
    expect(stranger).toMatchObject({ payer: { wallet: '0x00000000000000000000000000000000000000aa' }, related: false })
    const [agent] = settlementsOf([event({ job: job('0xabc', '2050') })], firstParty)
    expect(agent?.payer).toEqual({ agent: '2050' })
    expect(settlementsOf([event({ job: undefined })], firstParty)[0]?.payer).toBeNull()
  })

  it('holds still for one settlement, for reduced motion, and while it is being read', () => {
    expect(railTurns({ count: 3, reducedMotion: false, held: false })).toBe(true)
    expect(railTurns({ count: 1, reducedMotion: false, held: false })).toBe(false)
    expect(railTurns({ count: 3, reducedMotion: true, held: false })).toBe(false)
    expect(railTurns({ count: 3, reducedMotion: false, held: true })).toBe(false)
  })

  it('totals SIDE when the board paid any, else its largest token, and nothing before a payout', () => {
    const usdc = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'
    expect(paidTotal({ [usdc]: '9', [SIDE]: '562000000000000000000000' }, SIDE.toLowerCase())).toEqual({
      token: SIDE,
      amount: 562_000n * 10n ** 18n,
    })
    expect(paidTotal({ [usdc]: '9000000', '0x01': '5' }, SIDE)).toEqual({ token: usdc, amount: 9_000_000n })
    expect(paidTotal({ [SIDE]: '0' }, SIDE)).toBeNull()
    expect(paidTotal({}, SIDE)).toBeNull()
  })
})
