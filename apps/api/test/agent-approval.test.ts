/** Real SQLite, delegation signatures and hosted continuation; chain reads and relay are test doubles. */
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import {
  AgentExecutor,
  AgentSigning,
  GrantStore,
  BoardError,
  agentFailureReply,
  decodeGrantBatch,
  fromNodeSqlite,
  type SponsorDesk,
  type AgentExecuteResult,
  type NamedSponsorEntry,
} from '@sidequest/board'
import { type Hex, decodeFunctionData, encodeFunctionData, erc20Abi } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, expect, it, vi } from 'vitest'
import { agentManagement, reopenDeclinedPick } from '../src/agent-management.ts'

const databases: DatabaseSync[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
})

async function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  const context = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const operator = privateKeyToAccount(generatePrivateKey())
  const agent = privateKeyToAccount(generatePrivateKey())
  const clock = { now: 1_800_000_000 }
  const backing = { available: 10n ** 18n }
  const token = context.deployment.rewardTokens[0]!
  vi.spyOn(context.publicClient, 'readContract').mockImplementation(async (request) => {
    if (request.functionName === 'minimumCreatorBond') return 10n ** 18n
    if (request.functionName === 'unfilledForfeitBps') return 2500
    if (request.functionName === 'CANCEL_GRACE') return 600
    if (request.functionName === 'treasury') return context.deployment.sidequest!.safe
    if (request.functionName === 'availableOf')
      return request.args?.[0]?.toString().toLowerCase() === agent.address.toLowerCase()
        ? backing.available
        : 100n * 10n ** 18n
    if (request.functionName === 'disabledDelegations') return false
    if (request.functionName === 'callCounts') return 0n
    if (request.functionName === 'getAvailableAmount') return [220_000_000n, true, 0n]
    throw new Error(`Unexpected chain read: ${request.functionName}`)
  })
  const submit = vi.fn(
    async (_wallet: string, _entries: readonly NamedSponsorEntry[], _key: string, operationId: string) => {
      sql.run(
        "UPDATE agent_operations SET stage='sending',sponsor_operation_id='relay-fixture' WHERE id=?",
        operationId,
      )
      return { status: 'confirmed' as const, txHash: `0x${'ab'.repeat(32)}` as Hex }
    },
  )
  const sponsor = { ready: async () => {}, submit } as unknown as SponsorDesk
  const signTypedData = vi.fn(async (_id: string, data: string) => agent.signTypedData(JSON.parse(data)))
  const boot = () =>
    new AgentExecutor({
      sql,
      context,
      now: () => clock.now,
      sponsor,
      signing: new AgentSigning(
        sql,
        context,
        {
          signTypedData,
          signAuthorization: async () => {
            throw new Error('No upgrade expected')
          },
        },
        () => clock.now,
      ),
      prepareTool: async (request) => {
        if (request.tool === 'report_transaction') return { reported: true }
        if (request.tool !== 'create_task') throw new Error('Unexpected tool')
        return {
          taskId: 'fixture-hire',
          transactions: [
            {
              to: context.stack.holding,
              data: publish,
              value: '0',
              chainId: context.deployment.chainId,
              description: 'Publish the frozen hire',
            },
          ],
        }
      },
      verifyToolSigning: async () => {
        throw new Error('No tool signature expected')
      },
    })
  const executor = boot()
  executor.agents.create({
    id: 'scout',
    operator: operator.address,
    privyUserId: 'did:privy:fixture',
    name: 'Scout',
    registry: context.deployment.identity,
    chainId: context.deployment.chainId,
  })
  executor.agents.bindWallet('scout', 'agent-wallet', agent.address)
  for (const state of ['upgraded', 'grants-live', 'registered', 'active'] as const)
    executor.agents.advance('scout', state)
  const grants = new GrantStore(sql, context)
  const weekly = grants.prepare(operator.address, {
    kind: 'allowance',
    delegator: operator.address,
    agent: agent.address,
    token,
    amount: 300_000_000n,
    start: clock.now,
    salt: 1n,
  })
  await grants.confirm(weekly.hash, await operator.signTypedData(JSON.parse(weekly.typedData)))
  const publish = encodeFunctionData({
    abi: sdk.sidequestHoldingAbi,
    functionName: 'publish',
    args: [
      {
        token,
        reward: 260_000_000n,
        approver: agent.address,
        arbitrator: operator.address,
        manifestHash: sdk.EMPTY_HASH,
        policyHash: sdk.EMPTY_HASH,
        creatorBond: 10n ** 18n,
        workerBond: 0n,
        deliveryDeadline: clock.now + 86400,
        expiredAt: clock.now + 172800,
        reviewWindow: 3600,
        disputeWindow: 3600,
        arbitrationWindow: 43200,
      },
    ],
  })
  const input = {
    agentId: 'scout',
    boardId: 'original-board',
    operationKey: 'hire-over-budget',
    tool: 'create_task',
    args: { token, reward: '260' },
  }
  const execute = vi.fn(
    async (
      agentId: string,
      tool: string,
      args: Record<string, unknown>,
      operationKey: string,
      _approvalId?: string,
      boardId?: string,
    ) => boot().execute({ agentId, tool, args, operationKey, boardId: boardId! }),
  )
  const manage = (
    action: 'approval-prepare' | 'approval-decide' | 'approval-retry',
    id: string,
    body: Record<string, unknown> = {},
  ) =>
    agentManagement({
      request: { action, id, body },
      sql,
      context,
      operator: operator.address,
      bindings: {},
      relayKey: '0x',
      rpcUrl: '',
      now: () => clock.now,
      execute,
    })
  return {
    backing,
    sql,
    executor,
    input,
    manage,
    grants,
    weekly,
    operator,
    agent,
    token,
    submit,
    execute,
    signTypedData,
    clock,
    publish,
  }
}

