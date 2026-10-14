/**
 * USDC ⇄ MON through the network's native/pegged Uniswap v4 pool (`deployment.nativeSwap`, mainnet's MON/USDC at fee
 * 500), and SIDE bought or sold with USDC by pairing that swap with nad.fun's router (launcher.ts) in one batch:
 *
 * - buy: Permit2 approvals, exact-output USDC → exactly `mon` MON to the wallet, then `buyWithNative{value: mon}`.
 *   The wallet's MON ends where it started, which Monad's reserve-balance rule allows for an upgraded wallet;
 * - sell: `sellToNative` with the MON floor `monMin` to the wallet, then exact-input `monMin` MON → USDC. MON above
 *   the floor stays in the wallet: the swap's input is fixed when the batch is signed.
 *
 * Only an atomic executor (an EIP-7702 or smart account's batch) makes this one step; sent call by call from a plain
 * EOA it is not atomic. The calldata is pinned by contracts/test/fork/SideUsdcRoute.fork.t.sol.
 */
import {
  type Address,
  type Hex,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  isAddressEqual,
  parseAbiParameters,
  zeroAddress,
} from 'viem'
import type { Ctx } from './actions.ts'
import type { TxRequest } from './board-client.ts'
import type { Deployment, NativeSwap } from './deployment.ts'
import { type Launcher, launcherQuote, launcherQuoteIn, launcherTransactions, nadRouterAbi } from './launcher.ts'
import {
  currencyAmount,
  minOutFor,
  permit2Approvals,
  universalRouterAbi,
  v4QuoterAbi,
  v4SwapCalldata,
} from './market.ts'

/** v4 router actions (Uniswap `Actions.sol`). */
const SWAP_EXACT_IN_SINGLE = 0x06
const SWAP_EXACT_OUT_SINGLE = 0x08
const SETTLE_ALL = 0x0c
const TAKE_ALL = 0x0f
/** The original v4-periphery single-pool params, which Monad mainnet's UniversalRouter takes (no minHopPrice). */
const KEY = '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey'
const exactOutputSingle = parseAbiParameters(
  `(${KEY}, bool zeroForOne, uint128 amountOut, uint128 amountInMaximum, bytes hookData)`,
)
const exactInputSingle = parseAbiParameters(
  `(${KEY}, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)`,
)
const SWAP_GAS = '700000'

/** The route a USDC trade takes: the pool, and nad.fun's router for SIDE. */
export interface UsdcRoute {
  readonly swap: NativeSwap
  readonly launcher: Launcher
}

async function quote(
  ctx: Ctx,
  s: NativeSwap,
  fn: 'quoteExactInputSingle' | 'quoteExactOutputSingle',
  zeroForOne: boolean,
  exactAmount: bigint,
): Promise<bigint> {
  const { result } = await ctx.publicClient.simulateContract({
    address: s.quoter,
    abi: v4QuoterAbi,
    functionName: fn,
    args: [{ poolKey: { ...s.key }, zeroForOne, exactAmount, hookData: '0x' }],
  })
  return result[0]
}

/** The USDC that buys exactly `monOut` MON now. */
export const usdcInForMon = (ctx: Ctx, s: NativeSwap, monOut: bigint) =>
  quote(ctx, s, 'quoteExactOutputSingle', false, monOut)
/** The MON that `usdcIn` USDC buys now. */
export const monOutForUsdc = (ctx: Ctx, s: NativeSwap, usdcIn: bigint) =>
  quote(ctx, s, 'quoteExactInputSingle', false, usdcIn)
/** The USDC that `monIn` MON sells for now. */
export const usdcOutForMon = (ctx: Ctx, s: NativeSwap, monIn: bigint) =>
  quote(ctx, s, 'quoteExactInputSingle', true, monIn)

