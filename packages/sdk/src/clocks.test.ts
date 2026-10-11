import { describe, expect, it, vi } from 'vitest'
import { type Address } from 'viem'
import type { Ctx } from './actions.ts'
import {
  bondHorizonMessage,
  requireBondHorizon,
  readUnstakeDelay,
  validateBondHorizon,
  configuredClocks,
  minimumOfferWindows,
  readSidequestClocks,
  readWindowBounds,
  standardOfferWindows,
  fitBondedOfferWindows,
  validateOfferWindows,
  windowBounds,
} from './clocks.ts'
import { clocksFromConfig, deployment, MAX_SIDEQUEST_WINDOW, PRODUCTION_CLOCKS } from './deployment.ts'

const FAST = {
  minReviewWindow: 120,
  minDisputeWindow: 120,
  minArbitrationWindow: 300,
  unstakeDelay: 259200,
  holdingDelay: 262800,
  feeDelay: 300,
  proposalGrace: 1800,
}
const windowSum = (windows: ReturnType<typeof standardOfferWindows>) =>
  windows.reviewSeconds + windows.disputeSeconds + windows.arbitrationSeconds

function fixture() {
  const d = deployment('monad-testnet'),
    h = d.sidequest!
  const values: Record<string, number> = {
    MIN_REVIEW_WINDOW: FAST.minReviewWindow,
    MIN_DISPUTE_WINDOW: FAST.minDisputeWindow,
    MIN_ARBITRATION_WINDOW: FAST.minArbitrationWindow,
    MAX_REVIEW_WINDOW: MAX_SIDEQUEST_WINDOW,
    MAX_DISPUTE_WINDOW: MAX_SIDEQUEST_WINDOW,
    MAX_ARBITRATION_WINDOW: MAX_SIDEQUEST_WINDOW,
    UNSTAKE_DELAY: FAST.unstakeDelay,
    HOLDING_DELAY: FAST.holdingDelay,
    PROPOSAL_GRACE: FAST.proposalGrace,
    DELAY: FAST.feeDelay,
  }
  const readContract = vi.fn(async ({ functionName }: { functionName: string; address: Address }) => {
    if (!(functionName in values)) throw new Error(`unexpected ${functionName}`)
    return values[functionName]!
  })
  const ctx: Ctx = {
    publicClient: { readContract } as unknown as Ctx['publicClient'],
    stack: d.stacks.main!,
    // A stale config must not override the deployed immutable reads.
    deployment: { ...d, sidequest: { ...h, clocks: PRODUCTION_CLOCKS } },
  }
  return { ctx, readContract, values }
}