it('requires backing behind the hosted publishing wallet even when the operator has stake', async () => {
  const f = await fixture()
  f.backing.available = 0n
  const error = await f.executor.execute(f.input).catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(BoardError)
  expect(agentFailureReply(error, 'Agent hire failed')).toMatchObject({
    reason: 'insufficient-backing',
    retry: 'after-operator',
    message: expect.stringContaining(f.agent.address.toLowerCase()),
  })
  expect(f.submit).not.toHaveBeenCalled()
})

it('publishes an over-budget hire after the exact operator signature and retries without another publish', async () => {
  const f = await fixture()
  expect(f.executor.deps.context.stack.kind).toBe('sidequest-v1')
  expect(f.grants.get(f.weekly.hash)?.status).toBe('live')
  const waiting = await f.executor.execute(f.input)
  expect(waiting.status).toBe('approval')
  if (waiting.status !== 'approval') throw new Error('Expected approval')
  expect(JSON.parse(waiting.approval.request_json)).toEqual({
    token: f.token,
    amount: '260000000',
    publish: f.publish,
    reason: 'allowance-unavailable',
  })
  expect(f.submit).not.toHaveBeenCalled()
  const prepared = (await f.manage('approval-prepare', waiting.operationId)) as { hash: Hex; typedData: string }
  const signature = await f.operator.signTypedData(JSON.parse(prepared.typedData))
  f.clock.now += 30 // Human signs after preparation; execution and retries use a later clock.
  const result = (await f.manage('approval-decide', waiting.operationId, {
    approved: true,
    signature,
  })) as AgentExecuteResult
  expect(result.status).toBe('confirmed')
  expect(f.executor.agents.approval(waiting.operationId).status).toBe('executed')
  expect(f.execute).toHaveBeenCalledWith(
    'scout',
    'create_task',
    f.input.args,
    f.input.operationKey,
    waiting.operationId,
    f.input.boardId,
  )
  const entries = f.submit.mock.calls[0]![1]
  expect(entries).toHaveLength(3)
  const [pull] = decodeGrantBatch(entries[0]!.calls[0]!.data as Hex)
  expect(sdk.delegationHash(pull!.grant)).toBe(prepared.hash)
  expect(decodeFunctionData({ abi: erc20Abi, data: pull!.execution.callData }).args).toEqual([
    f.agent.address,
    260_000_000n,
  ])
  expect(decodeFunctionData({ abi: erc20Abi, data: entries[1]!.calls[0]!.data as Hex }).args).toEqual([
    f.executor.deps.context.stack.holding,
    260_000_000n,
  ])
  expect(entries[2]!.calls[0]!.data).toBe(f.publish.toLowerCase())
  const signatures = f.signTypedData.mock.calls.length
  f.clock.now += 10
  // Management returns the executed approval; the original MCP key returns the original result.
  expect(await f.manage('approval-retry', waiting.operationId)).toMatchObject({ approval: { status: 'executed' } })
  expect(await f.executor.execute(f.input)).toEqual(result)
  expect(f.submit).toHaveBeenCalledTimes(1)
  expect(f.signTypedData).toHaveBeenCalledTimes(signatures)
  expect(f.grants.get(f.weekly.hash)?.status).toBe('live')
})

