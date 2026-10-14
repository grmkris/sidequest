import * as sdk from '@sidequest/sdk'
import { encodeFunctionData, parseEther } from 'viem'
import { describe, expect, it } from 'vitest'
import { type RevertReads, tradeRevertCause } from './side-revert.ts'
import type { SideTradeIntent } from './side-trade.ts'

const d = sdk.deployment('monad-testnet')
const l = d.launcher!
const owner = '0x1111111111111111111111111111111111111111' as const
const hash = `0x${'22'.repeat(32)}` as const
const deadline = 2_000_000_000

// 13 Oct, mainnet: 206.22 MON for at least 2,475,000 SIDE (a 1% floor under 2.5M).
const buy: SideTradeIntent = {
  id: 'buy-1',
  trade: 'buy',
  owner,
  txs: [
    {
      description: 'Buy SIDE on nad.fun',
      chainId: d.chainId,
      to: l.router,
      data: encodeFunctionData({
        abi: sdk.nadRouterAbi,
        functionName: 'buyWithNative',
        args: [{ amountOutMin: parseEther('2475000'), token: l.side, to: owner, deadline: BigInt(deadline) }],
      }),
      value: parseEther('206.22').toString(),
    },
  ],
  out: parseEther('2500000').toString(),
  deadline,
}

/** A chain where the buy landed in block 1000; each read can be overridden. */
const reads = (over: Partial<RevertReads> = {}): RevertReads => ({
  landed: async () => ({ block: 1000n, timestamp: BigInt(deadline - 60) }),
  amountOut: async () => parseEther('2500000'),
  balance: async () => parseEther('2000'),
  delegated: async () => false,
  ...over,
})

describe('why a SIDE trade reverted', () => {
  it('names a price that moved past the floor, read at the block before it landed', async () => {
    let at: bigint | undefined
    const moved = reads({
      amountOut: async (_side, amountIn, block) => {
        at = block
        expect(amountIn).toBe(parseEther('206.22'))
        return parseEther('2437500')
      },
    })
    expect(await tradeRevertCause(moved, buy, hash)).toBe('price')
    expect(at).toBe(999n)
  })

  it('names a deadline that passed before the trade was mined', async () => {
    const late = reads({ landed: async () => ({ block: 1000n, timestamp: BigInt(deadline + 1) }) })
    expect(await tradeRevertCause(late, buy, hash)).toBe('deadline')
  })

  it("names Monad's 10 MON reserve for an upgraded wallet a buy would have left short", async () => {
    const short = reads({ delegated: async () => true, balance: async () => parseEther('210') })
    expect(await tradeRevertCause(short, buy, hash)).toBe('reserve')
    expect(await tradeRevertCause(reads({ balance: async () => parseEther('210') }), buy, hash)).toBeNull()
  })

  it('finds the nad.fun call inside a USDC trade, and never blames the reserve for one', async () => {
    const usdcBuy: SideTradeIntent = {
      ...buy,
      payWith: 'usdc',
      paid: '5349874',
      txs: [{ ...buy.txs[0]!, data: '0x1234', value: '0', description: 'Swap USDC for MON' }, buy.txs[0]!],
    }
    const moved = reads({ amountOut: async () => parseEther('2437500') })
    expect(await tradeRevertCause(moved, usdcBuy, hash)).toBe('price')
    const short = reads({ delegated: async () => true, balance: async () => 0n })
    expect(await tradeRevertCause(short, usdcBuy, hash)).toBeNull()
  })

  it('names nothing when the chain cannot say, or nothing it can check explains it', async () => {
    expect(await tradeRevertCause(reads(), buy, hash)).toBeNull()
    const down = reads({
      landed: async () => {
        throw new Error('RPC unavailable')
      },
    })
    expect(await tradeRevertCause(down, buy, hash)).toBeNull()
    expect(await tradeRevertCause(reads(), { ...buy, txs: [{ ...buy.txs[0]!, data: '0x1234' }] }, hash)).toBeNull()
  })
})
