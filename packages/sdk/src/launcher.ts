import { encodeFunctionData, erc20Abi, parseAbi, type Address } from 'viem'
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
  'function buyWithNative((uint256 amountOutMin, address token, address to, uint256 deadline) params) payable returns (uint256)',
  'function sellToNative((uint256 amountIn, uint256 amountOutMin, address token, address to, uint256 deadline) params) returns (uint256)',
])

/** Gas limits with room over measured testnet trades (buy 714,573; sell 668,821): Monad charges the limit. */
const BUY_GAS = '900000'
const SELL_GAS = '850000'

/** What `amountIn` returns now: SIDE for MON (`buy`) or MON for SIDE (`sell`), after the router's fees and any early-block penalty. */
export function launcherQuote(ctx: Ctx, l: Launcher, side: 'buy' | 'sell', amountIn: bigint): Promise<bigint> {
  return ctx.publicClient.readContract({
    address: l.router,
    abi: nadRouterAbi,
    functionName: 'getAmountOut',
    args: [l.side, amountIn, side === 'buy'],
  })
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
