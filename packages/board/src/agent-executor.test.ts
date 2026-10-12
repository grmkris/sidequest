import { afterEach, expect, it, vi } from 'vitest'
import * as sdk from '@sidequest/sdk'
import { type Hex, encodeFunctionData, erc20Abi } from 'viem'
import { userOpFixture } from './test/userop-fixture.ts'
import { AgentExecutor, type AgentPreparedCall, type AgentToolRequest } from './agent-executor.ts'
import { SponsorDesk } from './sponsor.ts'
import { BoardError } from './board-error.ts'
import { AgentOnboarding } from './agent-onboarding.ts'
import { AgentLifecycle } from './agent-lifecycle.ts'
import { decodeGrantBatch } from './hire-batch.ts'

const fixtures: ReturnType<typeof userOpFixture>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.db.close()
  vi.restoreAllMocks()
})
const txHash: Hex = `0x${'ef'.repeat(32)}`
function fixture(action?: AgentPreparedCall) {
  const f = userOpFixture()
  fixtures.push(f)
  const sponsor = new SponsorDesk({
    sql: f.sql,
    ctx: f.context,
    now: () => f.clock.now,
    fail: (code, message) => new BoardError(code, message),
  })
  const relayReady = vi.spyOn(sponsor, 'ready').mockRejectedValue(new Error('Relay must not be consulted'))
  const relaySend = vi.spyOn(sponsor, 'submit').mockRejectedValue(new Error('Relay must not send'))
  const prepare = vi.fn(async (request: AgentToolRequest): Promise<AgentPreparedCall> => {
    if (request.tool === 'report_transaction') return { reported: true }
    return (
      action ?? {
        taskId: 'task',
        transactions: [
          { ...f.input.calls[0]!, value: '0', description: 'Settle', chainId: f.context.deployment.chainId },
        ],
      }
    )
  })
  const deps = {
    sql: f.sql,
    context: f.context,
    signing: f.signing,
    sponsor,
    submitter: f.desk,
    now: () => f.clock.now,
    prepareTool: prepare,
    verifyToolSigning: async (request: AgentToolRequest & { typedData: string }) => request.typedData,
  }
  const executor = new AgentExecutor(deps)
  const input = {
    agentId: 'agent',
    boardId: 'public',
    operationKey: 'settle-1',
    tool: 'settlement_actions',
    args: { taskId: 'task' },
  }
  return { ...f, executor, deps, input, prepare, relayReady, relaySend, sponsor }
}

