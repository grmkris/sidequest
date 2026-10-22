import { BoardError, agentFailureReply, unwrapReply } from '@sidequest/board'
import { describe, expect, it, vi } from 'vitest'
import { answer } from '../src/board-answer.ts'
import { toJson } from '../src/tools.ts'

describe('Board Durable Object answers', () => {
  it('wraps the JSON a method answered, so its caller unwraps the same value', async () => {
    const row = { id: 'a1', address: '0xabc', chain_id: 143, budget: 10n ** 18n }
    const reply = await answer('Operator agent read failed', () => toJson(row))
    expect(JSON.parse(reply)).toEqual({ ok: true, result: { ...row, budget: '1000000000000000000' } })
    expect(unwrapReply(reply).result).toEqual({ ...row, budget: '1000000000000000000' })
    expect(unwrapReply(await answer('OAuth resolution failed', async () => toJson(null))).result).toBeNull()
  })

  it("keeps a refusal's code across RPC, where a thrown BoardError would arrive as an internal fault", async () => {
    const reply = await answer('Operator agent read failed', () => {
      throw new BoardError('unauthenticated', 'Operator session required')
    })
    expect(JSON.parse(reply)).toEqual({ ok: false, code: 'unauthenticated', message: 'Operator session required' })
    const thrown = (() => {
      try {
        unwrapReply(reply)
      } catch (error) {
        return error
      }
    })()
    expect(thrown).toBeInstanceOf(BoardError)
    expect(agentFailureReply(thrown, 'Hosted agent execution failed', vi.fn())).toMatchObject({
      code: 'unauthenticated',
    })
  })

  it('answers an unexpected fault with an error id and the retry its method names, never the fault text', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const read = JSON.parse(
        await answer(
          'Agent profile read failed',
          async () => {
            throw new Error('D1 down: Authorization Bearer SECRETKEY')
          },
          { retry: 'read' },
        ),
      )
      expect(read).toMatchObject({ ok: false, code: 'unavailable', retry: 'read' })
      expect(read.message).toMatch(/^Agent profile read failed \(error [0-9a-f]{12}\); retry this read/u)
      expect(JSON.stringify(read)).not.toContain('SECRETKEY')
      const write = JSON.parse(
        await answer('Management storage migration failed', () => {
          throw new Error('migration 0042 failed')
        }),
      )
      expect(write).toMatchObject({ ok: false, retry: 'same-key' })
      expect(() => unwrapReply(JSON.stringify(write))).toThrow('Management storage migration failed')
    } finally {
      log.mockRestore()
    }
  })
})
