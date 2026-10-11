/**
 * Sidequest v1's protocol contracts on this deploy's network (ADR-0011; config `deployment.sidequest`, decision D1):
 * SIDE (an existing token), the stake vault, the fee schedule, the v1 Holding/Evaluator pair (the `main` stack) and
 * the Safe that owns them. Before launch day `deployed` is false and every address here is zero: the pages that write are
 * gated and the chain transport sends nothing.
 */
import type { Address } from 'viem'
import { deployment } from './wallet.ts'

export interface SidequestContracts {
  factory: Address
  vault: Address
  feeSchedule: Address
  holding: Address
  evaluator: Address
  /** The owner of every v1 contract and the core admin roles. */
  safe: Address
}

const {
  sidequest: h,
  stacks: { main },
} = deployment

export const sidequest: SidequestContracts = {
  factory: h.factory,
  vault: h.vault,
  feeSchedule: h.feeSchedule,
  holding: main.holding,
  evaluator: main.evaluator,
  safe: h.safe,
}
