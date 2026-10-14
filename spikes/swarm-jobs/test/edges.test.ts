// The edges: the relay going down, money arriving from Robinhood Chain, and who may speak for whom.
import { expect, test } from 'bun:test'
import * as nip17 from 'nostr-tools/nip17'
import { finalizeEvent } from 'nostr-tools/pure'
import { KIND, linkEvent, makeActor } from '../src/actors'
import { REVIEW_WINDOW } from '../src/chain'
import { accept, channel, join, makeWorld, readQuotes, say, submit, usd } from '../src/flows'
import { RelayDown } from '../src/relay'
import { sign } from '../src/typed'
import { DAY, milestone, vrials } from './setup'

test('relay outage: deadlines, silence and slashing still settle from the chain alone', async () => {
  const { w, professor, lead, lit, data, jobId } = await milestone()
  await say(w, lead, jobId, 'go')
  const seen = channel(w, lit, jobId) // each party keeps its own copy
  w.relay.down = true
  expect(() => channel(w, lit, jobId)).toThrow(RelayDown)

  await submit(w, lit, jobId, 1, 'ipfs://bafy-lit', seen)
  await submit(w, data, jobId, 2, 'ipfs://bafy-effects', seen)
  // The lead is offline too and never judges: silence becomes acceptance.
  w.chain.advance(REVIEW_WINDOW + 1n)
  w.chain.finalizeSilence(jobId, 1)
  w.chain.finalizeSilence(jobId, 2)
  // The lead never delivers: after its deadline anyone slashes it.
  w.chain.advance(3n * DAY)
  w.chain.expireSeat(jobId, 0)
  w.chain.closeJob(jobId)

  expect(w.chain.job(jobId).outcome).toBe('failed')
  expect(w.chain.balance(lit.address)).toBe(usd(270))
  expect(w.chain.balance(data.address)).toBe(usd(180))
  expect(w.chain.balance(professor.address)).toBe(usd(5_000) - usd(500))
  expect(w.chain.job(jobId).seats[0].status).toBe('slashed')
})

test("funding from Robinhood Chain: USDG becomes the Professor's USDC on Monad; a failed transfer refunds and touches no job", async () => {
  const { w, professor } = await vrials()
  const treasury = makeActor('Vrials treasury', 'vrials')
  w.rh.mint(treasury.address, usd(10_000))

  const ok = w.bridge.send(treasury.address, professor.address, usd(2_000))
  expect(w.chain.balance(professor.address)).toBe(usd(5_000))
  w.bridge.fill(ok.id)
  expect(w.chain.balance(professor.address)).toBe(usd(5_000) + usd(1_999))

  const stuck = w.bridge.send(treasury.address, professor.address, usd(1_000))
  w.bridge.refund(stuck.id)
  expect(w.rh.balance(treasury.address)).toBe(usd(8_000)) // 10k − 2k bridged; the stuck 1k came back
  expect(w.chain.jobs.size).toBe(0)
})

test("identity: a Nostr key speaks for a wallet only with that wallet's signature and the registry's agreement", async () => {
  const w = await makeWorld()
  const alice = await join(w, 'Alice', 'alice')
  const eve = makeActor('Eve', 'eve')

  // Eve claims Alice's agent: her Nostr key, Alice's agentId and wallet, signed by Eve's wallet.
  eve.agentId = alice.agentId
  const claim = await linkEvent({ ...eve, address: alice.address }, 1)
  await expect(w.relay.publish(claim)).rejects.toThrow('not signed by the wallet')

  // An unregistered agentId is refused even when the wallet signed.
  eve.agentId = 99_999n
  await expect(w.relay.publish(await linkEvent(eve, 1))).rejects.toThrow('not the registered agent wallet')

  // An unlinked key cannot post a public request.
  const request = finalizeEvent({ kind: KIND.REQUEST, created_at: 1, tags: [['d', 'x']], content: '{}' }, eve.nostrSk)
  await expect(w.relay.publish(request)).rejects.toThrow('unlinked key')
})

test("a quote signed by one wallet but sent from another agent's Nostr key is dropped", async () => {
  const { w, professor } = await vrials()
  const alice = await join(w, 'Alice', 'alice')
  const bob = await join(w, 'Bob', 'bob')
  const quote = {
    requestId: `0x${'22'.repeat(32)}` as const,
    quoter: alice.address,
    swarmId: 0n,
    offers: [{ index: 0, worker: alice.address, agentId: alice.agentId, price: usd(10) }],
    expiry: 0n,
  }
  const sig = await sign(alice.account, 'Quote', quote)
  const body = JSON.stringify({ quote, sig }, (_, x) => (typeof x === 'bigint' ? { $big: x.toString() } : x))
  await w.relay.publish(nip17.wrapEvent(bob.nostrSk, { publicKey: professor.nostrPk }, body))
  expect(await readQuotes(w, professor)).toHaveLength(0)
})
