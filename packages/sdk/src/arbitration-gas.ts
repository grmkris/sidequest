import { V1_GAS } from './actions.ts'

/** Keep this MON float after paying a ruling's worst-case gas; it also permits nonce cancellation. */
export const ARBITER_MON_FLOOR = 100_000_000_000_000_000n
/** Rehearsal maximum fee on Monad, used for launch funding and alerts; sends still check current fee quotes. */
export const ARBITER_LAUNCH_FEE = 203_000_000_000n
export const ARBITER_ONE_RULING_MON = ARBITER_MON_FLOOR + V1_GAS.evaluator * ARBITER_LAUNCH_FEE
/** Three fully funded rulings, conservatively reserving the float with each: 1.0308 MON. */
export const ARBITER_LAUNCH_MON = ARBITER_ONE_RULING_MON * 3n
