/** D24: immutables are authoritative on chain; synchronous consumers use the promoted config. */
import { feeScheduleAbi, sidequestHoldingAbi, stakeVaultAbi } from './abi/index.ts'
import type { Ctx } from './actions.ts'
import {
  clocksFromConfig,
  MAX_SIDEQUEST_WINDOW,
  PRODUCTION_CLOCKS,
  type Deployment,
  type SidequestClocks,
} from './deployment.ts'

export interface OfferWindows {
  reviewSeconds: number
  disputeSeconds: number
  arbitrationSeconds: number
}
export interface WindowBounds {
  review: { min: number; max: number }
  dispute: { min: number; max: number }
  arbitration: { min: number; max: number }
}

export const configuredClocks = (d: Pick<Deployment, 'sidequest' | 'chainId'>): SidequestClocks =>
  clocksFromConfig(d.sidequest?.clocks, d.chainId)
export function windowBounds(clocks: SidequestClocks = PRODUCTION_CLOCKS): WindowBounds {
  return {
    review: { min: clocks.minReviewWindow, max: MAX_SIDEQUEST_WINDOW },
    dispute: { min: clocks.minDisputeWindow, max: MAX_SIDEQUEST_WINDOW },
    arbitration: { min: clocks.minArbitrationWindow, max: MAX_SIDEQUEST_WINDOW },
  }
}

function duration(seconds: number) {
  for (const [unit, length] of [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ] as const)
    if (seconds % length === 0) return `${seconds / length} ${unit}${seconds / length === 1 ? '' : 's'}`
  return `${seconds} seconds`
}
export function validateOfferWindows(windows: OfferWindows, bounds: WindowBounds = windowBounds()): void {
  for (const [field, key] of [
    ['reviewSeconds', 'review'],
    ['disputeSeconds', 'dispute'],
    ['arbitrationSeconds', 'arbitration'],
  ] as const) {
    const { min, max } = bounds[key],
      value = windows[field]
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`${key} window must be between ${duration(min)} and ${duration(max)}`)
  }
}

const boundsCache = new WeakMap<Ctx, Promise<WindowBounds>>()
/** Cache only successful immutable reads. RPC errors stay unavailable and are retriable. */
export function readWindowBounds(ctx: Ctx): Promise<WindowBounds> {
  if (ctx.stack.kind !== 'sidequest-v1') return Promise.reject(new Error('Window bounds require sidequest-v1'))
  const saved = boundsCache.get(ctx)
  if (saved !== undefined) return saved
  const pending = (async () => {
    const values = await Promise.all(
      (
        [
          'MIN_REVIEW_WINDOW',
          'MAX_REVIEW_WINDOW',
          'MIN_DISPUTE_WINDOW',
          'MAX_DISPUTE_WINDOW',
          'MIN_ARBITRATION_WINDOW',
          'MAX_ARBITRATION_WINDOW',
        ] as const
      ).map((functionName) =>
        ctx.publicClient.readContract({ address: ctx.stack.holding, abi: sidequestHoldingAbi, functionName }),
      ),
    )
    const [reviewMin, reviewMax, disputeMin, disputeMax, arbitrationMin, arbitrationMax] = values.map(Number)
    const bounds: WindowBounds = {
      review: { min: reviewMin!, max: reviewMax! },
      dispute: { min: disputeMin!, max: disputeMax! },
      arbitration: { min: arbitrationMin!, max: arbitrationMax! },
    }
    for (const bound of Object.values(bounds))
      if (
        !Number.isSafeInteger(bound.min) ||
        !Number.isSafeInteger(bound.max) ||
        bound.min <= 0 ||
        bound.min > bound.max ||
        bound.max !== MAX_SIDEQUEST_WINDOW
      )
        throw new Error('Invalid deployed window bounds')
    return bounds
  })()
  boundsCache.set(ctx, pending)
  void pending.catch(() => boundsCache.delete(ctx))
  return pending
}

const clocksCache = new WeakMap<Ctx, Promise<SidequestClocks>>()
export function readSidequestClocks(ctx: Ctx): Promise<SidequestClocks> {
  const h = ctx.deployment.sidequest
  if (ctx.stack.kind !== 'sidequest-v1' || h === null)
    return Promise.reject(new Error('Protocol clocks require sidequest-v1'))
  const saved = clocksCache.get(ctx)
  if (saved !== undefined) return saved
  const pending = (async () => {
    const [bounds, unstakeDelay, holdingDelay, vaultGrace, feeDelay, feeGrace] = await Promise.all([
      readWindowBounds(ctx),
      ctx.publicClient.readContract({ address: h.vault, abi: stakeVaultAbi, functionName: 'UNSTAKE_DELAY' }),
      ctx.publicClient.readContract({ address: h.vault, abi: stakeVaultAbi, functionName: 'HOLDING_DELAY' }),
      ctx.publicClient.readContract({ address: h.vault, abi: stakeVaultAbi, functionName: 'PROPOSAL_GRACE' }),
      ctx.publicClient.readContract({ address: h.feeSchedule, abi: feeScheduleAbi, functionName: 'DELAY' }),
      ctx.publicClient.readContract({ address: h.feeSchedule, abi: feeScheduleAbi, functionName: 'PROPOSAL_GRACE' }),
    ])
    if (vaultGrace !== feeGrace) throw new Error('Deployed proposal grace clocks disagree')
    return clocksFromConfig(
      {
        minReviewWindow: bounds.review.min,
        minDisputeWindow: bounds.dispute.min,
        minArbitrationWindow: bounds.arbitration.min,
        unstakeDelay,
        holdingDelay,
        feeDelay,
        proposalGrace: vaultGrace,
      },
      ctx.deployment.chainId,
    )
  })()
  clocksCache.set(ctx, pending)
  void pending.catch(() => clocksCache.delete(ctx))
  return pending
}

