/**
 * Why a SIDE trade reverted, from the chain at the block it landed in. nad.fun's router reverts without a reason the
 * app can decode, so a revert said only "most likely the price moved" (13 Oct). Three causes are checkable: the
 * trade's deadline had passed, the price had moved past its floor, or an upgraded wallet would have dropped under
 * Monad's 10 MON reserve. Anything else stays unnamed rather than guessed.
 */
import { MONAD_RESERVE_BALANCE, nadRouterAbi } from '@sidequest/sdk'
import { decodeFunctionData } from 'viem'
import type { SideTradeIntent } from './side-trade.ts'

export type RevertCause = 'deadline' | 'price' | 'reserve'

/** The chain reads a cause takes; each throws when the RPC cannot answer, and the cause is then unknown. */
export interface RevertReads {
  /** The block the reverted transaction landed in, and that block's time in seconds. */
  landed(hash: `0x${string}`): Promise<{ block: bigint; timestamp: bigint }>
  /** What `amountIn` returned through the router at the end of `block`. */
  amountOut(side: 'buy' | 'sell', amountIn: bigint, block: bigint): Promise<bigint>
  /** The wallet's MON at the end of `block`. */
  balance(block: bigint): Promise<bigint>
  /** Whether the wallet is upgraded (EIP-7702), so Monad holds 10 MON back from it. */
  delegated(): Promise<boolean>
}

/** The router call's own amounts: what went in and the floor it was sent with. */
function tradeCall(trade: SideTradeIntent): { amountIn: bigint; minOut: bigint } | null {
  const step = trade.txs.at(-1)
  if (step === undefined) return null
  try {
    const call = decodeFunctionData({ abi: nadRouterAbi, data: step.data })
    if (call.functionName === 'buyWithNative')
      return { amountIn: BigInt(step.value), minOut: call.args[0].amountOutMin }
    if (call.functionName === 'sellToNative')
      return { amountIn: call.args[0].amountIn, minOut: call.args[0].amountOutMin }
  } catch {
    // not a router call this sheet built
  }
  return null
}

/** The checkable cause of a reverted trade, or null when the chain can't say. */
export async function tradeRevertCause(
  reads: RevertReads,
  trade: SideTradeIntent,
  hash: `0x${string}`,
): Promise<RevertCause | null> {
  const call = tradeCall(trade)
  if (call === null) return null
  try {
    const { block, timestamp } = await reads.landed(hash)
    if (timestamp > BigInt(trade.deadline)) return 'deadline'
    // The state the trade met is the previous block's: what its MON or SIDE returned then, against its floor.
    if ((await reads.amountOut(trade.trade, call.amountIn, block - 1n)) < call.minOut) return 'price'
    if (trade.trade === 'buy' && (await reads.delegated())) {
      const left = (await reads.balance(block - 1n)) - call.amountIn
      if (left < MONAD_RESERVE_BALANCE) return 'reserve'
    }
  } catch {
    return null
  }
  return null
}
