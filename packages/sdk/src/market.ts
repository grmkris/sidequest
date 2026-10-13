/**
 * The SIDE market (`deployment.market`): the Uniswap v4 SIDE/quote pool from the liquidity seed, traded through
 * Uniswap's own UniversalRouter and V4Quoter (both deployed on Monad testnet and mainnet). Explore's Buy reads its
 * price, quotes an exact-input swap and builds the transactions: ERC-20 approval to Permit2, Permit2 allowance to the
 * router, then `execute(V4_SWAP)` with SWAP_EXACT_IN_SINGLE, SETTLE_ALL and TAKE_ALL.
 */
import {
  type Address,
  type Hex,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  parseAbiParameters,
} from 'viem'
import type { TxRequest } from './board-client.ts'
import type { Ctx } from './actions.ts'
import type { Market, NativePrice } from './deployment.ts'

const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
])
export const v4QuoterAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
])
export const universalRouterAbi = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
])
export const permit2Abi = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
])

/** UniversalRouter command and v4 router actions (Uniswap `Commands.sol`, `Actions.sol`). */
const V4_SWAP = '0x10'
const SWAP_EXACT_IN_SINGLE = 0x06
const SETTLE_ALL = 0x0c
const TAKE_ALL = 0x0f
const exactInputSingle = parseAbiParameters(
  '((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)',
)
/** Newer v4-periphery adds a per-hop price floor; zero means none (the swap's amountOutMinimum still binds). */
const exactInputSingleMinHop = parseAbiParameters(
  '((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)',
)

/** Default slippage for Buy, in basis points. */
export const DEFAULT_SLIPPAGE_BPS = 100
/** How long the Permit2 allowance to the router lasts. */
const PERMIT2_TTL_SECONDS = 30 * 60

function direction(m: Market, tokenIn: Address): boolean {
  const t = tokenIn.toLowerCase()
  if (t !== m.side.toLowerCase() && t !== m.quote.toLowerCase())
    throw new Error('The market trades SIDE and its quote token only')
  return t === m.key.currency0.toLowerCase()
}

/** A pool's mid price from slot0: raw units of currency1 per raw unit of currency0, or 0 for an unseeded pool. */
async function raw1Per0(ctx: Ctx, stateView: Address, poolId: Hex): Promise<number> {
  const [sqrtPriceX96] = await ctx.publicClient.readContract({
    address: stateView,
    abi: stateViewAbi,
    functionName: 'getSlot0',
    args: [poolId],
  })
  if (sqrtPriceX96 === 0n) return 0
  const ratio = Number(sqrtPriceX96) / 2 ** 96
  return ratio * ratio
}

/**
 * The chain's coin in dollars: the native/pegged pool's mid price (`deployment.nativePrice`), with the native coin's
 * 18 decimals and the pegged token's `quoteDecimals` applied. 0 for an unseeded pool.
 */
export async function nativeUsdPrice(ctx: Ctx, p: NativePrice, quoteDecimals: number): Promise<number> {
  return (await raw1Per0(ctx, p.stateView, p.poolId)) * 10 ** (18 - quoteDecimals)
}

/** The pool's mid price: quote tokens per whole SIDE, from slot0 (decimals of both tokens applied). */
export async function sidePrice(ctx: Ctx, m: Market, quoteDecimals: number): Promise<number> {
  const mid = await raw1Per0(ctx, m.stateView, m.poolId)
  if (mid === 0) return 0
  const sideIs0 = m.side.toLowerCase() === m.key.currency0.toLowerCase()
  const rawQuotePerSide = sideIs0 ? mid : 1 / mid
  return rawQuotePerSide * 10 ** (18 - quoteDecimals)
}

/** What an exact-input swap of `amountIn` of `tokenIn` returns now (Uniswap's V4Quoter, through `eth_call`). */
export async function quoteExactIn(
  ctx: Ctx,
  m: Market,
  tokenIn: Address,
  amountIn: bigint,
): Promise<{ amountIn: bigint; amountOut: bigint }> {
  const { result } = await ctx.publicClient.simulateContract({
    address: m.quoter,
    abi: v4QuoterAbi,
    functionName: 'quoteExactInputSingle',
    args: [{ poolKey: { ...m.key }, zeroForOne: direction(m, tokenIn), exactAmount: amountIn, hookData: '0x' }],
  })
  return { amountIn, amountOut: result[0] }
}