it('continues an approved unsent hire through approval-retry using the original signed grants', async () => {
  const f = await fixture()
  const waiting = await f.executor.execute(f.input)
  const prepared = (await f.manage('approval-prepare', waiting.operationId)) as { hash: Hex; typedData: string }
  f.clock.now += 30
  f.submit.mockRejectedValueOnce(new BoardError('unavailable', 'Relay unavailable; no hire sent'))
  await expect(
    f.manage('approval-decide', waiting.operationId, {
      approved: true,
      signature: await f.operator.signTypedData(JSON.parse(prepared.typedData)),
    }),
  ).rejects.toThrow('Relay unavailable')
  expect(f.executor.agents.approval(waiting.operationId).status).toBe('approved')
  expect(f.executor.agents.operation(waiting.operationId).sponsor_operation_id).toBeNull()
  const signatures = f.signTypedData.mock.calls.length
  f.clock.now += 10
  const result = await f.manage('approval-retry', waiting.operationId)
  expect(result).toMatchObject({ status: 'confirmed', operationId: waiting.operationId })
  expect(f.submit.mock.calls[1]).toEqual(f.submit.mock.calls[0])
  expect(f.signTypedData).toHaveBeenCalledTimes(signatures)
  expect(f.executor.agents.approval(waiting.operationId).status).toBe('executed')
  expect(f.grants.get(f.weekly.hash)?.status).toBe('live')
})

it.each([
  { invalid: 'weekly', message: 'Approved hire requires an exact one-off allowance', reason: 'approval-allowance' },
  {
    invalid: 'consumed',
    message: 'The approved exact allowance is unavailable; this operation has not been sent',
    reason: 'allowance-unavailable',
  },
])('names an approved $invalid allowance refusal on retry without sending', async ({ invalid, message, reason }) => {
  const f = await fixture()
  const waiting = await f.executor.execute(f.input)
  const prepared = (await f.manage('approval-prepare', waiting.operationId)) as { hash: Hex; typedData: string }
  f.submit.mockRejectedValueOnce(new BoardError('unavailable', 'Relay unavailable; no hire sent'))
  await expect(
    f.manage('approval-decide', waiting.operationId, {
      approved: true,
      signature: await f.operator.signTypedData(JSON.parse(prepared.typedData)),
    }),
  ).rejects.toThrow('Relay unavailable')
  if (invalid === 'weekly') {
    f.sql.run(
      'UPDATE approvals SET decision_json=? WHERE id=?',
      JSON.stringify({ allowanceHash: f.weekly.hash }),
      waiting.operationId,
    )
  } else {
    vi.mocked(f.executor.deps.context.publicClient.readContract).mockImplementation(async (request) => {
      if (request.functionName === 'minimumCreatorBond') return 10n ** 18n
      if (request.functionName === 'unfilledForfeitBps') return 2500
      if (request.functionName === 'CANCEL_GRACE') return 600
      if (request.functionName === 'treasury') return f.executor.deps.context.deployment.sidequest!.safe
      if (request.functionName === 'availableOf') return 10n ** 18n
      if (request.functionName === 'disabledDelegations') return false
      if (request.functionName === 'callCounts') return request.args?.includes(prepared.hash) ? 1n : 0n
      throw new Error(`Unexpected chain read: ${request.functionName}`)
    })
  }
  const signatures = f.signTypedData.mock.calls.length
  const error = await f.manage('approval-retry', waiting.operationId).catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(BoardError)
  expect(agentFailureReply(error, 'Agent management failed')).toEqual({
    ok: false,
    code: 'conflict',
    message,
    reason,
    retry: 'after-operator',
  })
  expect(f.submit).toHaveBeenCalledTimes(1)
  expect(f.signTypedData).toHaveBeenCalledTimes(signatures)
})

