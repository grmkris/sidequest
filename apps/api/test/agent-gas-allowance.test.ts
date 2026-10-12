import { DatabaseSync } from 'node:sqlite'
import { AgentLifecycle, SponsorDesk, fromNodeSqlite } from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import { describe, expect, it } from 'vitest'
import { agentGasAllowance } from '../src/agent-gas-allowance.ts'
import { agentRoute } from '../src/routes/agents.ts'
import { hostedMcpTools } from '../src/mcp-registry.ts'

const operator = '0x1111111111111111111111111111111111111111'
describe('gas allowance REST and MCP contract', () => {
  it.each(['prepare', 'edit', 'confirm', 'revoke'])('routes POST gas-allowance-%s only', (action) => {
    const path = `/api/agents/agent/gas-allowance-${action}`
    expect(agentRoute('POST', path, { key: 'gas' })).toEqual({
      action: `gas-allowance-${action}`,
      id: 'agent',
      body: { key: 'gas' },
    })
    expect(agentRoute('GET', path, {})).toBeUndefined()
  })
  it('lists the four gas allowance tools on both networks', () => {
    for (const network of ['monad-testnet', 'monad-mainnet']) {
      const tools = hostedMcpTools(network)
      for (const name of [
        'prepare_gas_allowance',
        'edit_gas_allowance',
        'confirm_gas_allowance',
        'revoke_gas_allowance',
      ])
        expect(tools[name]).toBeDefined()
    }
  })
  it('returns operator typed data and rejects invalid numeric input at the boundary', () => {
    const db = new DatabaseSync(':memory:')
    try {
      const sql = fromNodeSqlite(db)
      const context = sdk.context('monad-testnet', 'main', 'http://rpc.invalid')
      const sponsor = new SponsorDesk({
        sql,
        ctx: context,
        now: () => 1_800_000_000,
        fail: (_code, message) => new Error(message),
      })
      const lifecycle = new AgentLifecycle({ sql, context, sponsor, now: () => 1_800_000_000 })
      lifecycle.agents.create({
        id: 'agent',
        operator,
        privyUserId: 'user',
        name: 'Agent',
        registry: context.deployment.identity,
        chainId: 10143,
      })
      lifecycle.agents.bindWallet('agent', 'wallet', '0x2222222222222222222222222222222222222222')
      sql.run("UPDATE agents SET state='active' WHERE id='agent'")
      const call = (body: Record<string, unknown>) =>
        agentGasAllowance({ lifecycle, id: 'agent', operator, action: 'gas-allowance-prepare', body })
      expect(call({ key: 'gas' })).toMatchObject({
        typedData: expect.stringContaining('Delegation'),
        previous: [],
        transactions: [],
      })
      expect(() => call({ key: 'bad', amount: 1 })).toThrow()
      expect(() => call({ key: 'bad', amount: '-1' })).toThrow('Invalid USDC')
      expect(() => call({ key: 'bad', periodSeconds: 0 })).toThrow('positive')
    } finally {
      db.close()
    }
  })
})