/** The least to accept for a quoted output at `slippageBps`. */
export const minOutFor = (amountOut: bigint, slippageBps = DEFAULT_SLIPPAGE_BPS) =>
  (amountOut * BigInt(10_000 - slippageBps)) / 10_000n

/** `UniversalRouter.execute` calldata for one exact-input swap on the market's pool. */
export function swapCalldata(
  m: Market,
  input: { tokenIn: Address; amountIn: bigint; minOut: bigint; deadline: number },
): Hex {
  const zeroForOne = direction(m, input.tokenIn)
  const [currencyIn, currencyOut] = zeroForOne ? [m.key.currency0, m.key.currency1] : [m.key.currency1, m.key.currency0]
  const actions =
    `0x${[SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL].map((a) => a.toString(16).padStart(2, '0')).join('')}` as Hex
  const params = [
    m.minHopPrice
      ? encodeAbiParameters(exactInputSingleMinHop, [
          {
            poolKey: { ...m.key },
            zeroForOne,
            amountIn: input.amountIn,
            amountOutMinimum: input.minOut,
            minHopPriceX36: 0n,
            hookData: '0x',
          },
        ])
      : encodeAbiParameters(exactInputSingle, [
          {
            poolKey: { ...m.key },
            zeroForOne,
            amountIn: input.amountIn,
            amountOutMinimum: input.minOut,
            hookData: '0x',
          },
        ]),
    encodeAbiParameters(parseAbiParameters('address, uint256'), [currencyIn, input.amountIn]),
    encodeAbiParameters(parseAbiParameters('address, uint256'), [currencyOut, input.minOut]),
  ]
  const swap = encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [actions, params])
  return encodeFunctionData({
    abi: universalRouterAbi,
    functionName: 'execute',
    args: [V4_SWAP, [swap], BigInt(input.deadline)],
  })
}

/**
 * The transactions for an exact-input swap from `owner`, each only when needed: approve Permit2 for exactly
 * `amountIn`, give the router a Permit2 allowance of `amountIn` for 30 minutes, then the swap with `minOut` and
 * `deadline`. The output goes to `owner`.
 */
export async function swapTransactions(
  ctx: Ctx,
  m: Market,
  input: { owner: Address; tokenIn: Address; amountIn: bigint; minOut: bigint; deadline: number },
): Promise<TxRequest[]> {
  direction(m, input.tokenIn)
  const chainId = ctx.deployment.chainId
  const now = Math.floor(Date.now() / 1000)
  const txs: TxRequest[] = []
  const [tokenAllowance, [permitted, expiration]] = await Promise.all([
    ctx.publicClient.readContract({
      address: input.tokenIn,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [input.owner, m.permit2],
    }),
    ctx.publicClient.readContract({
      address: m.permit2,
      abi: permit2Abi,
      functionName: 'allowance',
      args: [input.owner, input.tokenIn, m.universalRouter],
    }),
  ])
  if (tokenAllowance < input.amountIn) {
    txs.push({
      description: 'Allow Uniswap Permit2 to move exactly this amount',
      chainId,
      to: input.tokenIn,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [m.permit2, input.amountIn] }),
      value: '0',
      gas: '80000',
    })
  }
  if (permitted < input.amountIn || expiration < input.deadline || expiration <= now) {
    txs.push({
      description: 'Allow the Uniswap router to spend it for 30 minutes',
      chainId,
      to: m.permit2,
      data: encodeFunctionData({
        abi: permit2Abi,
        functionName: 'approve',
        args: [input.tokenIn, m.universalRouter, input.amountIn, now + PERMIT2_TTL_SECONDS],
      }),
      value: '0',
      gas: '80000',
    })
  }
  txs.push({
    description: 'Swap',
    chainId,
    to: m.universalRouter,
    data: swapCalldata(m, input),
    value: '0',
    gas: '700000',
  })
  return txs
}
