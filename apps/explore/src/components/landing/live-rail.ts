/**
 * What the landing's live rail says: the newest settlements on the board (a job completed and its worker paid), who
 * paid, and the board's paid-out total. Settlements come from Activity's indexed chain steps, never from examples.
 */
import type * as sdk from '@sidequest/sdk'
import { type FeedEvent, posterParty } from '../../activity-feed.ts'
import type { Party } from '../../live-activity.ts'
import { partyLabels } from '../../related-party.ts'

/** How many settlements the rail turns through: a glance, with Activity one link away. */
const RAIL_SETTLEMENTS = 5
/** How long each settlement holds before the next, in milliseconds. */
export const RAIL_HOLD_MS = 6000

/** Who paid: Sidequest for one of its own wallets or agents, else the poster as Activity names it. */
export type Payer = 'sidequest' | Party

export interface Settlement {
  key: string
  jobId: string
  title: string
  /** The worker that was paid. */
  agentId: string
  token: string
  amount: string
  /** Unix seconds. */
  at: number
  payer: Payer | null
  /** Sidequest posted it and its own agent did it, disclosed as the job page does ("Related party"). */
  related: boolean
}

type FirstParty = sdk.NetworkMeta['firstParty']

function payerOf(party: Party | null, firstParty: FirstParty): Payer | null {
  if (party === null) return null
  const ours =
    'agent' in party
      ? firstParty.agents.includes(party.agent)
      : firstParty.addresses.some((a) => a.toLowerCase() === party.wallet.toLowerCase())
  return ours ? 'sidequest' : party
}

/** The newest settlements, newest first; a completion with no payment or no named worker is not one. */
export function settlementsOf(
  events: readonly FeedEvent[],
  firstParty: FirstParty,
  limit = RAIL_SETTLEMENTS,
): Settlement[] {
  const out: Settlement[] = []
  for (const e of events) {
    if (out.length === limit) break
    if (e.kind !== 'completed' || e.jobId === null || e.agentId === null) continue
    if (e.token === undefined || e.amount === undefined || !/^[1-9]\d*$/.test(e.amount)) continue
    const party = posterParty(e.job)
    const labels = partyLabels(
      {
        jobId: e.jobId,
        creator: party !== null && 'wallet' in party ? party.wallet : null,
        posterAgent: party !== null && 'agent' in party ? party.agent : null,
        workerAgent: e.agentId,
      },
      firstParty,
    )
    out.push({
      key: e.key,
      jobId: e.jobId,
      title: e.title,
      agentId: e.agentId,
      token: e.token,
      amount: e.amount,
      at: e.at,
      payer: payerOf(party, firstParty),
      related: labels.includes('Related party'),
    })
  }
  return out
}

/**
 * Whether the rail moves on to the next settlement: only with two or more to show, never for someone who asked for
 * less motion, and never while the pointer or focus is on it, so a sentence being read holds still.
 */
export const railTurns = (rail: { count: number; reducedMotion: boolean; held: boolean }) =>
  rail.count > 1 && !rail.reducedMotion && !rail.held

/** The board's paid-out total in one token: SIDE when it has one, else the largest; null before anything is paid. */
export function paidTotal(
  paidOut: Record<string, string>,
  preferred: string,
): { token: string; amount: bigint } | null {
  const paid = Object.entries(paidOut)
    .filter(([, amount]) => /^[1-9]\d*$/.test(amount))
    .map(([token, amount]) => ({ token, amount: BigInt(amount) }))
  const side = paid.find((p) => p.token.toLowerCase() === preferred.toLowerCase())
  if (side !== undefined) return side
  return paid.reduce<{ token: string; amount: bigint } | null>(
    (a, b) => (a === null || b.amount > a.amount ? b : a),
    null,
  )
}
