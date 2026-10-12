import { describe, expect, it, vi } from 'vitest'
import { createPublicClient, decodeFunctionData, erc20Abi, http, type Address } from 'viem'
import testnet from '../../../contracts/config/monad-testnet.json' with { type: 'json' }
import type { Ctx } from './actions.ts'
import { deployment, stack } from './deployment.ts'
import {
  launcherGraduated,
  launcherQuote,
  launcherSideCost,
  launcherTransactions,
  MONAD_RESERVE_BALANCE,
  nadRouterAbi,
  nativeBuyCap,
} from './launcher.ts'

const d = deployment('monad-testnet')
const l = d.launcher!
const owner: Address = '0x00000000000000000000000000000000000000AA' // checksummed, as decoding returns it

function ctx(reads: { allowance?: bigint; amountOut?: bigint }) {
  const publicClient = createPublicClient({ transport: http('http://unit.invalid') })
  const read = vi
    .spyOn(publicClient, 'readContract')
    .mockImplementation(async ({ functionName }) =>
      functionName === 'allowance' ? (reads.allowance ?? 0n) : (reads.amountOut ?? 0n),
    )
  const c: Ctx = { deployment: d, stack: stack(d, 'main'), publicClient }
  return { c, read }
}

describe("SIDE on nad.fun's router", () => {
  it('is the configured router and the deployment SIDE on testnet', () => {
    expect(l.router).toBe(testnet.nadfun.router)
    expect(l.side).toBe(d.factory)
  })

  it('quotes buys and sells through getAmountOut', async () => {
    const { c, read } = ctx({ amountOut: 123n })
    expect(await launcherQuote(c, l, 'buy', 10n)).toBe(123n)
    expect(read).toHaveBeenLastCalledWith(
      expect.objectContaining({ address: l.router, functionName: 'getAmountOut', args: [l.side, 10n, true] }),
    )
    await launcherQuote(c, l, 'sell', 7n)
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ args: [l.side, 7n, false] }))
  })

  it('buys with native MON: one router call carrying the amount, the floor and the deadline', async () => {
    const { c, read } = ctx({})
    const [tx, ...rest] = await launcherTransactions(c, l, {
      owner,
      side: 'buy',
      amountIn: 5n,
      minOut: 40n,
      deadline: 99,
    })
    expect(rest).toEqual([])
    expect(read).not.toHaveBeenCalled()
    expect(tx).toMatchObject({ to: l.router, value: '5', chainId: d.chainId })
    const { functionName, args } = decodeFunctionData({ abi: nadRouterAbi, data: tx!.data })
    expect(functionName).toBe('buyWithNative')
    expect(args).toEqual([{ amountOutMin: 40n, token: l.side, to: owner, deadline: 99n }])
  })

  it('sells SIDE for MON, approving the router for exactly the amount only when its allowance is short', async () => {
    const short = await launcherTransactions(ctx({ allowance: 1n }).c, l, {
      owner,
      side: 'sell',
      amountIn: 8n,
      minOut: 3n,
      deadline: 99,
    })
    expect(short.map((tx) => tx.to)).toEqual([l.side, l.router])
    expect(decodeFunctionData({ abi: erc20Abi, data: short[0]!.data }).args).toEqual([l.router, 8n])
    const sell = decodeFunctionData({ abi: nadRouterAbi, data: short[1]!.data })
    expect(sell.functionName).toBe('sellToNative')
    expect(sell.args).toEqual([{ amountIn: 8n, amountOutMin: 3n, token: l.side, to: owner, deadline: 99n }])
    expect(short[1]!.value).toBe('0')
    const covered = await launcherTransactions(ctx({ allowance: 8n }).c, l, {
      owner,
      side: 'sell',
      amountIn: 8n,
      minOut: 3n,
      deadline: 99,
    })
    expect(covered.map((tx) => tx.to)).toEqual([l.router])
  })

  it('asks the V2 router whether SIDE has graduated', async () => {
    const publicClient = createPublicClient({ transport: http('http://unit.invalid') })
    const read = vi.spyOn(publicClient, 'readContract').mockResolvedValue(true)
    expect(await launcherGraduated({ deployment: d, stack: stack(d, 'main'), publicClient }, l)).toBe(true)
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ address: l.router, functionName: 'isGraduated', args: [l.side] }),
    )
  })

  it('costs a SIDE amount in MON through getAmountIn, as a buy', async () => {
    const { c, read } = ctx({ amountOut: 67n })
    expect(await launcherSideCost(c, l, 1_000_000n)).toBe(67n)
    expect(read).toHaveBeenLastCalledWith(
      expect.objectContaining({ address: l.router, functionName: 'getAmountIn', args: [l.side, 1_000_000n, true] }),
    )
  })

  it("keeps Monad's 10 MON reserve in a delegated wallet's buy, and none in a plain wallet's", () => {
    const gasCost = 90n
    expect(MONAD_RESERVE_BALANCE).toBe(10n ** 19n)
    expect(nativeBuyCap({ balance: 25n * 10n ** 18n, gasCost, delegated: true })).toBe(15n * 10n ** 18n - gasCost)
    expect(nativeBuyCap({ balance: 25n * 10n ** 18n, gasCost, delegated: false })).toBe(25n * 10n ** 18n - gasCost)
    expect(nativeBuyCap({ balance: 9n * 10n ** 18n, gasCost, delegated: true })).toBe(0n)
    expect(nativeBuyCap({ balance: 50n, gasCost, delegated: false })).toBe(0n)
  })
})
