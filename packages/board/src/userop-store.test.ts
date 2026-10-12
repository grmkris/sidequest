import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { describe, expect, it } from 'vitest'
import { fromNodeSqlite } from './store.ts'
import { AgentStore } from './agents.ts'
import { UserOpStore, thawUserOp } from './userop-store.ts'

const sender = '0x1111111111111111111111111111111111111111'
const deployment = sdk.deployment('monad-testnet')
function build(id: string): sdk.BuiltUserOp {
  const op: sdk.UserOperation = {
    sender,
    nonce: sdk.laneNonce(sdk.nonceKey(id)),
    callData: '0x',
    callGasLimit: 1n,
    verificationGasLimit: 2n,
    preVerificationGas: 3n,
    maxFeePerGas: 4n,
    maxPriorityFeePerGas: 2n,
    signature: '0x',
  }
  return {
    op,
    entryPoint: deployment.aa!.entryPoint,
    chainId: deployment.chainId,
    maxCost: 20n,
    userOpHash: sdk.userOpHash(op, deployment.chainId, deployment.aa!.entryPoint),
  }
}
function setup() {
  const db = new DatabaseSync(':memory:')
  const sql = fromNodeSqlite(db)
  const store = new UserOpStore(sql, () => 100)
  const begin = (id = 'op') => store.begin({ id, agentId: 'agent', sender, request: '{}', fromBlock: 1n })
  return { db, sql, store, begin }
}

describe('user-operation journal on real SQLite', () => {
  it('migrates additively and preserves the management and legacy journals across restarts', () => {
    const { db, sql, store, begin } = setup()
    const agents = new AgentStore(sql, () => 100)
    agents.create({
      id: 'agent',
      operator: sender,
      privyUserId: 'user',
      name: 'Agent',
      registry: deployment.identity,
      chainId: deployment.chainId,
    })
    sql.run('CREATE TABLE relay_operations (id TEXT)')
    sql.run("INSERT INTO relay_operations VALUES ('pending')")
    begin()
    expect(new AgentStore(sql, () => 101).get('agent').name).toBe('Agent')
    expect(new UserOpStore(sql, () => 101).operation('op')).toEqual(store.operation('op'))
    expect(agents.get('agent').name).toBe('Agent')
    expect(sql.all('SELECT * FROM relay_operations')).toEqual([{ id: 'pending' }])
    db.close()
  })

  it('freezes operation identity, sender and the unique nonce lane', () => {
    const { db, store, begin } = setup()
    const row = begin()
    expect(begin()).toEqual(row)
    expect(() => store.begin({ id: 'op', agentId: 'other', sender, request: '{}', fromBlock: 1n })).toThrow('identity')
    expect(() =>
      store.begin({ id: 'op', agentId: 'agent', sender, request: '{"changed":true}', fromBlock: 1n }),
    ).toThrow('identity')
    expect(() => store.built('op', build('other'))).toThrow('lane')
    db.close()
  })

  it('stores signed bytes and the attempt atomically before marking a send', () => {
    const { db, store, begin } = setup()
    begin()
    const built = build('op')
    store.built('op', built)
    const attempt = store.signed('op', '0x1234')
    expect(attempt).toMatchObject({ attempt: 1, signature: '0x1234', outcome: 'signed', sent_at: null })
    expect(thawUserOp(store.require('op').built_json!).op).toEqual({ ...built.op, signature: '0x1234' })
    expect(store.signed('op', '0x1234')).toEqual(attempt)
    expect(() => store.built('op', built)).toThrow('Reconcile')
    store.outcome('op', 'uncertain', 'uncertain', true)
    expect(store.attempts('op')[0]?.sent_at).toBe(100)
    store.outcome('op', 'dropped', 'dropped')
    store.built('op', {
      ...built,
      op: { ...built.op, maxFeePerGas: 5n },
      userOpHash: sdk.userOpHash({ ...built.op, maxFeePerGas: 5n }, built.chainId, built.entryPoint),
    })
    store.signed('op', '0xabcd')
    expect(store.attempts('op').length).toBe(2)
    expect(store.attempts('op')[0]).toEqual({ ...attempt, sent_at: 100, outcome: 'dropped' })
    db.close()
  })

  it('rolls back the attempt insertion when the stage write fails', () => {
    const { db, sql, store, begin } = setup()
    begin()
    store.built('op', build('op'))
    sql.run(
      "CREATE TRIGGER refuse_signed BEFORE UPDATE ON userop_operations WHEN NEW.status='signed' BEGIN SELECT RAISE(ABORT,'stage refused'); END",
    )
    expect(() => store.signed('op', '0x1234')).toThrow('stage refused')
    expect(store.attempts('op')).toEqual([])
    expect(store.require('op').status).toBe('built')
    db.close()
  })

  it.each(['success', 'reverted'] as const)('retains a %s receipt and refuses further effects', (status) => {
    const { db, store, begin } = setup()
    begin()
    const built = build('op')
    store.built('op', built)
    store.signed('op', '0x1234')
    const receipt = { status, txHash: built.userOpHash, actualGasCost: 12n }
    const row = store.finish('op', built.userOpHash, receipt)
    expect(row.actual_gas_cost).toBe('12')
    expect(store.finish('op', built.userOpHash, receipt)).toEqual(row)
    expect(() => store.outcome('op', 'dropped', 'dropped')).toThrow('terminal')
    expect(() => store.finish('op', built.userOpHash, { ...receipt, txHash: '0x1234' })).toThrow('cannot change')
    db.close()
  })
})
