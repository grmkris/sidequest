import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { encodeFunctionData, erc20Abi, decodeFunctionData } from 'viem'
import { afterEach, expect, it } from 'vitest'
import { GrantStore } from './grants.ts'
import { fromNodeSqlite } from './store.ts'
import { buildAgentBatch, requireGasBudget, withGasFloat, type AgentBatchScope } from './agent-batch.ts'
import { decodeGrantBatch } from './hire-batch.ts'

const agent = '0x2222222222222222222222222222222222222222'
const operator = '0x1111111111111111111111111111111111111111'
const now = 1_800_000_000
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  const base = sdk.context('monad-testnet', 'main', 'http://unused.invalid')
  let available = 100n
  let balance = 0n
  let disabled = false
  // SAFETY: the fake implements only readContract, the only client method exercised by these builders.
  const context = {
    ...base,
    deployment: { ...base.deployment, agentSweep: base.deployment.identity },
    publicClient: {
      ...base.publicClient,
      // SAFETY: the fake covers the read methods exercised by this fixture.
      readContract: (async (input: { functionName: string }) => {
        if (input.functionName === 'disabledDelegations') return disabled
        if (input.functionName === 'getAvailableAmount') return [available, false, 0n]
        if (input.functionName === 'balanceOf') return balance
        if (input.functionName === 'minimumCreatorBond') return 1n
        if (input.functionName === 'unfilledForfeitBps') return 0
        if (input.functionName === 'CANCEL_GRACE') return 1
        if (input.functionName === 'availableOf') return 100n
        if (input.functionName === 'treasury') return operator
        throw new Error(`Unexpected read ${input.functionName}`)
      }) as sdk.Ctx['publicClient']['readContract'],
    },
  }
  const grants = new GrantStore(sql, context)
  const scope: AgentBatchScope = {
    context,
    grants,
    agent: { address: agent, operator, agent_id: '7' },
    operationId: sdk.EMPTY_HASH,
    now,
  }
  const grant = (kind: 'allowance' | 'gas-allowance') => {
    const spec: sdk.GrantSpec =
      kind === 'allowance'
        ? {
            kind,
            delegator: operator,
            agent,
            token: context.deployment.rewardTokens[0]!,
            amount: 100n,
            start: now,
            salt: 1n,
          }
        : {
            kind,
            delegator: operator,
            agent,
            token: context.deployment.aa!.gasToken,
            amount: 5_000_000n,
            periodSeconds: 604800,
            start: now,
            salt: 2n,
          }
    const prepared = grants.prepare(operator, spec)
    sql.run("UPDATE grants SET status='live',signature='0x1234' WHERE delegation_hash=?", prepared.hash)
    return prepared
  }
  const settle: sdk.TxRequest = {
    to: context.stack.holding,
    data: encodeFunctionData({ abi: sdk.sidequestHoldingAbi, functionName: 'settle', args: [1n] }),
    value: '0',
    description: 'Settle',
    chainId: context.deployment.chainId,
  }
  const publish: sdk.TxRequest = {
    ...settle,
    data: encodeFunctionData({
      abi: sdk.sidequestHoldingAbi,
      functionName: 'publish',
      args: [
        {
          approver: operator,
          arbitrator: context.deployment.arbitrator,
          manifestHash: sdk.EMPTY_HASH,
          policyHash: sdk.EMPTY_HASH,
          token: context.deployment.rewardTokens[0]!,
          reward: 100n,
          creatorBond: 1n,
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
  return {
    scope,
    grant,
    settle,
    publish,
    sql,
    setAvailable: (amount: bigint) => {
      available = amount
    },
    setBalance: (amount: bigint) => {
      balance = amount
    },
    disable: () => {
      disabled = true
    },
  }
}

it('builds an exact hire without any relay grants, inserting an omitted Holding approval', async () => {
  const f = fixture()
  f.grant('allowance')
  const batch = await buildAgentBatch(f.scope, [f.publish])
  expect(batch.calls).toHaveLength(3)
  expect(decodeGrantBatch(batch.calls[0]!.data)[0]!.execution.target.toLowerCase()).toBe(
    f.scope.context.deployment.rewardTokens[0]!.toLowerCase(),
  )
  const approval = decodeFunctionData({ abi: erc20Abi, data: batch.calls[1]!.data })
  expect(approval.args).toEqual([f.scope.context.stack.holding, 100n])
  expect(batch.calls[2]!.data).toBe(f.publish.data)
})
it('asks for hire-over-limit approval when no reward allowance is available', async () => {
  const f = fixture()
  f.grant('allowance')
  f.setAvailable(99n)
  expect(await buildAgentBatch(f.scope, [f.publish])).toMatchObject({
    calls: [],
    approval: { reason: 'allowance-unavailable', amount: '100' },
  })
})
it('builds work directly and replaces an earnings transfer with approval and own-agent sweep', async () => {
  const f = fixture()
  expect((await buildAgentBatch(f.scope, [f.settle])).calls).toHaveLength(1)
  const sweep = {
    ...f.settle,
    to: f.scope.context.deployment.factory,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [operator, 100n] }),
  }
  expect((await buildAgentBatch(f.scope, [sweep])).calls).toHaveLength(2)
  await expect(
    buildAgentBatch(f.scope, [
      { ...sweep, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [agent, 100n] }) },
    ]),
  ).rejects.toThrow('operator')
})
it('requires a live gas budget and prepends a pull covering twice the build bound', async () => {
  const f = fixture()
  await expect(requireGasBudget(f.scope)).rejects.toMatchObject({ reason: 'gas-budget-required' })
  f.grant('gas-allowance')
  f.setAvailable(5_000_000n)
  await requireGasBudget(f.scope)
  const calls = (await buildAgentBatch(f.scope, [f.settle])).calls
  const batch = await withGasFloat(f.scope, calls, 10n)
  const pull = decodeGrantBatch(batch[0]!.data)[0]!
  expect(decodeFunctionData({ abi: erc20Abi, data: pull.execution.callData }).args).toEqual([agent, 20n])
  f.setBalance(20n)
  expect(await withGasFloat(f.scope, calls, 10n)).toEqual(calls)
  f.disable()
  await expect(requireGasBudget(f.scope)).rejects.toMatchObject({ reason: 'gas-budget-required' })
})
it('refuses an exhausted float and foreign contracts or chain/value', async () => {
  const f = fixture()
  f.grant('gas-allowance')
  f.setAvailable(19n)
  const calls = (await buildAgentBatch(f.scope, [f.settle])).calls
  await expect(withGasFloat(f.scope, calls, 10n)).rejects.toMatchObject({ reason: 'gas-budget-exhausted' })
  await expect(buildAgentBatch(f.scope, [{ ...f.settle, to: operator }])).rejects.toThrow('outside')
  await expect(buildAgentBatch(f.scope, [{ ...f.settle, value: '1' }])).rejects.toThrow('value')
})
