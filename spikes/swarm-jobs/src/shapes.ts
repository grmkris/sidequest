// A shape is a set of seats: one worker each, with dependencies and a judge.
// judgeSeat -1 means the job's creator judges the seat; otherwise the worker in that seat does,
// resolved at call time so a replaced lead keeps judging its helpers.
import { keccak256, toHex } from 'viem'

export interface SeatSpec {
  role: string
  dependsOn: number[]
  judgeSeat: number
  required: boolean
}

export interface Shape {
  name: 'solo' | 'panel' | 'lead-helpers' | 'pipeline'
  seats: SeatSpec[]
  // Panel members must not see each other's work before they commit to their own.
  revealAfterCommit: boolean
}

export const CREATOR = -1

export function solo(role: string): Shape {
  return {
    name: 'solo',
    seats: [{ role, dependsOn: [], judgeSeat: CREATOR, required: true }],
    revealAfterCommit: false,
  }
}

export function panel(reviewers: string[], aggregator = 'verdict'): Shape {
  const agg = reviewers.length
  return {
    name: 'panel',
    seats: [
      ...reviewers.map((role) => ({ role, dependsOn: [], judgeSeat: agg, required: true })),
      { role: aggregator, dependsOn: reviewers.map((_, i) => i), judgeSeat: CREATOR, required: true },
    ],
    revealAfterCommit: true,
  }
}

export function leadHelpers(lead: string, helpers: string[]): Shape {
  return {
    name: 'lead-helpers',
    seats: [
      { role: lead, dependsOn: helpers.map((_, i) => i + 1), judgeSeat: CREATOR, required: true },
      ...helpers.map((role) => ({ role, dependsOn: [], judgeSeat: 0, required: true })),
    ],
    revealAfterCommit: false,
  }
}

export function pipeline(stages: string[]): Shape {
  return {
    name: 'pipeline',
    seats: stages.map((role, i) => ({ role, dependsOn: i === 0 ? [] : [i - 1], judgeSeat: CREATOR, required: true })),
    revealAfterCommit: false,
  }
}

export function shapeHash(shape: Shape) {
  return keccak256(toHex(JSON.stringify(shape)))
}
