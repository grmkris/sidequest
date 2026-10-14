import { describe, expect, it, vi } from 'vitest'
import {
  type Address,
  type Hex,
  createPublicClient,
  decodeAbiParameters,
  decodeFunctionData,
  http,
  parseAbiParameters,
  parseEther,
  zeroAddress,
} from 'viem'
import type { Ctx } from './actions.ts'
import { deployment, stack } from './deployment.ts'
import { nadRouterAbi } from './launcher.ts'
import { universalRouterAbi } from './market.ts'
import {
  type UsdcRoute,
  buyMonCalldata,
  quoteUsdcPlan,
  sellMonCalldata,
  usdcPlanFunding,
  usdcPlanHolds,
  usdcPlanTransactions,
} from './swap.ts'

const d = deployment('monad-mainnet')
const route: UsdcRoute = { swap: d.nativeSwap!, launcher: d.launcher! }
const owner: Address = '0x00000000000000000000000000000000000000AA'
const other: Address = '0x00000000000000000000000000000000000000BB'
const usdc = (n: number) => BigInt(Math.round(n * 1e6))

/**
 * A chain priced like mainnet on 13–14 Oct: nad.fun gives 2,500,000 SIDE for 211.91 MON (and 211.91 MON for that
 * SIDE back), the pool asks 5.194052 USDC for 211.91 MON and pays 5.18 USDC for it. Allowances start at zero.
 */
function chain(prices: { sideForMon?: bigint; usdcForMon?: bigint; monForUsdc?: bigint; usdcOut?: bigint } = {}) {
  const publicClient = createPublicClient({ transport: http('http://unit.invalid') })
  vi.spyOn(publicClient, 'readContract').mockImplementation(async ({ functionName, args }) => {
    if (functionName === 'allowance') return Array.isArray(args) && args.length === 3 ? [0n, 0, 0] : 0n
    if (functionName === 'getAmountIn') return parseEther('211.91')
    return Array.isArray(args) && args[2] === true ? (prices.sideForMon ?? parseEther('2500000')) : parseEther('211.91')
  })
  vi.spyOn(publicClient, 'simulateContract').mockImplementation(
    async ({ functionName }) =>
      // SAFETY: swap.ts reads only `result[0]` of the quoter's simulation, the amount; the request is never used.
      ({
        result:
          functionName === 'quoteExactOutputSingle'
            ? [prices.usdcForMon ?? usdc(5.194052), 0n]
            : [prices.usdcOut ?? prices.monForUsdc ?? usdc(5.18), 0n],
        request: {},
      }) as never,
  )
  const c: Ctx = { deployment: d, stack: stack(d, 'main'), publicClient }
  return c
}

const pair = (p: Hex) => decodeAbiParameters(parseAbiParameters('address, uint256'), p)

/** The one V4_SWAP input of a router call: its action bytes and the three params. */
function swapOf(data: Hex) {
  const { args } = decodeFunctionData({ abi: universalRouterAbi, data })
  expect(args[0]).toBe('0x10')
  const [actions, params] = decodeAbiParameters(parseAbiParameters('bytes, bytes[]'), args[1][0]!)
  return { actions, single: params[0]!, settle: pair(params[1]!), take: pair(params[2]!) }
}