describe('deploy-time clocks', () => {
  it('retains production defaults for absent clocks and refuses omissions in a present block', () => {
    expect(configuredClocks({ chainId: 10143, sidequest: null })).toEqual(PRODUCTION_CLOCKS)
    expect(() => clocksFromConfig({ minReviewWindow: 120 } as never, 10143)).toThrow('Invalid Sidequest clock')
    expect(clocksFromConfig(FAST, 10143)).toEqual(FAST)
  })

  it.each(Object.keys(PRODUCTION_CLOCKS) as Array<keyof typeof PRODUCTION_CLOCKS>)(
    'mainnet refuses a changed %s',
    (key) => {
      expect(() => clocksFromConfig({ ...PRODUCTION_CLOCKS, [key]: FAST[key] }, 143)).toThrow(
        `Mainnet requires production clock ${key}`,
      )
      expect(clocksFromConfig({ ...PRODUCTION_CLOCKS, [key]: PRODUCTION_CLOCKS[key] }, 143)).toEqual(PRODUCTION_CLOCKS)
    },
  )

  it.each([
    { minReviewWindow: 0 },
    { minDisputeWindow: MAX_SIDEQUEST_WINDOW + 1 },
    { minArbitrationWindow: 1.5 },
    { unstakeDelay: 59 },
    { holdingDelay: NaN },
    { feeDelay: 0 },
    { proposalGrace: 2 ** 48 },
  ])('refuses invalid config clocks %j', (clocks) => {
    expect(() => clocksFromConfig({ ...PRODUCTION_CLOCKS, ...clocks }, 10143)).toThrow('Invalid Sidequest clock')
  })

  it('preserves the vault cross-clock invariant', () => {
    expect(() => clocksFromConfig({ ...FAST, holdingDelay: FAST.unstakeDelay }, 10143)).toThrow(
      'holdingDelay must exceed unstakeDelay',
    )
  })

  it('reads the actual window minimums and caches concurrent successful reads per context', async () => {
    const f = fixture()
    const [a, b] = await Promise.all([readWindowBounds(f.ctx), readWindowBounds(f.ctx)])
    expect(a).toBe(b)
    expect(a).toEqual(windowBounds(FAST))
    expect(f.readContract).toHaveBeenCalledTimes(6)
    await readWindowBounds(f.ctx)
    expect(f.readContract).toHaveBeenCalledTimes(6)
    const another = { ...f.ctx }
    await readWindowBounds(another)
    expect(f.readContract).toHaveBeenCalledTimes(12)
  })

  it('reads delay and grace clocks from the right contracts, without reusing stale config values', async () => {
    const f = fixture(),
      h = f.ctx.deployment.sidequest!
    const clocks = await readSidequestClocks(f.ctx)
    expect(clocks).toEqual(FAST)
    expect(await readSidequestClocks(f.ctx)).toBe(clocks)
    expect(f.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: h.vault, functionName: 'UNSTAKE_DELAY' }),
    )
    expect(f.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: h.feeSchedule, functionName: 'DELAY' }),
    )
    expect(f.readContract).toHaveBeenCalledTimes(11)
  })

  it('does not cache failed reads or turn RPC failure into production clock evidence', async () => {
    const f = fixture()
    f.readContract.mockRejectedValueOnce(new Error('RPC unavailable'))
    await expect(readWindowBounds(f.ctx)).rejects.toThrow('RPC unavailable')
    expect(await readWindowBounds(f.ctx)).toEqual(windowBounds(FAST))
    f.values.MIN_REVIEW_WINDOW = 0
    await expect(readWindowBounds({ ...f.ctx })).rejects.toThrow('Invalid deployed window bounds')
  })

  it('catches mismatched grace values and retries full clock reads after a failure', async () => {
    const f = fixture(),
      original = f.readContract.getMockImplementation()!
    f.readContract.mockImplementation(async (request) =>
      request.functionName === 'PROPOSAL_GRACE' && request.address === f.ctx.deployment.sidequest!.feeSchedule
        ? 600
        : original(request),
    )
    await expect(readSidequestClocks(f.ctx)).rejects.toThrow('grace clocks disagree')
    f.readContract.mockImplementation(original)
    expect(await readSidequestClocks(f.ctx)).toEqual(FAST)
  })

  it('validates the minute-clock boundaries and clamps a Standard preference without changing custom windows', () => {
    const bounds = windowBounds(FAST),
      minimum = minimumOfferWindows(bounds)
    expect(minimum).toEqual({ reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 })
    expect(() => validateOfferWindows(minimum, bounds)).not.toThrow()
    expect(() => validateOfferWindows(minimum)).toThrow('1 hour')
    expect(() => validateOfferWindows({ ...minimum, arbitrationSeconds: 299 }, bounds)).toThrow('5 minutes')
    expect(() => validateOfferWindows({ ...minimum, reviewSeconds: MAX_SIDEQUEST_WINDOW + 1 }, bounds)).toThrow(
      '14 days',
    )
    expect(standardOfferWindows(bounds)).toEqual({
      reviewSeconds: 86400,
      disputeSeconds: 86400,
      arbitrationSeconds: 172800,
    })
    expect(standardOfferWindows({ ...bounds, review: { min: 100000, max: MAX_SIDEQUEST_WINDOW } }).reviewSeconds).toBe(
      100000,
    )
  })
})

