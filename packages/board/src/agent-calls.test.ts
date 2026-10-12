import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import mainnet from '../../../contracts/config/monad-mainnet.json' with { type: 'json' }
import { type Address, type Hex, encodeFunctionData, erc20Abi, getAddress } from 'viem'
import { afterEach, describe, expect, it } from 'vitest'
import { GrantStore } from './grants.ts'
import { fromNodeSqlite } from './store.ts'
import { agentSweepAbi, checkAgentBatch, checkAgentCall, type AgentCallScope } from './agent-calls.ts'

const operator = '0x1111111111111111111111111111111111111111'
const agent = '0x2222222222222222222222222222222222222222'
const now = 1_800_000_000
const d = sdk.deployment('monad-testnet')
const context = {
  deployment: { ...d, aa: { ...d.aa!, paymaster: getAddress(mainnet.accountAbstraction.paymaster) } },
  stack: sdk.stack(d, 'main'),
}
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  const grants = new GrantStore(sql, context)
  const scope: AgentCallScope = {
    context,
    grants,
    agent: { address: agent, operator, agent_id: '7' },
    operationId: sdk.EMPTY_HASH,
    now,
    agentSweep: d.identity,
  }
  const spec: sdk.GrantSpec = {
    kind: 'allowance',
    delegator: operator,
    agent,
    token: d.rewardTokens[0]!,
    amount: 100n,
    salt: 1n,
    start: now,
  }
  const prepared = grants.prepare(operator, spec)
  sql.run("UPDATE grants SET status='live',signature='0x1234' WHERE delegation_hash=?", prepared.hash)
  const pull = (recipient: Address = agent, value = 100n, signature: Hex = '0x1234'): sdk.Call => ({
    to: d.delegation.manager,
    value: 0n,
    data: sdk.redeemCallsCalldata({ ...prepared.grant, signature }, [
      sdk.advanceExecution(spec.token, recipient, value),
    ]),
  })
  const publish: sdk.Call = {
    to: context.stack.holding,
    value: 0n,
    data: encodeFunctionData({
      abi: sdk.sidequestHoldingAbi,
      functionName: 'publish',
      args: [
        {
          approver: operator,
          arbitrator: d.arbitrator,
          manifestHash: sdk.EMPTY_HASH,
          policyHash: sdk.EMPTY_HASH,
          token: spec.token,
          reward: 100n,
          creatorBond: 0n,
          workerBond: 0n,
          deliveryDeadline: now + 3600,
          expiredAt: now + 86400,
          reviewWindow: 3600,
          disputeWindow: 3600,
          arbitrationWindow: 43200,
        },
      ],
    }),
  }
  const approve = sdk.approveCall(spec.token, context.stack.holding, 100n)
  return { scope, sql, prepared, pull, publish, approve }
}

describe('agent user-operation scope', () => {
  it('requires exact allowance pull, bounded approval and publish atomically', () => {
    const f = fixture()
    expect(() => checkAgentBatch(f.scope, [f.pull(), f.approve, f.publish])).not.toThrow()
    expect(() => checkAgentBatch(f.scope, [f.publish])).toThrow('atomic')
    expect(() => checkAgentBatch(f.scope, [f.approve])).toThrow('requires a hire')
    expect(() =>
      checkAgentBatch(f.scope, [f.pull(), sdk.approveCall(f.approve.to, context.stack.holding, 101n), f.publish]),
    ).toThrow('equal')
    expect(() => checkAgentBatch(f.scope, [f.pull(agent, 99n), f.approve, f.publish])).toThrow('equal')
    expect(() => checkAgentBatch(f.scope, [f.pull()])).toThrow('requires a hire')
  })
  it('pins the gas token, configured paymaster and standing approval', () => {
    const { scope } = fixture()
    const aa = context.deployment.aa
    expect(checkAgentCall(scope, sdk.approveCall(aa.gasToken, aa.paymaster, aa.standingApproval))).toBe('gas-approve')
    expect(() => checkAgentCall(scope, sdk.approveCall(aa.gasToken, aa.paymaster, aa.standingApproval + 1n))).toThrow(
      'cap',
    )
    expect(() => checkAgentCall(scope, sdk.approveCall(d.factory, aa.paymaster, 1n))).toThrow('spender')
    expect(() => checkAgentCall(scope, sdk.approveCall(aa.gasToken, operator, 1n))).toThrow('spender')
  })
  it('refuses expired, stopped, foreign and mutated grants or signatures', () => {
    const f = fixture()
    expect(() => checkAgentCall(f.scope, f.pull(operator))).toThrow('pay this agent')
    expect(() => checkAgentCall(f.scope, f.pull(agent, 100n, '0x9999'))).toThrow('operator and agent')
    f.sql.run('UPDATE grants SET expires_at=?', now)
    expect(() => checkAgentCall(f.scope, f.pull())).toThrow('live grant')
    f.sql.run("UPDATE grants SET expires_at=?,status='disabled'", now + 10)
    expect(() => checkAgentCall(f.scope, f.pull())).toThrow('live grant')
  })
  it('pins each work method to its contract and vault position to self', () => {
    const { scope } = fixture()
    const settle: sdk.Call = {
      to: context.stack.holding,
      value: 0n,
      data: encodeFunctionData({ abi: sdk.sidequestHoldingAbi, functionName: 'settle', args: [1n] }),
    }
    expect(checkAgentCall(scope, settle)).toBe('settle')
    expect(() => checkAgentCall(scope, { ...settle, to: operator })).toThrow('outside')
    expect(() => checkAgentCall(scope, { ...settle, value: 1n })).toThrow('zero value')
    const withdraw: sdk.Call = {
      to: d.sidequest!.vault,
      value: 0n,
      data: encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'withdraw', args: [operator] }),
    }
    expect(() => checkAgentCall(scope, withdraw)).toThrow('own position')
    const unstake: sdk.Call = {
      to: d.sidequest!.vault,
      value: 0n,
      data: encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'requestUndelegate', args: [agent, 1n] }),
    }
    expect(() => checkAgentCall(scope, unstake)).toThrow('verified operator')
  })
  it('refuses direct transfers and sweeps for another agent', () => {
    const { scope } = fixture()
    expect(() =>
      checkAgentCall(scope, {
        to: d.factory,
        value: 0n,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [operator, 1n] }),
      }),
    ).toThrow('outside')
    expect(checkAgentCall(scope, sweep(7n))).toBe('sweep')
    expect(() => checkAgentCall(scope, sweep(8n))).toThrow('agent ID')
  })
})

function sweep(id: bigint): sdk.Call {
  return {
    to: d.identity,
    value: 0n,
    data: encodeFunctionData({ abi: agentSweepAbi, functionName: 'sweep', args: [d.factory, id, 1n] }),
  }
}
