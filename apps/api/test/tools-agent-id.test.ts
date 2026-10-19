/** apply and submit_quote take the agent id at the API boundary in one stored form (prod job 17 kept "10415.0"). */
import { Board, type Caller } from '@sidequest/board'
import { expect, it, vi } from 'vitest'
import { tools } from '../src/tools.ts'

const caller: Caller = { address: '0x2222222222222222222222222222222222222222' }
const ctx = { network: 'monad-testnet', mcpSession: undefined } as const

function fixture() {
  const apply = vi.fn(async (_caller: Caller, input: { agentId: string }) => input)
  const submitQuote = vi.fn(async (_caller: Caller, input: { agentId: string }) => input)
  // A Board whose apply and submitQuote record what the tool layer hands them.
  const board: Board = Object.assign(Object.create(Board.prototype), { apply, submitQuote })
  return { board, apply, submitQuote }
}

it('apply passes a numeric agentId on as its decimal string', async () => {
  const f = fixture()
  await tools.apply!.run(f.board, caller, { taskId: 't', agentId: 10415 }, ctx)
  await tools.apply!.run(f.board, caller, { taskId: 't', agentId: '10415' }, ctx)
  expect(f.apply.mock.calls.map(([, input]) => input.agentId)).toEqual(['10415', '10415'])
})

it('submit_quote passes a numeric agentId on as its decimal string', async () => {
  const f = fixture()
  await tools.submit_quote!.run(f.board, caller, { requestId: 'r', agentId: 7, token: 'SIDE', amount: '1' }, ctx)
  expect(f.submitQuote.mock.calls[0]![1].agentId).toBe('7')
})

it('refuses a malformed agentId as invalid before it reaches the board', () => {
  const f = fixture()
  for (const agentId of ['10415.0', 10415.5, '0', '', null, { id: 1 }])
    expect(() => tools.apply!.run(f.board, caller, { taskId: 't', agentId }, ctx)).toThrow(
      expect.objectContaining({ code: 'invalid' }),
    )
  expect(f.apply).not.toHaveBeenCalled()
})