const unstakeDelayCache = new WeakMap<Ctx, Promise<number>>()
/** Read the vault's immutable exit delay for preflight checks. */
export function readUnstakeDelay(ctx: Ctx): Promise<number> {
  const h = ctx.deployment.sidequest
  if (ctx.stack.kind !== 'sidequest-v1' || h === null)
    return Promise.reject(new Error('Unstake delay requires sidequest-v1'))
  const saved = unstakeDelayCache.get(ctx)
  if (saved !== undefined) return saved
  const pending = ctx.publicClient
    .readContract({ address: h.vault, abi: stakeVaultAbi, functionName: 'UNSTAKE_DELAY' })
    .then((value) => {
      const delay = value
      if (!Number.isSafeInteger(delay) || delay < 60) throw new Error('Invalid deployed unstake delay')
      return delay
    })
  unstakeDelayCache.set(ctx, pending)
  void pending.catch(() => unstakeDelayCache.delete(ctx))
  return pending
}

export function bondHorizonMessage(delay: number): string {
  const days = delay / 86400
  const label = Number.isInteger(days) ? `${days} day${days === 1 ? '' : 's'}` : `${delay} seconds`
  return `A job with a bond must end within ${label} (the unstake period). Shorten the deadline or windows.`
}

export class BondHorizonError extends Error {}

export function validateBondHorizon(
  expiredAt: number,
  now: number,
  delay: number,
  creatorBond: bigint,
  workerBond: bigint,
): void {
  if ((creatorBond === 0n && workerBond === 0n) || expiredAt <= now + delay) return
  throw new BondHorizonError(bondHorizonMessage(delay))
}

export async function requireBondHorizon(
  ctx: Ctx,
  expiredAt: number,
  creatorBond: bigint,
  workerBond = 0n,
): Promise<void> {
  if (creatorBond === 0n && workerBond === 0n) return
  const [delay, block] = await Promise.all([readUnstakeDelay(ctx), ctx.publicClient.getBlock()])
  validateBondHorizon(expiredAt, Number(block.timestamp), delay, creatorBond, workerBond)
}

export const minimumOfferWindows = (bounds: WindowBounds): OfferWindows => ({
  reviewSeconds: bounds.review.min,
  disputeSeconds: bounds.dispute.min,
  arbitrationSeconds: bounds.arbitration.min,
})

/** The Standard preference is 24h/24h/48h; preferences are clamped to deployed protocol bounds. */
const clamp = (value: number, bound: { min: number; max: number }) => Math.min(bound.max, Math.max(bound.min, value))
export function standardOfferWindows(bounds: WindowBounds): OfferWindows {
  return {
    reviewSeconds: clamp(86400, bounds.review),
    disputeSeconds: clamp(86400, bounds.dispute),
    arbitrationSeconds: clamp(172800, bounds.arbitration),
  }
}

/** Fit omitted bonded defaults inside the unbonding horizon, leaving ten minutes for signing and inclusion. */
export function fitBondedOfferWindows(
  windows: OfferWindows | undefined,
  bounds: WindowBounds,
  input: { now: number; deliveryDeadline: number; unstakeDelay: number; margin: number; bond: bigint },
): OfferWindows {
  if (windows !== undefined) return windows
  const standard = standardOfferWindows(bounds)
  if (input.bond === 0n) return standard
  const budget = input.now + input.unstakeDelay - input.deliveryDeadline - input.margin - 600
  if (windowSeconds(standard) <= budget) return standard
  const minimum = minimumOfferWindows(bounds)
  const scaled = (ratio: number): OfferWindows => ({
    reviewSeconds: minuteWindow(standard.reviewSeconds, minimum.reviewSeconds, ratio),
    disputeSeconds: minuteWindow(standard.disputeSeconds, minimum.disputeSeconds, ratio),
    arbitrationSeconds: minuteWindow(standard.arbitrationSeconds, minimum.arbitrationSeconds, ratio),
  })
  let fitted = scaled(0)
  if (windowSeconds(fitted) > budget) throw new BondHorizonError(bondHorizonMessage(input.unstakeDelay))
  let low = 0,
    high = budget / windowSeconds(standard)
  const proportional = scaled(high)
  if (windowSeconds(proportional) <= budget) return proportional
  // If a minimum binds, reduce the common ratio until the other windows also fit alongside it.
  for (let i = 0; i < 48; i++) {
    const ratio = (low + high) / 2
    const candidate = scaled(ratio)
    if (windowSeconds(candidate) <= budget) {
      low = ratio
      fitted = candidate
    } else high = ratio
  }
  return fitted
}

const windowSeconds = (windows: OfferWindows) =>
  windows.reviewSeconds + windows.disputeSeconds + windows.arbitrationSeconds
const minuteWindow = (standard: number, minimum: number, ratio: number) =>
  Math.max(Math.ceil(minimum / 60), Math.floor((standard * ratio) / 60)) * 60
