import { afterEach, expect, it, vi } from 'vitest'
import { encodeFunctionData, keccak256, stringToHex } from 'viem'
import * as sdk from '@sidequest/sdk'
import { Match } from 'effect'
import { agentManagement } from '../src/agent-management.ts'
import { approvalDetails } from '../src/approval-details.ts'
import { setupFixture, operator, outsider } from './setup-oauth-fixture.ts'

const fixtures: ReturnType<typeof setupFixture>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.db.close()
})

function fixture() {
  const f = setupFixture()
  fixtures.push(f)
  f.active()
  const token = sdk.deployment('monad-testnet').factory
  const ask = (key: string, brief: string, tool = 'create_task') => {
    const taskId = `task-${key}`
    const manifest = JSON.stringify({
      taskId,
      title: 'A eulogy for Karl',
      brief,
      acceptanceCriteria: ['15 characters'],
    })
    const hash = keccak256(stringToHex(manifest))
    const operation = f.agents.begin('quill', key, 'original-board', tool, { title: 'Untrusted intent title' })
    f.agents.saveOperation(operation.id, 'prepared', { prepared: { taskId, manifest, secret: 'not for display' } })
    const publish = encodeFunctionData({
      abi: sdk.sidequestHoldingAbi,
      functionName: 'publish',
      args: [
        {
          token,
          reward: 40000n,
          creatorBond: 1000000n,
          workerBond: 0n,
          approver: operator,
          arbitrator: operator,
          manifestHash: hash,
          policyHash: hash,
          deliveryDeadline: 2000,
          expiredAt: 5000,
          reviewWindow: 1000,
          disputeWindow: 1000,
          arbitrationWindow: 1000,
        },
      ],
    })
    return f.agents.requestApproval(operation, 'hire-over-limit', { token, amount: '40000', publish })
  }
  const context = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const execute = vi.fn(async () => {
    throw new Error('Read must not execute')
  })
  const list = (owner = operator) =>
    agentManagement({
      request: { action: 'approvals', body: {} },
      sql: f.sql,
      context,
      operator: owner,
      bindings: {},
      relayKey: '0x',
      rpcUrl: '',
      now: f.now,
      execute,
    })
  return { ...f, ask, list, execute }
}

it('identifies same-title hires by their frozen brief, task, key and board in the owner API', async () => {
  const f = fixture()
  const old = f.ask('karl-v1', 'Open to all')
  const next = f.ask('karl-v2', 'Reserved for Agent Minimum')
  f.agents.decide(old.id, operator, false, {})
  // SAFETY: this request is the approvals branch of agentManagement.
  const response = (await f.list()) as { approvals: ReturnType<typeof approvalDetails>[] }
  expect(response.approvals).toHaveLength(2)
  expect(response.approvals.find((a) => a.id === next.id)).toMatchObject({
    status: 'pending',
    context: {
      operationKey: 'karl-v2',
      boardId: 'original-board',
      tool: 'create_task',
      hire: {
        taskId: 'task-karl-v2',
        title: 'A eulogy for Karl',
        brief: 'Reserved for Agent Minimum',
        creatorBond: '1000000',
      },
    },
  })
  expect(response.approvals.find((a) => a.id === old.id)).toMatchObject({
    status: 'rejected',
    context: { hire: { brief: 'Open to all' } },
  })
  expect(JSON.stringify(response)).not.toContain('Untrusted intent title')
  expect(JSON.stringify(response)).not.toContain('not for display')
  expect(await f.list(outsider)).toEqual({ approvals: [] })
  expect(f.execute).not.toHaveBeenCalled()
})

it('reads a picked quote from its frozen offer, even though its intent contains no brief', () => {
  const f = fixture()
  const approval = f.ask('picked-quote', 'Chosen quote brief', 'pick_quote')
  expect(approvalDetails(f.agents, approval).context.hire?.brief).toBe('Chosen quote brief')
})

it.each(['malformed', 'changed manifest', 'changed reward', 'missing'])(
  'refuses misleading context: %s',
  async (change) => {
    const f = fixture()
    const approval = f.ask('bad', 'Original brief')
    f.ask('good', 'Other request remains readable')
    if (change === 'changed reward') {
      const request = JSON.parse(approval.request_json)
      f.sql.run(
        'UPDATE approvals SET request_json=? WHERE id=?',
        JSON.stringify({ ...request, amount: '1' }),
        approval.id,
      )
    } else {
      const prepared = Match.value(change).pipe(
        Match.when('missing', () => null),
        Match.when('malformed', () => '{'),
        Match.orElse(() =>
          JSON.stringify({
            taskId: 'task-bad',
            manifest: JSON.stringify({
              taskId: 'task-bad',
              title: 'A eulogy for Karl',
              brief: 'Changed',
              acceptanceCriteria: [],
            }),
          }),
        ),
      )
      f.sql.run('UPDATE agent_operations SET prepared_json=? WHERE id=?', prepared, approval.operation_id)
    }
    // SAFETY: this request is the approvals branch of agentManagement.
    const response = (await f.list()) as { approvals: ReturnType<typeof approvalDetails>[] }
    expect(response.approvals.find((a) => a.id === approval.id)?.context.hire).toBeNull()
    expect(response.approvals.find((a) => a.id !== approval.id)?.context.hire?.brief).toBe(
      'Other request remains readable',
    )
  },
)