it.each([
  { field: 'publish', value: undefined, message: 'One-off approval requires the frozen publish for this operation' },
  { field: 'amount', value: '259000000', message: 'One-off approval differs from the frozen publish' },
])(
  'names the $field validation failure after approval and on retry, without sending',
  async ({ field, value, message }) => {
    const f = await fixture()
    const waiting = await f.executor.execute(f.input)
    const prepared = (await f.manage('approval-prepare', waiting.operationId)) as { hash: Hex; typedData: string }
    const request = JSON.parse(f.executor.agents.approval(waiting.operationId).request_json) as Record<string, unknown>
    request[field] = value
    f.sql.run('UPDATE approvals SET request_json=? WHERE id=?', JSON.stringify(request), waiting.operationId)
    const assertFailure = async (action: 'approval-decide' | 'approval-retry', body: Record<string, unknown> = {}) => {
      const error = await f.manage(action, waiting.operationId, body).catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(BoardError)
      const log = vi.fn()
      expect(agentFailureReply(error, 'Agent management failed', log)).toMatchObject({
        ok: false,
        code: 'conflict',
        message,
      })
      expect(log).not.toHaveBeenCalled()
    }
    await assertFailure('approval-decide', {
      approved: true,
      signature: await f.operator.signTypedData(JSON.parse(prepared.typedData)),
    })
    expect(f.executor.agents.approval(waiting.operationId).status).toBe('approved')
    await assertFailure('approval-retry')
    expect(f.submit).not.toHaveBeenCalled()
    expect(f.signTypedData).toHaveBeenCalledTimes(3) // Only routine gas grants, no one-off approval signature.
  },
)

// A declined over-budget pick reopens its quote request when the operator decides, not on the agent's next call.
it('reopens a declined over-budget pick at once, and runs nothing for any other decision', async () => {
  const execute = vi.fn(async () => ({ status: 'rejected', next: { tool: 'list_quotes', args: { requestId: 'r1' } } }))
  const pick = {
    tool: 'pick_quote',
    intent_json: JSON.stringify({ requestId: 'r1', quoteId: 'q1' }),
    action_key: 'pick-1',
    board_id: 'public',
  }
  const declined = { id: '0xop', kind: 'hire-over-limit' as const, status: 'rejected' as const, agent_id: 'scout' }
  expect(await reopenDeclinedPick(declined, pick, execute)).toEqual({ reopened: true })
  expect(execute).toHaveBeenCalledWith(
    'scout',
    'pick_quote',
    { requestId: 'r1', quoteId: 'q1' },
    'pick-1',
    '0xop',
    'public',
  )
  execute.mockClear()
  expect(await reopenDeclinedPick({ ...declined, kind: 'unstake' }, pick, execute)).toEqual({})
  expect(await reopenDeclinedPick(declined, { ...pick, tool: 'create_task' }, execute)).toEqual({})
  expect(await reopenDeclinedPick({ ...declined, status: 'approved' }, pick, execute)).toEqual({})
  expect(execute).not.toHaveBeenCalled()
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(await reopenDeclinedPick(declined, pick, boardUnavailable)).toEqual({ reopened: false })
  } finally {
    spy.mockRestore()
  }
})

async function boardUnavailable(): Promise<never> {
  throw new Error('board unavailable')
}
