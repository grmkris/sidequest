// The channel is evidence: a lead approves in chat, then rejects on-chain. The worker disputes and hands
// the arbitrator its copy of the channel, which must reproduce a root the chain recorded.
import { expect, test } from 'bun:test'
import { finalizeEvent } from 'nostr-tools/pure'
import { KIND } from '../src/actors'
import { arbitrate, channel, reject, say, submit, usd } from '../src/flows'
import { verifyTranscript } from '../src/relay'
import { milestone } from './setup'

test("unfair rejection: the signed transcript proves the lead's approval and the arbitrator pays the worker", async () => {
  const { w, lead, lit, jobId } = await milestone()
  await say(w, lit, jobId, 'ipfs://bafy-lit sha256:aa11', 'handoff')
  await submit(w, lit, jobId, 1, 'ipfs://bafy-lit')
  await say(w, lead, jobId, 'Perfect, merging this into the map.')
  reject(w, lead, jobId, 1) // the lead tries to keep the helper's share
  w.chain.dispute(jobId, 1, lit.address)

  const evidence = channel(w, lit, jobId)
  const job = w.chain.job(jobId)
  const rejectCp = job.checkpoints.find((c) => c.seat === 1 && c.kind === 'reject')
  expect(rejectCp && verifyTranscript(evidence, jobId, rejectCp)).toBe(true)

  // Dropping the incriminating message no longer reproduces the lead's own checkpoint.
  const dropped = evidence.filter((e) => !e.content.startsWith('Perfect'))
  expect(rejectCp && verifyTranscript(dropped, jobId, rejectCp)).toBe(false)
  // A rewritten message fails too, even when re-signed by a party in the job.
  const forged = evidence.map((e) =>
    e.content.startsWith('Perfect')
      ? finalizeEvent(
          { kind: KIND.CHANNEL, created_at: e.created_at, tags: e.tags, content: 'Rejected: plagiarised.' },
          lead.nostrSk,
        )
      : e,
  )
  expect(rejectCp && verifyTranscript(forged, jobId, rejectCp)).toBe(false)

  const leadWallet = lead.address
  const ruling = await arbitrate(w, jobId, 1, evidence, (msgs) =>
    msgs.some((m) => w.relay.walletOf(m.pubkey) === leadWallet && m.content.startsWith('Perfect')),
  )
  expect(ruling.workerWins).toBe(true)
  expect(ruling.transcriptRoot).toBe(rejectCp?.root as `0x${string}`)
  expect(w.chain.job(jobId).seats[1].status).toBe('paid')
  expect(w.chain.balance(lit.address)).toBe(usd(270))
})

test('a ruling must cite a transcript root the chain recorded for that seat', async () => {
  const { w, lead, lit, jobId } = await milestone()
  await say(w, lit, jobId, 'ipfs://bafy-lit sha256:aa11', 'handoff')
  await submit(w, lit, jobId, 1, 'ipfs://bafy-lit')
  reject(w, lead, jobId, 1)
  w.chain.dispute(jobId, 1, lit.address)
  const unrelated = [
    finalizeEvent({ kind: KIND.CHANNEL, created_at: 1, tags: [['job', jobId]], content: 'x' }, lit.nostrSk),
  ]
  await expect(arbitrate(w, jobId, 1, unrelated, () => true)).rejects.toThrow('matches no checkpoint')
})
