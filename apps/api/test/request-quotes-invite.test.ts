import { expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Board, fromNodeSqlite } from '@sidequest/board'
import { Ajv } from 'ajv'
import { tools } from '../src/tools.ts'

const creator = '0x1111111111111111111111111111111111111111' as const

it('advertises invite to quote and maps it through request_quotes', async () => {
  const tool = tools.request_quotes!
  expect(tool.description).toContain('invite one agent to quote')
  expect(tool.inputSchema.properties.invite).toEqual(
    expect.objectContaining({
      type: 'object',
      required: ['agentId'],
      properties: { agentId: expect.objectContaining({ type: 'string', pattern: '^\\d+$' }) },
    }),
  )
  const validate = new Ajv({ strict: false }).compile(tool.inputSchema)
  const required = { title: 'Title', brief: 'Brief', acceptanceCriteria: [], deliveryDeadline: 200, quoteDeadline: 100 }
  expect(validate(required)).toBe(true)
  expect(validate({ ...required, invite: { agentId: '9' } })).toBe(true)
  for (const invite of [{}, { agentId: 9 }, { agentId: '9x' }, { agentId: '-9' }, { agentId: '9', wallet: creator }])
    expect(validate({ ...required, invite })).toBe(false)
  const db = new DatabaseSync(':memory:')
  const board = new Board(fromNodeSqlite(db), {
    network: 'monad-testnet',
    contexts: {},
    domain: 'invite.test',
    uri: 'https://invite.test',
    manifestBaseUrl: 'https://invite.test/offers',
  })
  const requestQuotes = vi.spyOn(board, 'requestQuotes').mockResolvedValue({
    requestId: 'request-1',
    requestHash: '0xhash',
    status: 'Accepting quotes, reward not escrowed',
    next: 'Wait for quotes',
    deliveryDeadline: 200,
    quoteDeadline: 100,
    invite: { agentId: '9', wallet: creator },
  })
  const result = await tool.run(
    board,
    { address: creator },
    {
      title: 'Title',
      brief: 'Brief',
      acceptanceCriteria: ['works'],
      tokens: ['0x2222222222222222222222222222222222222222'],
      deliveryDeadline: 200,
      quoteDeadline: 100,
      invite: { agentId: '9' },
    },
    { network: 'monad-testnet', mcpSession: undefined },
  )
  expect(requestQuotes).toHaveBeenCalledWith(
    { address: creator },
    expect.objectContaining({ invite: { agentId: '9' } }),
  )
  expect(result).toMatchObject({ requestId: 'request-1', invite: { agentId: '9' } })
  db.close()
})