it('sends a hosted action through the real desk, resumes after restart and reports the bundle transaction once', async () => {
  const f = fixture()
  const pending = await f.executor.execute(f.input)
  expect(pending.status).toBe('pending')
  f.state.receipt = { success: true, actualGasCost: '0x33', receipt: { transactionHash: txHash } }
  const result = await new AgentExecutor(f.deps).execute(f.input)
  expect(result).toMatchObject({ status: 'confirmed', result: { userOperation: { txHash, status: 'confirmed' } } })
  expect(f.prepare).toHaveBeenCalledWith(
    expect.objectContaining({ tool: 'report_transaction', args: { taskId: 'task', txHash } }),
  )
  expect(await f.executor.execute(f.input)).toEqual(result)
  expect(f.state.sends).toBe(1)
  expect(f.relayReady).not.toHaveBeenCalled()
  expect(f.relaySend).not.toHaveBeenCalled()
  expect(f.grants.list(f.account.address)).toEqual([])
})
it('keeps a forced retry on the frozen action and original lane; check_operation readback sends nothing', async () => {
  const f = fixture()
  f.state.uncertain = true
  const pending = await f.executor.execute(f.input)
  expect(pending.status).toBe('pending')
  f.clock.now += 120
  expect(await f.desk.operation(pending.operationId)).toMatchObject({ status: 'dropped' })
  expect(f.state.sends).toBe(1)
  f.state.uncertain = false
  f.state.fee++
  await f.executor.execute(f.input)
  expect(f.state.sends).toBe(2)
  expect(f.prepare).toHaveBeenCalledTimes(1)
  expect(f.store.attempts(pending.operationId)).toHaveLength(2)
})
it('requires an operator gas budget without fallback to relay, and keeps the operation retryable', async () => {
  const f = fixture()
  f.sql.run("UPDATE grants SET status='revoked'")
  await expect(f.executor.execute(f.input)).rejects.toMatchObject({
    reason: 'gas-budget-required',
    retry: 'after-operator',
  })
  expect(f.state.sends).toBe(0)
  expect(f.relayReady).not.toHaveBeenCalled()
  expect(f.relaySend).not.toHaveBeenCalled()
  f.sql.run("UPDATE grants SET status='live'")
  expect((await f.executor.execute(f.input)).status).toBe('pending')
})
it('freezes user-operation transport, refusing a relay-only runtime when it resumes the same operation', async () => {
  const f = fixture()
  await f.executor.execute(f.input)
  const { submitter: _submitter, ...relayDeps } = f.deps
  await expect(new AgentExecutor(relayDeps).execute(f.input)).rejects.toMatchObject({ reason: 'aa-unavailable' })
  expect(f.relaySend).not.toHaveBeenCalled()
})
it('requires operator approval for unstaking and executes the exact approved shares without a relay grant signature', async () => {
  const base = fixture()
  const tx: sdk.TxRequest = {
    to: base.context.deployment.sidequest!.vault,
    value: '0',
    data: encodeFunctionData({
      abi: sdk.stakeVaultAbi,
      functionName: 'requestUndelegate',
      args: [base.account.address, 9n],
    }),
    description: 'Queue',
    chainId: base.context.deployment.chainId,
  }
  const action = { amount: '9', shares: '9', transactions: [tx] }
  const executor = new AgentExecutor({ ...base.deps, prepareTool: async () => action })
  const input = { ...base.input, tool: 'request_unstake' }
  const asked = await executor.execute(input)
  expect(asked.status).toBe('approval')
  expect(base.state.sends).toBe(0)
  if (asked.status !== 'approval') throw new Error('expected approval')
  base.agents.decide(asked.operationId, base.operator, true, {})
  expect((await executor.execute(input)).status).toBe('pending')
  expect(base.state.signs).toBe(1)
})
it('new agents become grants-live without relay upgrade or signatures, leaving 7702 for their first operation', async () => {
  const f = fixture()
  f.sql.run("UPDATE agents SET state='created',agent_id=NULL")
  const onboard = new AgentOnboarding({ ...f.deps, signerId: 'signer', policyId: 'policy' })
  expect(await onboard.resume('agent')).toMatchObject({ state: 'grants-live' })
  expect(f.state.signs).toBe(0)
  expect(f.state.sends).toBe(0)
  expect(f.grants.list(f.account.address)).toEqual([])
})
it('sweeps via the configured contract with an exact approval', async () => {
  const f = fixture()
  const transfer: sdk.TxRequest = {
    to: f.context.deployment.rewardTokens[0]!,
    value: '0',
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [f.operator, 99n] }),
    description: 'Sweep',
    chainId: f.context.deployment.chainId,
  }
  const sweep = new AgentExecutor({ ...f.deps, prepareTool: async () => ({ transactions: [transfer] }) })
  const pending = await sweep.execute({ ...f.input, tool: 'sweep_earnings' })
  const built = sdk.decodeExecuteCalldata(JSON.parse(f.store.require(pending.operationId).built_json!).op.callData)!
  expect(built[1]!.to.toLowerCase()).toBe(f.context.deployment.agentSweep!.toLowerCase())
})

