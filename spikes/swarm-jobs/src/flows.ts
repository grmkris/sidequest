// The steps an app (Vrials) or an agent would take, wired across the chain stub, the relay and signatures.
// Tests and the demo compose these; nothing here holds authority the chain does not check.
import * as nip17 from 'nostr-tools/nip17'
import { type NostrEvent, finalizeEvent } from 'nostr-tools/pure'
import { type Hex, isAddressEqual, keccak256, toHex } from 'viem'
import { type Actor, KIND, linkEvent, makeActor } from './actors'
import { MIN_CREATOR_BOND, Monad } from './chain'
import { Relay, transcriptRoot, verifyTranscript } from './relay'
import { Bridge, Robinhood } from './robinhood'
import { type Shape, shapeHash } from './shapes'
import { type Quote, type Reassign, type Roster, type Ruling, type SeatOffer, sign, signer } from './typed'

export const usd = (n: number) => BigInt(Math.round(n * 1e6))
export const side = (n: number) => BigInt(n) * 10n ** 18n

const stringify = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? { $big: x.toString() } : x))
const parse = <T>(s: string): T =>
  JSON.parse(s, (_, x) => (x && typeof x === 'object' && '$big' in x ? BigInt(x.$big) : x)) as T

export interface World {
  chain: Monad
  relay: Relay
  rh: Robinhood
  bridge: Bridge
  treasury: Actor
  arbitrator: Actor
}

export async function makeWorld(): Promise<World> {
  const treasury = makeActor('Sidequest treasury', 'sidequest')
  const arbitrator = makeActor('Arbiter', 'sidequest')
  const chain = new Monad(treasury.address, treasury.address)
  const relay = new Relay(chain)
  const rh = new Robinhood()
  const w = { chain, relay, rh, bridge: new Bridge(rh, chain), treasury, arbitrator }
  await relay.publish(await linkEvent(arbitrator, now(w)))
  return w
}

const now = (w: Pick<World, 'chain'>) => Number(w.chain.now)

// Registers an ERC-8004 identity, stakes SIDE for bonds and links the Nostr key.
export async function join(w: World, name: string, owner: string, stake = side(1_000)) {
  const a = makeActor(name, owner)
  a.agentId = w.chain.registerAgent(a.address)
  w.chain.depositStake(a.address, stake)
  await w.relay.publish(await linkEvent(a, now(w)))
  return a
}

// ---- request and quotes -------------------------------------------------------------------------

export async function postRequest(w: World, creator: Actor, shape: Shape, brief: string, budget: bigint) {
  const requestId = keccak256(toHex(`${creator.address}:${brief}:${w.chain.now}`))
  const event = finalizeEvent(
    {
      kind: KIND.REQUEST,
      created_at: now(w),
      tags: [
        ['d', requestId],
        ['shape', shape.name],
      ],
      content: stringify({ brief, budget, shape, shapeHash: shapeHash(shape) }),
    },
    creator.nostrSk,
  )
  await w.relay.publish(event)
  return requestId
}

export function readRequests(w: World) {
  return w.relay.requests().map((e) => ({
    requestId: e.tags.find((t) => t[0] === 'd')?.[1] as Hex,
    creatorPk: e.pubkey,
    ...parse<{ brief: string; budget: bigint; shape: Shape; shapeHash: Hex }>(e.content),
  }))
}

// A quote travels gift-wrapped to the creator: the relay sees neither sender nor price. Gift-wrapped
// rumors are deniable by design, so the quote carries its own EIP-712 signature as evidence.
export async function sendQuote(w: World, from: Actor, creatorPk: string, quote: Quote) {
  const sig = await sign(from.account, 'Quote', quote)
  await w.relay.publish(nip17.wrapEvent(from.nostrSk, { publicKey: creatorPk }, stringify({ quote, sig })))
}

export async function readQuotes(w: World, creator: Actor) {
  const quotes: Quote[] = []
  for (const wrap of w.relay.giftWrapsFor(creator.nostrPk)) {
    const rumor = nip17.unwrapEvent(wrap, creator.nostrSk)
    const { quote, sig } = parse<{ quote: Quote; sig: Hex }>(rumor.content)
    const quoter = await signer('Quote', quote, sig)
    const wire = w.relay.walletOf(rumor.pubkey)
    if (!isAddressEqual(quoter, quote.quoter) || !wire || !isAddressEqual(wire, quoter)) continue
    quotes.push(quote)
  }
  return quotes
}

// ---- selection ----------------------------------------------------------------------------------

export interface RosterTerms {
  jobId: Hex
  creator: Actor
  swarmId?: bigint
  deadlines: bigint[]
  bond: bigint
}

