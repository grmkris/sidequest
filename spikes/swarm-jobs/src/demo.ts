// `bun run demo`: one Vrials milestone end to end, printed as a story.
// Robinhood funding → private quotes from a swarm → coordination on Nostr → an unfair rejection
// overturned by the signed transcript → a no-show slashed and replaced → settlement and reputation.
import { formatUnits } from 'viem'
import { makeActor } from './actors'
import {
  accept,
  arbitrate,
  channel,
  join,
  makeWorld,
  openJob,
  postRequest,
  readQuotes,
  readRequests,
  reassign,
  reject,
  roster,
  say,
  sendQuote,
  side,
  submit,
  usd,
} from './flows'
import { leadHelpers } from './shapes'

const step = (s: string) => console.log(`\n▸ ${s}`)
const note = (s: string) => console.log(`  ${s}`)
const $ = (v: bigint) => `$${formatUnits(v, 6)}`
const DAY = 86_400n

const w = await makeWorld()
const professor = await join(w, 'Professor', 'vrials', side(10_000_000))
const vrialsTreasury = makeActor('Vrials treasury', 'vrials')
w.rh.mint(vrialsTreasury.address, usd(10_000))

step('Vrials funds its Professor: USDG on Robinhood Chain → USDC on Monad')
const d = w.bridge.fill(w.bridge.send(vrialsTreasury.address, professor.address, usd(2_000)).id)
note(`deposit #${d.id} filled: Professor holds ${$(w.chain.balance(professor.address))} on Monad`)

step('Three owners form a swarm: one identity, three agents')
const lead = await join(w, 'Synth', 'erin')
const lit = await join(w, 'Scout', 'frank')
const data = await join(w, 'Extractor', 'grace')
const swarmId = w.chain.registerSwarm(lead.address, 'Peptide Lab', [lead.agentId, lit.agentId, data.agentId])
note(`swarm #${swarmId} "Peptide Lab": agents ${lead.agentId}, ${lit.agentId}, ${data.agentId}`)

step('The Professor publishes a request with a lead + helpers shape (public Nostr event)')
const shape = leadHelpers('synthesis', ['literature', 'data'])
await postRequest(w, professor, shape, 'Milestone 1: evidence map for BPC-157 tendon healing', usd(1_000))
const req = readRequests(w)[0]
note(`request ${req.requestId.slice(0, 10)}… · ${req.shape.seats.map((s) => s.role).join(' + ')}`)

step('The swarm quotes the whole shape privately (gift-wrapped DM, EIP-712 signed inside)')
const offers = [
  { index: 0, worker: lead.address, agentId: lead.agentId, price: usd(500) },
  { index: 1, worker: lit.address, agentId: lit.agentId, price: usd(300) },
  { index: 2, worker: data.address, agentId: data.agentId, price: usd(200) },
]
await sendQuote(w, lead, req.creatorPk, {
  requestId: req.requestId,
  quoter: lead.address,
  swarmId,
  offers,
  expiry: w.chain.now + 3_600n,
})
const quotes = await readQuotes(w, professor)
note(
  `relay stores ${w.relay.giftWrapsFor(professor.nostrPk).length} sealed event; the Professor reads ${quotes.length} verified quote`,
)

step('The Professor signs the roster; the job opens on Monad with one creator bond; each member accepts its seat')
const now = w.chain.now
const r = roster(w, shape, quotes[0].offers, {
  jobId: req.requestId,
  creator: professor,
  swarmId,
  deadlines: [now + 3n * DAY, now + 2n * DAY, now + 2n * DAY],
  bond: side(100),
})
await openJob(w, professor, r)
const jobId = req.requestId
for (const [i, a] of [lead, lit, data].entries()) w.chain.activateSeat(jobId, i, a.address)
note(`escrow ${$(w.chain.job(jobId).escrow)} · status ${w.chain.job(jobId).status}`)

step("They coordinate in the job channel (relay-gated to the job's on-chain participants)")
await say(w, lead, jobId, '@Scout human + animal tendon studies since 2015. @Extractor effect-size table.', 'assign')
await say(w, lit, jobId, 'ipfs://bafy-lit sha256:aa11', 'handoff')
await submit(w, lit, jobId, 1, 'ipfs://bafy-lit')
await say(w, lead, jobId, 'Perfect, merging this into the map.')
note(`${channel(w, professor, jobId).length} signed messages; Scout's submission checkpoints the transcript on-chain`)

step("The lead rejects Scout's work on-chain despite approving it in the channel; Scout disputes")
reject(w, lead, jobId, 1)
w.chain.dispute(jobId, 1, lit.address)
const ruling = await arbitrate(w, jobId, 1, channel(w, lit, jobId), (msgs) =>
  msgs.some((m) => w.relay.walletOf(m.pubkey) === lead.address && m.content.startsWith('Perfect')),
)
note(`arbitrator verified the transcript against the lead's own checkpoint → worker wins: ${ruling.workerWins}`)

step('Extractor never delivers: after its deadline anyone slashes it; the lead re-staffs the seat')
w.chain.advance(2n * DAY + 1n)
w.chain.expireSeat(jobId, 2)
const backup = await join(w, 'Backup', 'heidi')
await reassign(w, lead, {
  jobId,
  seat: 2,
  worker: backup.address,
  agentId: backup.agentId,
  deadline: w.chain.now + DAY / 2n,
})
w.chain.activateSeat(jobId, 2, backup.address)
await submit(w, backup, jobId, 2, 'ipfs://bafy-effects')
accept(w, lead, jobId, 2)
note(`Extractor's ${formatUnits(side(100), 18)} SIDE bond slashed; Backup delivered and was paid`)

step('The lead delivers the synthesis, the Professor accepts, the job closes')
await submit(w, lead, jobId, 0, 'ipfs://bafy-evidence-map')
accept(w, professor, jobId, 0)
w.chain.closeJob(jobId)
note(`outcome: ${w.chain.job(jobId).outcome}`)

step('Balances and reputation')
for (const a of [professor, lead, lit, data, backup])
  note(`${a.name.padEnd(10)} ${$(w.chain.balance(a.address)).padStart(10)}`)
note(
  `${'treasury'.padEnd(10)} ${$(w.chain.balance(w.treasury.address)).padStart(10)} in fees · ${formatUnits(w.chain.slashed.get(w.treasury.address) ?? 0n, 18)} SIDE slashed`,
)
const rep = (subject: 'agent' | 'swarm', id: bigint) =>
  w.chain.feedback.filter((f) => f.subject === subject && f.id === id).reduce((s, f) => s + f.value, 0)
note(
  `swarm #${swarmId} feedback ${rep('swarm', swarmId)} · Extractor ${rep('agent', data.agentId)} · Backup ${rep('agent', backup.agentId)}`,
)
