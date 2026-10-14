// Shared cast and a lead-plus-helpers job that several scenarios start from.
import type { Hex } from 'viem'
import type { Actor } from '../src/actors'
import {
  type World,
  join,
  makeWorld,
  openJob,
  postRequest,
  readQuotes,
  readRequests,
  roster,
  sendQuote,
  side,
  usd,
} from '../src/flows'
import { leadHelpers } from '../src/shapes'

export const DAY = 86_400n

export async function vrials() {
  const w = await makeWorld()
  // Only the Professor creates jobs, so only it needs a creator bond: SIDE backing sponsored by the Safe.
  const professor = await join(w, 'Professor', 'vrials', side(10_000_000))
  w.chain.mint(professor.address, usd(5_000))
  return { w, professor }
}

// Total USDC across wallets and escrows: settlement must only move money, never create it.
export function totalUsd(w: World) {
  let sum = 0n
  for (const v of w.chain.usdc.values()) sum += v
  for (const j of w.chain.jobs.values()) sum += j.escrow
  return sum
}

export interface Milestone {
  w: World
  professor: Actor
  lead: Actor
  lit: Actor
  data: Actor
  jobId: Hex
  swarmId?: bigint
}

// Research milestone: a synthesis lead judged by the Professor, two helpers judged by the lead.
// Three agents of three different owners; with `asSwarm` the lead quotes the whole shape for a swarm.
export async function milestone(asSwarm = false): Promise<Milestone> {
  const { w, professor } = await vrials()
  const lead = await join(w, 'Synth', 'erin')
  const lit = await join(w, 'Scout', 'frank')
  const data = await join(w, 'Extractor', 'grace')
  const swarmId = asSwarm
    ? w.chain.registerSwarm(lead.address, 'Peptide Lab', [lead.agentId, lit.agentId, data.agentId])
    : 0n
  const shape = leadHelpers('synthesis', ['literature', 'data'])
  await postRequest(w, professor, shape, 'Milestone 1: evidence map for BPC-157 tendon healing', usd(1_000))
  const req = readRequests(w)[0]
  const offers = [
    { index: 0, worker: lead.address, agentId: lead.agentId, price: usd(500) },
    { index: 1, worker: lit.address, agentId: lit.agentId, price: usd(300) },
    { index: 2, worker: data.address, agentId: data.agentId, price: usd(200) },
  ]
  const expiry = w.chain.now + 3_600n
  if (asSwarm) {
    await sendQuote(w, lead, req.creatorPk, { requestId: req.requestId, quoter: lead.address, swarmId, offers, expiry })
  } else {
    for (const [i, a] of [lead, lit, data].entries())
      await sendQuote(w, a, req.creatorPk, {
        requestId: req.requestId,
        quoter: a.address,
        swarmId: 0n,
        offers: [offers[i]],
        expiry,
      })
  }
  const picks = (await readQuotes(w, professor)).flatMap((q) => q.offers)
  const now = w.chain.now
  const r = roster(w, shape, picks, {
    jobId: req.requestId,
    creator: professor,
    swarmId,
    deadlines: [now + 3n * DAY, now + 2n * DAY, now + 2n * DAY],
    bond: side(100),
  })
  await openJob(w, professor, r)
  for (const [i, a] of [lead, lit, data].entries()) w.chain.activateSeat(req.requestId, i, a.address)
  return { w, professor, lead, lit, data, jobId: req.requestId, swarmId: asSwarm ? swarmId : undefined }
}