export function roster(w: World, shape: Shape, picks: SeatOffer[], t: RosterTerms): Roster {
  return {
    jobId: t.jobId,
    creator: t.creator.address,
    shapeHash: shapeHash(shape),
    swarmId: t.swarmId ?? 0n,
    arbitrator: w.arbitrator.address,
    activateBy: w.chain.now + 600n,
    seats: shape.seats.map((spec, i) => {
      const pick = picks.find((p) => p.index === i)
      if (!pick) throw new Error(`no pick for seat ${i}`)
      return {
        index: i,
        role: spec.role,
        worker: pick.worker,
        agentId: pick.agentId,
        reward: pick.price,
        bond: t.bond,
        deadline: t.deadlines[i],
        judgeSeat: spec.judgeSeat,
        dependsOn: spec.dependsOn,
        required: spec.required,
      }
    }),
  }
}

export async function openJob(w: World, creator: Actor, r: Roster, bond = MIN_CREATOR_BOND) {
  await w.chain.openJob(r, await sign(creator.account, 'Roster', r), bond)
}

// ---- the job channel ----------------------------------------------------------------------------

export async function say(w: World, who: Actor, jobId: Hex, content: string, t = 'msg', extra: string[][] = []) {
  const event = finalizeEvent(
    { kind: KIND.CHANNEL, created_at: now(w), tags: [['job', jobId], ['t', t], ...extra], content },
    who.nostrSk,
  )
  await w.relay.publish(event)
  return event
}

export const channel = (w: World, who: Actor, jobId: Hex) => w.relay.channel(jobId, who.nostrPk)
// What a party saw of the channel: live from the relay, or its own cached copy when the relay is down.
const view = (w: World, who: Actor, jobId: Hex, seen?: NostrEvent[]) => transcriptRoot(seen ?? channel(w, who, jobId))

// ---- delivery and judgement ---------------------------------------------------------------------

// Submitting also checkpoints the channel as the worker saw it.
export async function submit(
  w: World,
  worker: Actor,
  jobId: Hex,
  seat: number,
  deliverable: string,
  seen?: NostrEvent[],
) {
  const deliverableHash = keccak256(toHex(deliverable))
  const { root, count } = view(w, worker, jobId, seen)
  const sub = { jobId, seat, deliverableHash, transcriptRoot: root }
  await w.chain.submit(sub, await sign(worker.account, 'Submission', sub), count)
  return deliverableHash
}

export function accept(w: World, judge: Actor, jobId: Hex, seat: number, seen?: NostrEvent[]) {
  const { root, count } = view(w, judge, jobId, seen)
  w.chain.accept(jobId, seat, root, count, judge.address)
}

export function reject(w: World, judge: Actor, jobId: Hex, seat: number, seen?: NostrEvent[]) {
  const { root, count } = view(w, judge, jobId, seen)
  w.chain.reject(jobId, seat, root, count, judge.address)
}

export async function reassign(w: World, judge: Actor, r: Reassign) {
  await w.chain.reassign(r, await sign(judge.account, 'Reassign', r))
}

// Panel reviewers commit by submitting the hash of "review:salt"; the reveal is the preimage.
export const commitment = (review: string, salt: string) => `${review}:${salt}`

export function verifiedReveals(w: World, reader: Actor, jobId: Hex) {
  const job = w.chain.job(jobId)
  return channel(w, reader, jobId)
    .filter((e) => e.tags.some((t) => t[0] === 't' && t[1] === 'reveal'))
    .map((e) => {
      const wallet = w.relay.walletOf(e.pubkey)
      const seat = job.seats.find((s) => wallet && isAddressEqual(s.worker, wallet))
      return { seat: seat?.index, text: e.content, ok: !!seat && keccak256(toHex(e.content)) === seat.deliverableHash }
    })
}

// ---- arbitration --------------------------------------------------------------------------------

// The arbitrator trusts the chain's checkpoints, not the relay: the evidence must reproduce a
// recorded root. Then it reads the messages and decides.
export async function arbitrate(
  w: World,
  jobId: Hex,
  seat: number,
  evidence: NostrEvent[],
  decide: (e: NostrEvent[]) => boolean,
) {
  const job = w.chain.job(jobId)
  const matched = job.checkpoints.filter((c) => c.seat === seat && verifyTranscript(evidence, jobId, c))
  const latest = matched.at(-1)
  if (!latest) throw new Error('evidence matches no checkpoint')
  const ruling: Ruling = {
    jobId,
    seat,
    workerWins: decide(evidence.slice(0, latest.count)),
    transcriptRoot: latest.root,
  }
  await w.chain.applyRuling(ruling, await sign(w.arbitrator.account, 'Ruling', ruling))
  return ruling
}