describe('bond horizon', () => {
  it.each([259200, 1209600])(
    'accepts the exact %s-second horizon, refuses either bond past it and permits long unbonded jobs',
    (delay) => {
      expect(() => validateBondHorizon(1000 + delay, 1000, delay, 1n, 1n)).not.toThrow()
      for (const [creatorBond, workerBond] of [
        [1n, 0n],
        [0n, 1n],
      ])
        expect(() => validateBondHorizon(1001 + delay, 1000, delay, creatorBond!, workerBond!)).toThrow(
          bondHorizonMessage(delay),
        )
      expect(() => validateBondHorizon(1000 + 100 * delay, 1000, delay, 0n, 0n)).not.toThrow()
      expect(bondHorizonMessage(delay)).toContain(delay === 1209600 ? '14 days' : '3 days')
    },
  )

  it('uses the chain timestamp and actual vault delay while skipping clock reads for zero bonds', async () => {
    const f = fixture()
    // SAFETY: horizon checks use only the block timestamp; the fixture retains all other client and context fields.
    const getBlock = vi
      .fn<Ctx['publicClient']['getBlock']>()
      .mockResolvedValue({ timestamp: 1000n } as Awaited<ReturnType<Ctx['publicClient']['getBlock']>>)
    // SAFETY: the preflight queries the mined latest block only, for which the mock provides the timestamp.
    const ctx = { ...f.ctx, publicClient: { ...f.ctx.publicClient, getBlock } } as Ctx
    await requireBondHorizon(ctx, 1000 + FAST.unstakeDelay, 1n)
    await expect(requireBondHorizon(ctx, 1001 + FAST.unstakeDelay, 0n, 1n)).rejects.toThrow('3 days')
    expect(f.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: ctx.deployment.sidequest!.vault, functionName: 'UNSTAKE_DELAY' }),
    )
    expect(f.readContract).toHaveBeenCalledTimes(1)
    const unbonded = fixture()
    await requireBondHorizon(unbonded.ctx, Number.MAX_SAFE_INTEGER, 0n, 0n)
    expect(unbonded.readContract).not.toHaveBeenCalled()
  })

  it('fails closed on clock reads and retries an invalid or unavailable delay', async () => {
    const f = fixture()
    f.readContract.mockRejectedValueOnce(new Error('RPC unavailable'))
    await expect(readUnstakeDelay(f.ctx)).rejects.toThrow('RPC unavailable')
    f.values.UNSTAKE_DELAY = 0
    await expect(readUnstakeDelay(f.ctx)).rejects.toThrow('Invalid deployed unstake delay')
    f.values.UNSTAKE_DELAY = FAST.unstakeDelay
    expect(await readUnstakeDelay(f.ctx)).toBe(FAST.unstakeDelay)
  })
})

