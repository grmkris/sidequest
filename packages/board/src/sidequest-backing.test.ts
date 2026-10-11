import type * as sdk from '@sidequest/sdk'
import { describe, expect, it } from 'vitest'
import { agentFailureReply } from './agent-failure.ts'
import { BoardError } from './board-error.ts'
import { requireBacking } from './sidequest.ts'

const SIDE = 10n ** 18n
const account = '0xe89F284d22a9280b3bab3F1c135bd7629D1a3587'
const ctxWith = (available: bigint) =>
  ({
    deployment: { sidequest: { vault: '0x48aB9ec1d37818293Ba1F9e63a4f01C8e4a05C76' } },
    publicClient: { readContract: async () => available },
  }) as unknown as sdk.Ctx

describe('requireBacking', () => {
  it('passes when the available backing covers the bond', async () => {
    await expect(requireBacking(ctxWith(200n * SIDE), account, 200n * SIDE, 'worker')).resolves.toBeUndefined()
  })

  it('refuses a short worker with the amounts and an operator retry, not an internal failure', async () => {
    const error = await requireBacking(ctxWith(100n * SIDE), account, 200n * SIDE, 'worker').catch(
      (failure: unknown) => failure,
    )
    expect(error).toBeInstanceOf(BoardError)
    const logged: string[] = []
    expect(agentFailureReply(error, 'fallback', (id) => logged.push(id))).toEqual({
      ok: false,
      code: 'conflict',
      message: `The worker bond is 200 SIDE but only 100 SIDE of backing is available behind ${account}; back it with more SIDE, then retry`,
      reason: 'insufficient-backing',
      retry: 'after-operator',
    })
    expect(logged).toEqual([])
  })

  it("tells a hosted agent how to get the shortfall: request_backing, or its operator's filled-in link", async () => {
    const error = await requireBacking(ctxWith(4n * SIDE), account, 10n * SIDE, 'creator', {
      origin: 'https://dev.sidequest.exchange',
      agentId: '2194',
    }).catch((failure: unknown) => failure)
    expect(error).toMatchObject({
      reason: 'insufficient-backing',
      message:
        `The creator bond is 10 SIDE but only 4 SIDE of backing is available behind ${account}; back it with more SIDE, then retry. ` +
        'Call request_backing, or send your operator https://dev.sidequest.exchange/agent/2194?back=6 to back it with 6 SIDE from their wallet',
    })
  })
})