/** USDC in, exactly `monOut` MON out to the caller, at most `usdcMax` USDC spent. */
export function buyMonCalldata(s: NativeSwap, input: { monOut: bigint; usdcMax: bigint; deadline: number }): Hex {
  const single = encodeAbiParameters(exactOutputSingle, [
    {
      poolKey: { ...s.key },
      zeroForOne: false,
      amountOut: input.monOut,
      amountInMaximum: input.usdcMax,
      hookData: '0x',
    },
  ])
  return v4SwapCalldata(
    [SWAP_EXACT_OUT_SINGLE, SETTLE_ALL, TAKE_ALL],
    [single, currencyAmount(s.quote, input.usdcMax), currencyAmount(zeroAddress, input.monOut)],
    input.deadline,
  )
}

/** Exactly `monIn` MON in (the call's value), at least `usdcMin` USDC out to the caller. */
export function sellMonCalldata(s: NativeSwap, input: { monIn: bigint; usdcMin: bigint; deadline: number }): Hex {
  const single = encodeAbiParameters(exactInputSingle, [
    { poolKey: { ...s.key }, zeroForOne: true, amountIn: input.monIn, amountOutMinimum: input.usdcMin, hookData: '0x' },
  ])
  return v4SwapCalldata(
    [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL],
    [single, currencyAmount(zeroAddress, input.monIn), currencyAmount(s.quote, input.usdcMin)],
    input.deadline,
  )
}

/**
 * A USDC trade's amounts, each bound covering one leg. A buy: `usdcMax` caps the swap, `sideMin` floors the SIDE. A
 * sale: `monMin` floors the MON (and is what the swap sells), `usdcMin` floors the USDC.
 */
export type UsdcPlan =
  | {
      readonly trade: 'buy'
      readonly usdcIn: bigint
      readonly usdcMax: bigint
      readonly mon: bigint
      readonly sideOut: bigint
      readonly sideMin: bigint
    }
  | {
      readonly trade: 'sell'
      readonly sideIn: bigint
      readonly mon: bigint
      readonly monMin: bigint
      readonly usdcOut: bigint
      readonly usdcMin: bigint
    }

