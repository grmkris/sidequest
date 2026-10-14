// What happens when someone does not deliver: a no-show is slashed by anyone and replaced by the seat's
// judge; a lead whose inputs never arrived is excused; a failed lead fails the job while paid helpers keep pay.
import { expect, test } from 'bun:test'
import { accept, channel, join, openJob, reassign, reject, roster, say, side, submit, usd } from '../src/flows'
import { DISPUTE_WINDOW, REVIEW_WINDOW } from '../src/chain'
import { solo } from '../src/shapes'
import { DAY, milestone, vrials } from './setup'

test('no-show: anyone slashes the missing helper, the lead re-staffs the seat, the job still completes', async () => {
  const { w, professor, lead, lit, data, jobId } = await milestone()
  await say(w, lit, jobId, 'ipfs://bafy-lit sha256:aa11', 'handoff')
  await submit(w, lit, jobId, 1, 'ipfs://bafy-lit')
  accept(w, lead, jobId, 1)

  w.chain.advance(2n * DAY + 1n)
  expect(() => w.chain.expireSeat(jobId, 1)).toThrow('seat not active')
  w.chain.expireSeat(jobId, 2) // no signature, no judgement: any keeper may call it
  expect(w.chain.job(jobId).seats[2].status).toBe('slashed')
  expect(w.chain.slashed.get(w.treasury.address)).toBe(side(100))
  expect(w.chain.feedback.find((f) => f.id === data.agentId)?.value).toBe(-1)

  const stand = await join(w, 'Backup', 'heidi')
  await expect(
    reassign(w, professor, {
      jobId,
      seat: 2,
      worker: stand.address,
      agentId: stand.agentId,
      deadline: w.chain.now + DAY,
    }),
  ).rejects.toThrow('judge') // helpers answer to the lead, not the Professor
  await reassign(w, lead, {
    jobId,
    seat: 2,
    worker: stand.address,
    agentId: stand.agentId,
    deadline: w.chain.now + DAY / 2n,
  })
  w.chain.activateSeat(jobId, 2, stand.address)
  // The replacement becomes a participant and reads the channel's history.
  expect(channel(w, stand, jobId).map((e) => e.content)).toEqual(['ipfs://bafy-lit sha256:aa11'])
  await say(w, stand, jobId, 'picking up the effect sizes', 'msg')
  await submit(w, stand, jobId, 2, 'ipfs://bafy-effects')
  accept(w, lead, jobId, 2)
  await submit(w, lead, jobId, 0, 'ipfs://bafy-map')
  accept(w, professor, jobId, 0)
  w.chain.closeJob(jobId)

  expect(w.chain.job(jobId).outcome).toBe('completed')
  expect(w.chain.balance(data.address)).toBe(0n)
  expect(w.chain.balance(stand.address)).toBe(usd(180))
  expect(w.chain.job(jobId).seats[2].pastWorkers).toEqual([data.address])
})

test('blocked lead: inputs never arrived, so its deadline excuses rather than slashes; the Professor gets the rest back', async () => {
  const { w, professor, lead, lit, jobId } = await milestone()
  await submit(w, lit, jobId, 1, 'ipfs://bafy-lit')
  accept(w, lead, jobId, 1)
  w.chain.advance(3n * DAY + 1n)
  w.chain.expireSeat(jobId, 2) // the data helper no-showed
  w.chain.expireSeat(jobId, 0) // the lead never had its inputs
  expect(w.chain.job(jobId).seats[0].status).toBe('excused')
  expect(w.chain.stakeOf(lead.address).reserved).toBe(0n)
  w.chain.closeJob(jobId)
  expect(w.chain.job(jobId).outcome).toBe('failed')
  expect(w.chain.balance(professor.address)).toBe(usd(5_000) - usd(300)) // paid only the literature seat
  expect(w.chain.balance(lit.address)).toBe(usd(270))
})

test("failed lead: helpers keep their pay, the lead's bond is slashed, its reward returns to the Professor", async () => {
  const { w, professor, lead, lit, data, jobId } = await milestone()
  await submit(w, lit, jobId, 1, 'ipfs://bafy-lit')
  accept(w, lead, jobId, 1)
  await submit(w, data, jobId, 2, 'ipfs://bafy-effects')
  accept(w, lead, jobId, 2)
  await submit(w, lead, jobId, 0, 'ipfs://bafy-thin-summary')
  reject(w, professor, jobId, 0)
  expect(() => w.chain.finalizeRejection(jobId, 0)).toThrow('dispute window open')
  w.chain.advance(DISPUTE_WINDOW + 1n)
  w.chain.finalizeRejection(jobId, 0)
  w.chain.closeJob(jobId)

  expect(w.chain.job(jobId).outcome).toBe('failed')
  expect(w.chain.balance(lit.address)).toBe(usd(270))
  expect(w.chain.balance(data.address)).toBe(usd(180))
  expect(w.chain.balance(lead.address)).toBe(0n)
  expect(w.chain.balance(professor.address)).toBe(usd(5_000) - usd(500))
  expect(REVIEW_WINDOW).toBeGreaterThan(0n)
})

test('untaken seat: after activateBy the creator re-staffs a seat its worker never accepted', async () => {
  const { w, professor } = await vrials()
  const a = await join(w, 'Solo', 'ivan')
  const b = await join(w, 'Other', 'judy')
  const deadline = w.chain.now + DAY
  const r = roster(w, solo('summary'), [{ index: 0, worker: a.address, agentId: a.agentId, price: usd(100) }], {
    jobId: `0x${'33'.repeat(32)}`,
    creator: professor,
    deadlines: [deadline],
    bond: side(1),
  })
  await openJob(w, professor, r)
  const terms = { jobId: r.jobId, seat: 0, worker: b.address, agentId: b.agentId, deadline }
  await expect(reassign(w, professor, terms)).rejects.toThrow('cannot be reassigned') // a still has until activateBy
  w.chain.advance(601n)
  await reassign(w, professor, terms)
  w.chain.activateSeat(r.jobId, 0, b.address)
  expect(w.chain.job(r.jobId).status).toBe('active')
})