describe.each([
  { label: '3-day testnet', clocks: FAST, margin: 120 },
  { label: '14-day production', clocks: PRODUCTION_CLOCKS, margin: 3600 },
])('bonded default windows on $label', ({ clocks, margin }) => {
  const bounds = windowBounds(clocks)
  const standard = standardOfferWindows(bounds)
  const base = { now: 1000, unstakeDelay: clocks.unstakeDelay, margin, bond: 1n }

  it('keeps the standard when it fits a short delivery, otherwise fits the three-day stack', () => {
    const deliveryDeadline = base.now + 60
    const fitted = fitBondedOfferWindows(undefined, bounds, { ...base, deliveryDeadline })
    if (clocks.unstakeDelay === PRODUCTION_CLOCKS.unstakeDelay) expect(fitted).toEqual(standard)
    else expect(windowSum(fitted)).toBeLessThan(windowSum(standard))
    expect(deliveryDeadline + windowSum(fitted) + margin + 600).toBeLessThanOrEqual(base.now + base.unstakeDelay)
  })

  it('fits a two-day delivery proportionally, rounding down to whole minutes', () => {
    const deliveryDeadline = base.now + 2 * 86400
    const fitted = fitBondedOfferWindows(undefined, bounds, { ...base, deliveryDeadline })
    expect(fitted.reviewSeconds).toBe(fitted.disputeSeconds)
    expect(Math.abs(fitted.arbitrationSeconds - 2 * fitted.reviewSeconds)).toBeLessThanOrEqual(60)
    expect(Object.values(fitted).every((value) => value % 60 === 0)).toBe(true)
    expect(deliveryDeadline + windowSum(fitted) + margin + 600).toBeLessThanOrEqual(base.now + base.unstakeDelay)
    if (clocks.unstakeDelay === FAST.unstakeDelay)
      expect(fitted).toEqual({ reviewSeconds: 21420, disputeSeconds: 21420, arbitrationSeconds: 42840 })
    else expect(fitted).toEqual(standard)
  })

  it('refuses a delivery filling the horizon', () => {
    expect(() =>
      fitBondedOfferWindows(undefined, bounds, { ...base, deliveryDeadline: base.now + base.unstakeDelay }),
    ).toThrow(bondHorizonMessage(base.unstakeDelay))
  })

  it('leaves explicit windows untouched even beyond the horizon', () => {
    expect(fitBondedOfferWindows(standard, bounds, { ...base, deliveryDeadline: base.now + base.unstakeDelay })).toBe(
      standard,
    )
  })

  it('keeps the standard for an unbonded long delivery', () => {
    expect(
      fitBondedOfferWindows(undefined, bounds, { ...base, bond: 0n, deliveryDeadline: base.now + 90 * 86400 }),
    ).toEqual(standard)
  })

  it('fits the exact minimum budget and refuses one second less', () => {
    const minimum = minimumOfferWindows(bounds)
    const deliveryDeadline = base.now + base.unstakeDelay - margin - 600 - windowSum(minimum)
    expect(fitBondedOfferWindows(undefined, bounds, { ...base, deliveryDeadline })).toEqual(minimum)
    expect(() => fitBondedOfferWindows(undefined, bounds, { ...base, deliveryDeadline: deliveryDeadline + 1 })).toThrow(
      bondHorizonMessage(base.unstakeDelay),
    )
  })
})

it('fits proportionally with a binding arbitration minimum and a non-minute deployment minimum', () => {
  const bounds = windowBounds(PRODUCTION_CLOCKS)
  const now = 1000,
    deliveryDeadline = now + 13 * 86400
  const fitted = fitBondedOfferWindows(undefined, bounds, {
    now,
    deliveryDeadline,
    unstakeDelay: PRODUCTION_CLOCKS.unstakeDelay,
    margin: 3600,
    bond: 1n,
  })
  expect(fitted.arbitrationSeconds).toBe(bounds.arbitration.min)
  expect(fitted.reviewSeconds).toBeGreaterThanOrEqual(bounds.review.min)
  expect(fitted.disputeSeconds).toBeGreaterThanOrEqual(bounds.dispute.min)
  expect(
    deliveryDeadline + fitted.reviewSeconds + fitted.disputeSeconds + fitted.arbitrationSeconds + 3600 + 600,
  ).toBeLessThanOrEqual(now + PRODUCTION_CLOCKS.unstakeDelay)
  const odd = { ...windowBounds(FAST), review: { min: 121, max: MAX_SIDEQUEST_WINDOW } }
  const oddFitted = fitBondedOfferWindows(undefined, odd, {
    now,
    deliveryDeadline: now + FAST.unstakeDelay - 120 - 600 - 600,
    unstakeDelay: FAST.unstakeDelay,
    margin: 120,
    bond: 1n,
  })
  expect(oddFitted).toEqual({ reviewSeconds: 180, disputeSeconds: 120, arbitrationSeconds: 300 })
})
