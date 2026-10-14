// A swarm quotes a whole shape as one identity; its three members of three owners each accept their own
// seat, coordinate in the job channel and are paid straight to their own wallets.
import { expect, test } from 'bun:test'
import { accept, channel, join, openJob, roster, say, side, submit, usd } from '../src/flows'
import { leadHelpers } from '../src/shapes'
import { DAY, milestone, totalUsd, vrials } from './setup'

test('swarm milestone: one quote for the shape, coordination in the channel, direct pay, swarm and member reputation', async () => {
  const { w, professor, lead, lit, data, jobId, swarmId } = await milestone(true)
  const before = totalUsd(w)
  expect(w.chain.job(jobId).swarmId).toBe(swarmId as bigint)

  await say(
    w,
    lead,
    jobId,
    '@Scout: human + animal tendon studies since 2015. @Extractor: effect sizes table.',
    'assign',
  )
  await say(w, lit, jobId, 'ipfs://bafy-lit-review sha256:aa11', 'handoff')
  await submit(w, lit, jobId, 1, 'ipfs://bafy-lit-review')
  accept(w, lead, jobId, 1)
  await say(w, data, jobId, 'ipfs://bafy-effects sha256:bb22', 'handoff')
  // The lead cannot deliver before its inputs are in.
  await expect(submit(w, lead, jobId, 0, 'too early')).rejects.toThrow('waiting on seats 2')
  await submit(w, data, jobId, 2, 'ipfs://bafy-effects')
  accept(w, lead, jobId, 2)
  await submit(w, lead, jobId, 0, 'ipfs://bafy-evidence-map')
  accept(w, professor, jobId, 0)
  w.chain.closeJob(jobId)

  expect(w.chain.job(jobId).outcome).toBe('completed')
  expect(w.chain.balance(lead.address)).toBe(usd(450))
  expect(w.chain.balance(lit.address)).toBe(usd(270))
  expect(w.chain.balance(data.address)).toBe(usd(180))
  expect(w.chain.feedback.filter((f) => f.subject === 'swarm' && f.value === 1)).toHaveLength(3)
  expect(w.chain.feedback.filter((f) => f.subject === 'agent' && f.value === 1)).toHaveLength(3)
  expect(channel(w, professor, jobId).map((e) => e.tags.find((t) => t[0] === 't')?.[1])).toEqual([
    'assign',
    'handoff',
    'handoff',
  ])
  expect(totalUsd(w)).toBe(before)
})

test('a swarm job refuses a seat filled by an agent outside the swarm', async () => {
  const { w, professor } = await vrials()
  const lead = await join(w, 'Synth', 'erin')
  const lit = await join(w, 'Scout', 'frank')
  const stranger = await join(w, 'Stranger', 'zed')
  const swarmId = w.chain.registerSwarm(lead.address, 'Pair', [lead.agentId, lit.agentId])
  const shape = leadHelpers('synthesis', ['literature'])
  const deadline = w.chain.now + DAY
  const r = roster(
    w,
    shape,
    [
      { index: 0, worker: lead.address, agentId: lead.agentId, price: usd(100) },
      { index: 1, worker: stranger.address, agentId: stranger.agentId, price: usd(100) },
    ],
    { jobId: `0x${'11'.repeat(32)}`, creator: professor, swarmId, deadlines: [deadline, deadline], bond: side(1) },
  )
  await expect(openJob(w, professor, r)).rejects.toThrow('not a swarm member')
})
