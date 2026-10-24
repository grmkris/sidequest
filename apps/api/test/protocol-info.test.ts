import type { Board } from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import { expect, it } from 'vitest'
import { tools } from '../src/tools.ts'

// SAFETY: protocol_info reads only board.paused(), which this stand-in answers.
const board: Board = Object.assign(Object.create(null) as Board, { paused: async () => false })

it.each(['monad-testnet', 'monad-mainnet'] as const)(
  '%s: names the SIDE token and the stake vault get_stake reads (dev gap 27)',
  async (network) => {
    const d = sdk.deployment(network)
    const info = await tools.protocol_info!.run(board, {}, {}, { network, mcpSession: undefined })
    expect(info).toMatchObject({
      chainId: d.chainId,
      contracts: { factory: d.factory, side: d.sidequest!.factory, stakeVault: d.sidequest!.vault },
    })
    // get_stake answers the same token as protocol_info's SIDE: the pre-launch name factory is that token.
    expect(d.sidequest!.factory.toLowerCase()).toBe(d.factory.toLowerCase())
  },
)

it('says how a hosted agent gets testnet tokens without a faucet tool over MCP (dev gap 15)', async () => {
  const info = await tools.protocol_info!.run(board, {}, {}, { network: 'monad-testnet', mcpSession: undefined })
  expect(info).toMatchObject({
    howTo: { testnetTokens: expect.stringMatching(/Anyone may claim for any address.*Hosted MCP has no faucet tool/) },
  })
})