it('attaches the frozen board evidence to a hosted submit and reuses it after a dropped attempt', async () => {
  const f = fixture()
  const evidence: sdk.SignedEvidenceAttestation = {
    attestation: {
      jobId: '1',
      submissionHash: sdk.hashText('delivery'),
      policyHash: sdk.hashText('policy'),
      repo: sdk.hashText('repo'),
      headSha: sdk.hashText('head'),
      testedSha: sdk.hashText('tested'),
      checkRunsHash: sdk.hashText('checks'),
      conclusion: 1,
      validUntil: String(f.clock.now + 3600),
    },
    verifier: f.context.deployment.attester,
    signature: '0x1234',
  }
  const prepareTool = vi.fn(async () => ({
    evidenceAttestation: evidence,
    transactions: [
      {
        to: f.context.deployment.core,
        value: '0',
        data: encodeFunctionData({
          abi: sdk.coreAbi,
          functionName: 'submit',
          args: [1n, evidence.attestation.submissionHash, '0x'],
        }),
        description: 'Submit',
        chainId: f.context.deployment.chainId,
      },
    ],
  }))
  const executor = new AgentExecutor({ ...f.deps, prepareTool })
  const input = { ...f.input, tool: 'submit_work' }
  const pending = await executor.execute(input)
  const built = sdk.decodeExecuteCalldata(JSON.parse(f.store.require(pending.operationId).built_json!).op.callData)!
  expect(built[1]).toEqual(sdk.attachEvidenceCall(f.context, evidence))
  f.clock.now += 120
  f.state.fee++
  await new AgentExecutor({ ...f.deps, prepareTool }).execute(input)
  expect(prepareTool).toHaveBeenCalledTimes(1)
  const retried = sdk.decodeExecuteCalldata(JSON.parse(f.store.require(pending.operationId).built_json!).op.callData)!
  expect(retried[1]).toEqual(built[1])
  expect(f.relaySend).not.toHaveBeenCalled()
})

it('preserves hire-over-limit approval and redeems the exact operator allowance once without relay signatures', async () => {
  const f = fixture()
  const token = f.context.deployment.rewardTokens[0]!
  const publish: sdk.TxRequest = {
    to: f.context.stack.holding,
    value: '0',
    data: encodeFunctionData({
      abi: sdk.sidequestHoldingAbi,
      functionName: 'publish',
      args: [
        {
          approver: f.operator,
          arbitrator: f.context.deployment.arbitrator,
          manifestHash: sdk.EMPTY_HASH,
          policyHash: sdk.EMPTY_HASH,
          token,
          reward: 100n,
          creatorBond: 1n,
          workerBond: 0n,
          deliveryDeadline: f.clock.now + 3600,
          expiredAt: f.clock.now + 86400,
          reviewWindow: 3600,
          disputeWindow: 3600,
          arbitrationWindow: 43200,
        },
      ],
    }),
    description: 'Publish',
    chainId: f.context.deployment.chainId,
  }
  const executor = new AgentExecutor({ ...f.deps, prepareTool: async () => ({ transactions: [publish] }) })
  const input = { ...f.input, tool: 'post_hire' }
  const asked = await executor.execute(input)
  if (asked.status !== 'approval') throw new Error('Expected hire-over-limit approval')
  const lifecycle = new AgentLifecycle({
    sql: f.sql,
    context: f.context,
    now: () => f.clock.now,
    sponsor: f.sponsor,
    hostedSend: 'userop',
  })
  const prepared = lifecycle.prepareApproval(asked.operationId, f.operator)
  if (!('hash' in prepared)) throw new Error('Expected exact reward allowance')
  const signature = await f.operatorAccount.sign({ hash: sdk.delegationDigest(f.context.deployment, prepared.grant) })
  await lifecycle.decideApproval(asked.operationId, f.operator, true, signature)
  const pending = await executor.execute(input)
  const built = sdk.decodeExecuteCalldata(JSON.parse(f.store.require(pending.operationId).built_json!).op.callData)!
  expect(sdk.delegationHash(decodeGrantBatch(built[0]!.data)[0]!.grant)).toBe(prepared.hash)
  expect(built[1]).toEqual(sdk.approveCall(token, f.context.stack.holding, 100n))
  expect(built[2]!.data).toBe(publish.data)
  f.state.receipt = { success: true, actualGasCost: '0x33', receipt: { transactionHash: txHash } }
  expect((await executor.execute(input)).status).toBe('confirmed')
  await executor.execute(input)
  expect(f.state.sends).toBe(1)
  expect(f.state.signs).toBe(1)
  expect(f.relayReady).not.toHaveBeenCalled()
  expect(f.relaySend).not.toHaveBeenCalled()
})
