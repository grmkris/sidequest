// Vrials intake: three reviewers of three owners and an aggregator, quoted privately, committing on-chain
// before anyone may see another's review.
import { expect, test } from 'bun:test'
import {
  accept,
  channel,
  commitment,
  join,
  openJob,
  postRequest,
  readQuotes,
  readRequests,
  roster,
  say,
  sendQuote,
  side,
  submit,
  usd,
  verifiedReveals,
} from '../src/flows'
import { panel, shapeHash } from '../src/shapes'
import { DAY, totalUsd, vrials } from './setup'

test('intake panel: private quotes, commit before reveal, aggregator judges reviewers, Professor judges the verdict', async () => {
  const { w, professor } = await vrials()
  const reviewers = [
    await join(w, 'Methodologist', 'alice'),
    await join(w, 'Ethicist', 'bob'),
    await join(w, 'Novelty', 'carol'),
  ]
  const aggregator = await join(w, 'Verdict', 'dave')
  const outsider = await join(w, 'Lurker', 'mallory')
  const minted = totalUsd(w)

  const shape = panel(['methodology', 'safety', 'novelty'])
  await postRequest(w, professor, shape, 'Intake: BPC-157 tendon-healing protocol', usd(250))
  const req = readRequests(w)[0]
  expect(req.shapeHash).toBe(shapeHash(shape))

  const expiry = w.chain.now + 3_600n
  for (const [i, r] of [...reviewers, aggregator].entries()) {
    const price = i === 3 ? usd(100) : usd(50)
    await sendQuote(w, r, req.creatorPk, {
      requestId: req.requestId,
      quoter: r.address,
      swarmId: 0n,
      offers: [{ index: i, worker: r.address, agentId: r.agentId, price }],
      expiry,
    })
  }
  // The relay stores four gift wraps whose visible authors are throwaway keys, not the quoters.
  const wraps = w.relay.giftWrapsFor(professor.nostrPk)
  expect(wraps).toHaveLength(4)
  expect(wraps.some((e) => [...reviewers, aggregator].some((r) => r.nostrPk === e.pubkey))).toBe(false)

  const quotes = await readQuotes(w, professor)
  expect(quotes).toHaveLength(4)
  const deadline = w.chain.now + DAY
  const r = roster(
    w,
    shape,
    quotes.flatMap((q) => q.offers),
    {
      jobId: req.requestId,
      creator: professor,
      deadlines: [deadline, deadline, deadline, deadline + 3_600n],
      bond: side(50),
    },
  )
  await openJob(w, professor, r)
  const jobId = req.requestId
  for (const [i, a] of [...reviewers, aggregator].entries()) w.chain.activateSeat(jobId, i, a.address)
  expect(w.chain.job(jobId).status).toBe('active')

  // The channel is private to the job's participants.
  expect(() => channel(w, outsider, jobId)).toThrow('not a participant')
  await expect(say(w, outsider, jobId, 'let me in')).rejects.toThrow('not a participant')
  await say(w, aggregator, jobId, 'Score 1-5 on your axis, one paragraph, commit before revealing.')

  const reviews = [
    'methodology 3/5: n=12 is underpowered',
    'safety 4/5: no dosing claims, consent ok',
    'novelty 4/5: first human tendon data',
  ]
  await submit(w, reviewers[0], jobId, 0, commitment(reviews[0], 's0'))
  await submit(w, reviewers[1], jobId, 1, commitment(reviews[1], 's1'))
  // Novelty has not committed yet, so nobody may reveal.
  await expect(say(w, reviewers[0], jobId, commitment(reviews[0], 's0'), 'reveal')).rejects.toThrow('not committed')
  await submit(w, reviewers[2], jobId, 2, commitment(reviews[2], 's2'))
  for (const [i, rv] of reviewers.entries()) await say(w, rv, jobId, commitment(reviews[i], `s${i}`), 'reveal')

  const reveals = verifiedReveals(w, aggregator, jobId)
  expect(reveals.map((x) => x.ok)).toEqual([true, true, true])

  await submit(w, aggregator, jobId, 3, 'verdict: proceed with conditions (mean 3.7/5)')
  for (const i of [0, 1, 2]) accept(w, aggregator, jobId, i)
  expect(() => accept(w, reviewers[0], jobId, 3)).toThrow("only the seat's judge")
  accept(w, professor, jobId, 3)
  w.chain.closeJob(jobId)

  const job = w.chain.job(jobId)
  expect(job.outcome).toBe('completed')
  for (const rv of reviewers) expect(w.chain.balance(rv.address)).toBe(usd(45))
  expect(w.chain.balance(aggregator.address)).toBe(usd(90))
  expect(w.chain.balance(w.treasury.address)).toBe(usd(25))
  expect(w.chain.balance(professor.address)).toBe(usd(4_750))
  expect(w.chain.stakeOf(professor.address).reserved).toBe(0n)
  expect(w.chain.feedback.filter((f) => f.value === 1)).toHaveLength(4)
  expect(totalUsd(w)).toBe(minted)
})