/** `amount` raised by `slippageBps`, rounded up: the most a leg may cost. */
const maxInFor = (amount: bigint, slippageBps: number) => (amount * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n

/**
 * Quote a USDC trade from what was typed. A buy reads either side: SIDE wanted (`get`) or USDC to spend (`pay`; the
 * MON it buys is sized so that even the slippage-raised cost stays within it). A sale reads the SIDE sold (`pay`) only.
 */
export async function quoteUsdcPlan(
  ctx: Ctx,
  r: UsdcRoute,
  input: { trade: 'buy' | 'sell'; edited: 'pay' | 'get'; typed: bigint; slippageBps: number },
): Promise<UsdcPlan> {
  const { trade, edited, typed, slippageBps } = input
  if (trade === 'sell') {
    if (edited !== 'pay') throw new Error('A sale into USDC is quoted from the SIDE sold.')
    const mon = await launcherQuote(ctx, r.launcher, 'sell', typed)
    const monMin = minOutFor(mon, slippageBps)
    const usdcOut = await usdcOutForMon(ctx, r.swap, monMin)
    return { trade, sideIn: typed, mon, monMin, usdcOut, usdcMin: minOutFor(usdcOut, slippageBps) }
  }
  if (edited === 'get') {
    const mon = await launcherQuoteIn(ctx, r.launcher, 'buy', typed)
    const usdcIn = await usdcInForMon(ctx, r.swap, mon)
    return {
      trade,
      usdcIn,
      usdcMax: maxInFor(usdcIn, slippageBps),
      mon,
      sideOut: typed,
      sideMin: minOutFor(typed, slippageBps),
    }
  }
  const mon = await monOutForUsdc(ctx, r.swap, (typed * 10_000n) / BigInt(10_000 + slippageBps))
  const [usdcIn, sideOut] = await Promise.all([
    usdcInForMon(ctx, r.swap, mon),
    launcherQuote(ctx, r.launcher, 'buy', mon),
  ])
  const usdcMax = maxInFor(usdcIn, slippageBps)
  return {
    trade,
    usdcIn,
    usdcMax: usdcMax < typed ? usdcMax : typed,
    mon,
    sideOut,
    sideMin: minOutFor(sideOut, slippageBps),
  }
}

/** Whether every leg still meets its bound at the price now: checked again just before the wallet opens. */
export async function usdcPlanHolds(ctx: Ctx, r: UsdcRoute, plan: UsdcPlan): Promise<boolean> {
  if (plan.trade === 'buy') {
    const [side, usdc] = await Promise.all([
      launcherQuote(ctx, r.launcher, 'buy', plan.mon),
      usdcInForMon(ctx, r.swap, plan.mon),
    ])
    return side >= plan.sideMin && usdc <= plan.usdcMax
  }
  const [mon, usdc] = await Promise.all([
    launcherQuote(ctx, r.launcher, 'sell', plan.sideIn),
    usdcOutForMon(ctx, r.swap, plan.monMin),
  ])
  return mon >= plan.monMin && usdc >= plan.usdcMin
}

/** A USDC trade's batch from `owner`, in order; send it only as one atomic batch. */
export async function usdcPlanTransactions(
  ctx: Ctx,
  r: UsdcRoute,
  plan: UsdcPlan,
  input: { owner: Address; deadline: number },
): Promise<TxRequest[]> {
  const chainId = ctx.deployment.chainId
  const { owner, deadline } = input
  if (plan.trade === 'buy') {
    const approvals = await permit2Approvals(ctx, {
      owner,
      token: r.swap.quote,
      permit2: r.swap.permit2,
      router: r.swap.universalRouter,
      amount: plan.usdcMax,
      deadline,
    })
    const buy = await launcherTransactions(ctx, r.launcher, {
      owner,
      side: 'buy',
      amountIn: plan.mon,
      minOut: plan.sideMin,
      deadline,
    })
    const swap: TxRequest = {
      description: 'Swap USDC for exactly the MON this buy takes, on Uniswap',
      chainId,
      to: r.swap.universalRouter,
      data: buyMonCalldata(r.swap, { monOut: plan.mon, usdcMax: plan.usdcMax, deadline }),
      value: '0',
      gas: SWAP_GAS,
    }
    return [...approvals, swap, ...buy]
  }
  const sell = await launcherTransactions(ctx, r.launcher, {
    owner,
    side: 'sell',
    amountIn: plan.sideIn,
    minOut: plan.monMin,
    deadline,
  })
  const swap: TxRequest = {
    description: 'Swap the MON from the sale for USDC, on Uniswap',
    chainId,
    to: r.swap.universalRouter,
    data: sellMonCalldata(r.swap, { monIn: plan.monMin, usdcMin: plan.usdcMin, deadline }),
    value: plan.monMin.toString(),
    gas: SWAP_GAS,
  }
  return [...sell, swap]
}

/** One swap call's shape: its direction, its MON amount and its USDC bound. Null for any other call to the router. */
function swapCall(s: NativeSwap, data: Hex): { buysMon: boolean; mon: bigint; usdc: bigint } | null {
  const { functionName, args } = decodeFunctionData({ abi: universalRouterAbi, data })
  if (functionName !== 'execute' || args[0] !== '0x10' || args[1].length !== 1) return null
  const [actions, params] = decodeAbiParameters(parseAbiParameters('bytes, bytes[]'), args[1][0]!)
  if (params.length !== 3) return null
  const [settle] = decodeAbiParameters(parseAbiParameters('address, uint256'), params[1]!)
  const take = decodeAbiParameters(parseAbiParameters('address, uint256'), params[2]!)
  const samePool = (key: {
    currency0: Address
    currency1: Address
    fee: number
    tickSpacing: number
    hooks: Address
  }) =>
    isAddressEqual(key.currency0, s.key.currency0) &&
    isAddressEqual(key.currency1, s.key.currency1) &&
    key.fee === s.key.fee &&
    key.tickSpacing === s.key.tickSpacing &&
    isAddressEqual(key.hooks, s.key.hooks)
  if (actions === '0x080c0f') {
    const [single] = decodeAbiParameters(exactOutputSingle, params[0]!)
    const ok =
      samePool(single.poolKey) &&
      !single.zeroForOne &&
      isAddressEqual(settle, s.quote) &&
      isAddressEqual(take[0], zeroAddress) &&
      take[1] === single.amountOut
    return ok ? { buysMon: true, mon: single.amountOut, usdc: single.amountInMaximum } : null
  }
  if (actions === '0x060c0f') {
    const [single] = decodeAbiParameters(exactInputSingle, params[0]!)
    const ok =
      samePool(single.poolKey) &&
      single.zeroForOne &&
      isAddressEqual(settle, zeroAddress) &&
      isAddressEqual(take[0], s.quote)
    return ok ? { buysMon: false, mon: single.amountIn, usdc: 0n } : null
  }
  return null
}

/** What a batch has done with MON and USDC so far: MON delivered to the owner and not yet spent, USDC it may spend. */
interface Flow {
  readonly inflow: bigint
  readonly spend: bigint
  /** A call has sent MON: without one the batch is an ordinary one and needs no funding check. */
  readonly carried: boolean
}

/** A call to the pool's router: an exact-output buy of MON adds to the inflow, a sale of MON spends from it. */
function routerStep(s: NativeSwap, flow: Flow, data: Hex, value: bigint): Flow | null {
  const swap = swapCall(s, data)
  if (swap === null) return null
  if (swap.buysMon)
    return value === 0n ? { ...flow, inflow: flow.inflow + swap.mon, spend: flow.spend + swap.usdc } : null
  if (value !== swap.mon || value > flow.inflow) return null
  return { ...flow, inflow: flow.inflow - value, carried: true }
}

/** A call to nad.fun's router: a buy spends from the inflow, a sale's MON floor adds to it; both pay the owner. */
function launcherStep(owner: Address, flow: Flow, data: Hex, value: bigint): Flow | null {
  const { functionName, args } = decodeFunctionData({ abi: nadRouterAbi, data })
  if (functionName === 'buyWithNative') {
    if (!isAddressEqual(args[0].to, owner) || value > flow.inflow) return null
    return { ...flow, inflow: flow.inflow - value, carried: flow.carried || value > 0n }
  }
  if (functionName === 'sellToNative' && value === 0n && isAddressEqual(args[0].to, owner))
    return { ...flow, inflow: flow.inflow + args[0].amountOutMin }
  return null
}

/**
 * Whether a batch from `owner` funds every MON it sends, as a USDC trade's batch does: each call that carries MON
 * spends no more than the batch has already, certainly, delivered to `owner` (an exact-output swap's MON, or a sale's
 * MON floor paid to `owner`). Returns the USDC the batch may spend (the swap's maximum), which gas must not count on;
 * null for any batch with value it does not fund, a call it doesn't recognize carrying value, or no value at all.
 */
export function usdcPlanFunding(
  d: Deployment,
  owner: Address,
  txs: readonly { to: Address; data: Hex; value: string }[],
): { gasTokenSpend: bigint } | null {
  const s = d.nativeSwap
  const nad = d.launcher
  if (s === null || nad === null) return null
  let flow: Flow | null = { inflow: 0n, spend: 0n, carried: false }
  try {
    for (const tx of txs) {
      if (flow === null) return null
      const value = BigInt(tx.value)
      if (isAddressEqual(tx.to, s.universalRouter)) flow = routerStep(s, flow, tx.data, value)
      else if (isAddressEqual(tx.to, nad.router)) flow = launcherStep(owner, flow, tx.data, value)
      else if (value !== 0n) return null
    }
  } catch {
    return null
  }
  return flow?.carried === true ? { gasTokenSpend: flow.spend } : null
}
