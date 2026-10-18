import { encodeFunctionData, erc20Abi, parseAbi, parseEther, type Address } from 'viem'
import type { Ctx } from './actions.ts'
import type { TxRequest } from './board-client.ts'

/**
 * SIDE on its launcher: nad.fun's router (config `nadfun.router`), which trades the bonding curve before graduation and
 * the DEX pair after it. The same contract calls on Monad testnet and mainnet, so the app buys and sells SIDE the same
 * way on both. Null until the config names the router and the deployment has SIDE.
 */
export interface Launcher {
  readonly router: Address
  readonly side: Address
}

export const nadRouterAbi = parseAbi([
  'function getAmountOut(address token, uint256 amountIn, bool isBuy) view returns (uint256)',
  'function getAmountIn(address token, uint256 amountOut, bool isBuy) view returns (uint256)',
  'function buyWithNative((uint256 amountOutMin, address token, address to, uint256 deadline) params) payable returns (uint256)',
  'function sellToNative((uint256 amountIn, uint256 amountOutMin, address token, address to, uint256 deadline) params) returns (uint256)',
  'function isGraduated(address token) view returns (bool)',
])

/** Gas limits with room over measured testnet trades (buy 714,573; sell 668,821): Monad charges the limit. */
const BUY_GAS = '900000'
const SELL_GAS = '850000'

/**
 * Monad's reserve balance: a 7702-delegated wallet (every Explore wallet after its first batch) can never take the
 * emptying exception, so a transaction that sends MON and leaves it under 10 MON reverts and still pays its gas
 * (docs.monad.xyz/developer-essentials/reserve-balance). Undelegated wallets may dip under once every 3 blocks.
 */
export const MONAD_RESERVE_BALANCE = parseEther('10')

/** The most MON a wallet can put into a buy now: its balance less gas, and less the 10 MON reserve when delegated. */
export function nativeBuyCap(input: { balance: bigint; gasCost: bigint; delegated: boolean }): bigint {
  const cap = input.balance - input.gasCost - (input.delegated ? MONAD_RESERVE_BALANCE : 0n)
  return cap > 0n ? cap : 0n
}

/** What `amountIn` returns now: SIDE for MON (`buy`) or MON for SIDE (`sell`), after the router's fees and any early-block penalty. */
export function launcherQuote(
  ctx: Ctx,
  l: Launcher,
  side: 'buy' | 'sell',
  amountIn: bigint,
  blockNumber?: bigint,
): Promise<bigint> {
  return ctx.publicClient.readContract({
    address: l.router,
    abi: nadRouterAbi,
    functionName: 'getAmountOut',
    args: [l.side, amountIn, side === 'buy'],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  })
}

/** Whether SIDE has left nad.fun's bonding curve for its DEX pair: the V2 router's own answer (never the V1 Lens). */
export function launcherGraduated(ctx: Ctx, l: Launcher): Promise<boolean> {
  return ctx.publicClient.readContract({
    address: l.router,
    abi: nadRouterAbi,
    functionName: 'isGraduated',
    args: [l.side],
  })
}

/**
 * What it takes now to receive exactly `amountOut`, after the router's fees: the MON for that much SIDE (`buy`) or the
 * SIDE for that much MON (`sell`). The other half of `launcherQuote`, for a form that lets people type either side.
 */
export function launcherQuoteIn(ctx: Ctx, l: Launcher, side: 'buy' | 'sell', amountOut: bigint): Promise<bigint> {
  return ctx.publicClient.readContract({
    address: l.router,
    abi: nadRouterAbi,
    functionName: 'getAmountIn',
    args: [l.side, amountOut, side === 'buy'],
  })
}

/** The MON a buy of exactly `side` SIDE takes now, after the router's fees: what Explore shows the bond costs. */
export function launcherSideCost(ctx: Ctx, l: Launcher, side: bigint): Promise<bigint> {
  return launcherQuoteIn(ctx, l, 'buy', side)
}

/**
 * Buy SIDE with native MON, or sell SIDE for MON, through the router: at least `minOut`, before `deadline`, to the
 * owner. Sent from the owner's wallet, never gas-sponsored. A sell first approves the router for exactly `amountIn`
 * when its allowance is short.
 */
export async function launcherTransactions(
  ctx: Ctx,
  l: Launcher,
  input: { owner: Address; side: 'buy' | 'sell'; amountIn: bigint; minOut: bigint; deadline: number },
): Promise<TxRequest[]> {
  const chainId = ctx.deployment.chainId
  const deadline = BigInt(input.deadline)
  if (input.side === 'buy')
    return [
      {
        description: 'Buy SIDE on nad.fun',
        chainId,
        to: l.router,
        data: encodeFunctionData({
          abi: nadRouterAbi,
          functionName: 'buyWithNative',
          args: [{ amountOutMin: input.minOut, token: l.side, to: input.owner, deadline }],
        }),
        value: input.amountIn.toString(),
        gas: BUY_GAS,
      },
    ]
  const allowance = await ctx.publicClient.readContract({
    address: l.side,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [input.owner, l.router],
  })
  const txs: TxRequest[] = []
  if (allowance < input.amountIn)
    txs.push({
      description: 'Allow nad.fun to move exactly this SIDE',
      chainId,
      to: l.side,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [l.router, input.amountIn] }),
      value: '0',
      gas: '80000',
    })
  txs.push({
    description: 'Sell SIDE on nad.fun',
    chainId,
    to: l.router,
    data: encodeFunctionData({
      abi: nadRouterAbi,
      functionName: 'sellToNative',
      args: [{ amountIn: input.amountIn, amountOutMin: input.minOut, token: l.side, to: input.owner, deadline }],
    }),
    value: '0',
    gas: SELL_GAS,
  })
  return txs
}