describe('buying and selling SIDE with USDC, through the MON/USDC pool and nad.fun', () => {
  it('writes the swaps in the layout mainnet’s router takes (SideUsdcRoute.fork.t.sol)', () => {
    const buy = swapOf(buyMonCalldata(route.swap, { monOut: 7n, usdcMax: 9n, deadline: 1 }))
    expect(buy.actions).toBe('0x080c0f')
    expect(buy.settle).toEqual([route.swap.quote, 9n])
    expect(buy.take).toEqual([zeroAddress, 7n])
    const [single] = decodeAbiParameters(
      parseAbiParameters(
        '((address,address,uint24,int24,address) poolKey, bool zeroForOne, uint128 amountOut, uint128 amountInMaximum, bytes hookData)',
      ),
      buy.single,
    )
    expect(single).toMatchObject({ zeroForOne: false, amountOut: 7n, amountInMaximum: 9n, hookData: '0x' })
    const sell = swapOf(sellMonCalldata(route.swap, { monIn: 7n, usdcMin: 3n, deadline: 1 }))
    expect(sell.actions).toBe('0x060c0f')
    expect(sell.settle).toEqual([zeroAddress, 7n])
    expect(sell.take).toEqual([route.swap.quote, 3n])
  })

  it('quotes a buy from the SIDE wanted: USDC for exactly the MON it takes, each leg bound by the slippage', async () => {
    const plan = await quoteUsdcPlan(chain(), route, {
      trade: 'buy',
      edited: 'get',
      typed: parseEther('2500000'),
      slippageBps: 300,
    })
    expect(plan).toEqual({
      trade: 'buy',
      usdcIn: usdc(5.194052),
      usdcMax: usdc(5.349874), // 5.194052 × 1.03, rounded up
      mon: parseEther('211.91'),
      sideOut: parseEther('2500000'),
      sideMin: parseEther('2425000'),
    })
  })

  it('quotes a buy from the USDC to spend, sizing the MON so the raised cost stays within it', async () => {
    const plan = await quoteUsdcPlan(chain({ usdcForMon: usdc(4.9) }), route, {
      trade: 'buy',
      edited: 'pay',
      typed: usdc(5),
      slippageBps: 300,
    })
    expect(plan.trade).toBe('buy')
    if (plan.trade !== 'buy') return
    expect(plan.usdcMax).toBe(usdc(5)) // 4.9 × 1.03 is over what was typed: capped at it
    expect(plan.sideMin).toBe(parseEther('2425000'))
  })

  it('quotes a sale into USDC from the SIDE sold, and refuses one typed in USDC', async () => {
    const plan = await quoteUsdcPlan(chain(), route, {
      trade: 'sell',
      edited: 'pay',
      typed: parseEther('2500000'),
      slippageBps: 300,
    })
    expect(plan).toMatchObject({ trade: 'sell', mon: parseEther('211.91'), monMin: parseEther('205.5527') })
    if (plan.trade !== 'sell') return
    expect(plan.usdcMin).toBe((usdc(5.18) * 9_700n) / 10_000n)
    await expect(
      quoteUsdcPlan(chain(), route, { trade: 'sell', edited: 'get', typed: usdc(5), slippageBps: 300 }),
    ).rejects.toThrow('SIDE sold')
  })

  it('refuses before the wallet opens once a leg no longer meets its bound', async () => {
    const plan = await quoteUsdcPlan(chain(), route, {
      trade: 'buy',
      edited: 'get',
      typed: parseEther('2500000'),
      slippageBps: 100,
    })
    expect(await usdcPlanHolds(chain(), route, plan)).toBe(true)
    // MON got dearer on the pool: 5.3 USDC is over the 5.245993 maximum at 1%.
    expect(await usdcPlanHolds(chain({ usdcForMon: usdc(5.3) }), route, plan)).toBe(false)
    // The curve moved: 2,400,000 SIDE is under the 2,475,000 floor.
    expect(await usdcPlanHolds(chain({ sideForMon: parseEther('2400000') }), route, plan)).toBe(false)
  })

  it('builds a buy as approvals, the swap, then the buy carrying exactly the swapped MON', async () => {
    const c = chain()
    const plan = await quoteUsdcPlan(c, route, {
      trade: 'buy',
      edited: 'get',
      typed: parseEther('2500000'),
      slippageBps: 300,
    })
    const txs = await usdcPlanTransactions(c, route, plan, { owner, deadline: 2_000_000_000 })
    expect(txs.map((t) => t.to)).toEqual([
      route.swap.quote,
      route.swap.permit2,
      route.swap.universalRouter,
      route.launcher.router,
    ])
    expect(txs.map((t) => t.value)).toEqual(['0', '0', '0', parseEther('211.91').toString()])
    expect(usdcPlanFunding(d, owner, txs)).toEqual({ gasTokenSpend: usdc(5.349874) })
  })

  it('builds a sale as the sale, then the swap of its MON floor; the funding check accepts both shapes only', async () => {
    const c = chain()
    const plan = await quoteUsdcPlan(c, route, {
      trade: 'sell',
      edited: 'pay',
      typed: parseEther('2500000'),
      slippageBps: 300,
    })
    const txs = await usdcPlanTransactions(c, route, plan, { owner, deadline: 2_000_000_000 })
    expect(txs.map((t) => t.to)).toEqual([d.launcher!.side, route.launcher.router, route.swap.universalRouter])
    expect(txs.at(-1)!.value).toBe(parseEther('205.5527').toString())
    expect(usdcPlanFunding(d, owner, txs)).toEqual({ gasTokenSpend: 0n })

    const sale = decodeFunctionData({ abi: nadRouterAbi, data: txs[1]!.data })
    expect(sale.functionName).toBe('sellToNative')
    // MON sent with nothing delivered first, a sale paying someone else, a swap above the floor: all refused.
    expect(usdcPlanFunding(d, owner, [txs[2]!])).toBeNull()
    expect(usdcPlanFunding(d, other, txs)).toBeNull()
    expect(
      usdcPlanFunding(d, owner, [txs[1]!, { ...txs[2]!, value: (BigInt(txs[2]!.value) + 1n).toString() }]),
    ).toBeNull()
    // MON to any other contract, and a batch that sends no MON at all, are not this check's to fund.
    expect(usdcPlanFunding(d, owner, [{ ...txs[0]!, value: '1' }])).toBeNull()
    expect(usdcPlanFunding(d, owner, [txs[0]!])).toBeNull()
    // No route on testnet.
    expect(usdcPlanFunding(deployment('monad-testnet'), owner, txs)).toBeNull()
  })
})
