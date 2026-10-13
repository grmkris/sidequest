import { DatabaseSync } from 'node:sqlite'
import { AgentStore, UserOpStore, SPONSOR_OBJECT_NAME, fromNodeSqlite } from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { runAgent, type AgentExecuteRequest } from '../src/agent-runtime.ts'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  vi.restoreAllMocks()
})

function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  const context = sdk.context('monad-testnet', 'main', 'http://unused.invalid')
  const operator = '0x1111111111111111111111111111111111111111'
  const address = '0x2222222222222222222222222222222222222222'
  const agents = new AgentStore(sql, () => 1_800_000_000)
  agents.create({
    id: 'agent',
    operator,
    privyUserId: 'user',
    name: 'Agent',
    registry: context.deployment.identity,
    chainId: context.deployment.chainId,
  })
  agents.bindWallet('agent', 'wallet', address)
  sql.run("UPDATE agents SET state='active',agent_id='7'")
  const operation = agents.begin('agent', 'settle', 'public', 'settlement_actions', { taskId: 'task' })
  const store = new UserOpStore(sql, () => 1_800_000_000)
  store.begin({ id: operation.id, agentId: 'agent', sender: address, request: '{}', fromBlock: 0n })
  const txHash = sdk.hashText('bundle')
  store.finish(operation.id, sdk.hashText('user-operation'), { status: 'success', txHash, actualGasCost: 33n })
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Readback must not send'))
  const get = vi.fn(() => {
    throw new Error('Readback must not call the tenant or relay')
  })
  const req: AgentExecuteRequest = {
    tool: 'check_operation',
    args: { operationId: operation.id },
    agentId: 'agent',
    operator,
    resource: 'https://fixture.test/mcp',
    env: {
      network: 'monad-testnet',
      boardId: 'public',
      rpcUrl: 'http://unused.invalid',
      domain: 'fixture.test',
      uri: 'https://fixture.test/mcp',
      manifestBaseUrl: 'https://fixture.test',
      screening: { baseUrl: '', apiKey: '', model: '' },
      attesterKey: '',
      relayKey: '',
      github: { appId: '', privateKeyPem: '', installationId: '' },
    },
  }
  const bindings = {
    HOSTED_SEND: 'userop',
    NETWORK: 'monad-testnet',
    Board: { idFromName: (name: string) => ({ toString: () => name }), get },
  }
  return { sql, req, bindings, operation, txHash, network, get, context }
}

it('check_operation reads the hosted desk bundle receipt with no relay key or signing credentials', async () => {
  const f = fixture()
  const reply = await runAgent({ req: f.req, bindings: f.bindings, sql: f.sql, stateId: SPONSOR_OBJECT_NAME })
  expect(JSON.parse(reply)).toMatchObject({
    ok: true,
    result: { operationId: f.operation.id, status: 'confirmed', txHash: f.txHash, actualGasCost: '33' },
  })
  expect(f.network).not.toHaveBeenCalled()
  expect(f.get).not.toHaveBeenCalled()
})

it('keeps relay-mode operation readback as the default and forbids another agent operation', async () => {
  const f = fixture()
  const { HOSTED_SEND: _mode, ...bindings } = f.bindings
  const reply = await runAgent({ req: f.req, bindings, sql: f.sql, stateId: SPONSOR_OBJECT_NAME })
  expect(JSON.parse(reply)).toMatchObject({ ok: true, result: { id: f.operation.id, stage: 'intent' } })
  f.sql.run("UPDATE agent_operations SET agent_id='another' WHERE id=?", f.operation.id)
  await expect(
    runAgent({ req: f.req, bindings: f.bindings, sql: f.sql, stateId: SPONSOR_OBJECT_NAME }),
  ).rejects.toThrow('another agent')
  expect(f.network).not.toHaveBeenCalled()
})

it('mainnet hosted readback defaults to user operations with no relay or explicit cutover flag', async () => {
  const f = fixture()
  vi.spyOn(sdk, 'context').mockReturnValue({
    ...f.context,
    deployment: { ...f.context.deployment, network: 'monad-mainnet', chainId: 143 },
  })
  const { HOSTED_SEND: _mode, ...rest } = f.bindings
  const req: AgentExecuteRequest = { ...f.req, env: { ...f.req.env, network: 'monad-mainnet' } }
  const reply = await runAgent({
    req,
    bindings: { ...rest, NETWORK: 'monad-mainnet' },
    sql: f.sql,
    stateId: SPONSOR_OBJECT_NAME,
  })
  expect(JSON.parse(reply)).toMatchObject({ ok: true, result: { status: 'confirmed', txHash: f.txHash } })
  expect(f.network).not.toHaveBeenCalled()
  expect(f.get).not.toHaveBeenCalled()
})
