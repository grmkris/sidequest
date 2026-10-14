/**
 * The Uniswap v4 pools a network config names, read into a deployment: a pool's id from its key, the native/pegged
 * pool that prices MON (`prices.native`) and the same pool as a route (`swap`). Kept apart from deployment.ts so
 * that file stays a reader of the whole config.
 */
import { type Address, type Hex, encodeAbiParameters, keccak256, parseAbiParameters, zeroAddress } from 'viem'
import type { DeploymentConfig, NativePrice, NativeSwap, PoolKey } from './deployment.ts'

/** A configured address: 20 bytes of hex, and never the zero address. */
export const validAddress = (value: unknown): value is Address =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value)

/** A v4 pool's id: the hash of its key, as the PoolManager computes it. */
export const poolIdOf = (key: PoolKey): Hex =>
  keccak256(
    encodeAbiParameters(parseAbiParameters('address, address, uint24, int24, address'), [
      key.currency0,
      key.currency1,
      key.fee,
      key.tickSpacing,
      key.hooks,
    ]),
  )

/** Config `prices.native`: refused unless its quote token is pegged and the network names its StateView. */
export function nativePriceFromConfig(c: DeploymentConfig): NativePrice | null {
  const p = c.prices?.native
  if (p === undefined) return null
  const stateView = c.liquidity?.uniswapV4.stateView
  const pegged = (c.usdPegged ?? []).some((token) => token.toLowerCase() === p.quote.toLowerCase())
  if (
    !validAddress(p.quote) ||
    !pegged ||
    !validAddress(stateView) ||
    !Number.isSafeInteger(p.fee) ||
    !Number.isSafeInteger(p.tickSpacing)
  )
    throw new Error(
      'Network config prices.native needs a usdPegged quote token, a fee, a tickSpacing and liquidity.uniswapV4.stateView',
    )
  const key: PoolKey = {
    currency0: zeroAddress,
    currency1: p.quote,
    fee: p.fee,
    tickSpacing: p.tickSpacing,
    hooks: zeroAddress,
  }
  return { key, poolId: poolIdOf(key), quote: p.quote, stateView }
}

/** Config `swap` over `prices.native`: refused when it names anything but addresses, or has no pool or Permit2. */
export function nativeSwapFromConfig(c: DeploymentConfig): NativeSwap | null {
  if (c.swap === undefined) return null
  const price = nativePriceFromConfig(c)
  const permit2 = c.liquidity?.uniswapV4.permit2
  if (price === null || !validAddress(permit2) || !validAddress(c.swap.universalRouter) || !validAddress(c.swap.quoter))
    throw new Error(
      'Network config swap needs universalRouter and quoter addresses, prices.native and liquidity.uniswapV4.permit2',
    )
  return { ...price, permit2, universalRouter: c.swap.universalRouter, quoter: c.swap.quoter }
}
