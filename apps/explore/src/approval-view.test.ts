import * as sdk from '@sidequest/sdk'
import { type AbiParameter, encodeFunctionData } from 'viem'
import { describe, expect, it } from 'vitest'
import type { AgentApproval } from './agent-api.ts'
import { approvalLine, jobOfLine, publishedPolicyHash, splitApprovals } from './approval-view.ts'

const deployment = sdk.deployment('monad-testnet')
const token = deployment.rewardTokens[0]!
const policy = `0x${'ab'.repeat(32)}` as const

/** A zero value of any ABI type, so a real `publish` call can be encoded without restating PublishParams here. */
function zero(p: AbiParameter): unknown {
  if (p.type === 'tuple')
    return Object.fromEntries((p as { components: readonly AbiParameter[] }).components.map((c) => [c.name, zero(c)]))
  if (p.type.endsWith('[]')) return []
  if (p.type === 'address') return '0x0000000000000000000000000000000000000000'
  if (p.type === 'bool') return false
  if (p.type === 'string') return ''
  if (p.type.startsWith('bytes')) return p.type === 'bytes' ? '0x' : `0x${'00'.repeat(Number(p.type.slice(5)))}`
  return 0n
}
const publishAbi = sdk.sidequestHoldingAbi.find((f) => f.type === 'function' && f.name === 'publish')!
const params = zero(publishAbi.inputs[0]!) as Record<string, unknown>
const publish = encodeFunctionData({
  abi: sdk.sidequestHoldingAbi,
  functionName: 'publish',
  args: [{ ...params, token, reward: 12_000_000n, policyHash: policy }] as never,
})

const approval = (over: Partial<AgentApproval>): AgentApproval => ({
  id: 'x',
  agent_id: 'a',
  operation_id: 'op',
  kind: 'hire-over-limit',
  status: 'pending',
  request_json: '{}',
  ...over,
})

describe('approval lines', () => {
  it('keeps two identical hires distinguishable by their frozen request context', () => {
    const first = approval({
      context: {
        operationKey: 'karl-v1',
        boardId: 'public',
        tool: 'create_task',
        hire: {
          taskId: 'old',
          title: 'A 4cm eulogy',
          brief: 'Open to all',
          acceptanceCriteria: [],
          termsHash: policy,
          creatorBond: '1000000',
        },
      },
    })
    const second = approval({
      context: {
        operationKey: 'karl-v2',
        boardId: 'public',
        tool: 'create_task',
        hire: {
          taskId: 'new',
          title: 'A 4cm eulogy',
          brief: 'Reserved for Agent Minimum',
          acceptanceCriteria: [],
          termsHash: policy,
          creatorBond: '1000000',
        },
      },
    })
    expect(approvalLine(first, token).title).toBe('A 4cm eulogy')
    expect(approvalLine(second, token).title).toBe('A 4cm eulogy')
  })

  it('reads a hire: its amount, and the policy hash that names the job it published', () => {
    expect(publishedPolicyHash(publish)).toBe(policy)
    expect(publishedPolicyHash('0xdeadbeef')).toBeNull()
    const line = approvalLine(
      approval({
        status: 'executed',
        decided_at: 50,
        request_json: JSON.stringify({ token, amount: '12000000', publish, reason: 'allowance-unavailable' }),
      }),
      deployment.factory,
    )
    expect(line).toMatchObject({
      title: 'Hire over the weekly budget',
      amount: { value: '12000000', token },
      status: 'executed',
      decidedAt: 50,
      policyHash: policy,
    })
    const job = { job_id: '131', policy_hash: policy.toUpperCase().replace('0X', '0x') }
    expect(jobOfLine(line, [{ job_id: '130', policy_hash: null }, job])).toBe(job)
    expect(jobOfLine({ ...line, status: 'approved' }, [job])).toBeUndefined()
  })

  it('reads leaving backing in SIDE and a permission with its cadence and adjustment', () => {
    expect(
      approvalLine(
        approval({ kind: 'unstake', request_json: JSON.stringify({ amount: '5', shares: '5' }) }),
        deployment.factory,
      ),
    ).toMatchObject({ title: 'Leave agent-owned backing', amount: { value: '5', token: deployment.factory } })
    const terms = {
      type: 'erc20-token-periodic',
      token,
      periodAmount: '10',
      periodDuration: 86_400,
      recipient: '0x3333333333333333333333333333333333333333',
    }
    const line = approvalLine(
      approval({
        kind: 'permission',
        status: 'executed',
        decision_json: JSON.stringify({ permissionHash: '0x1', standing: false, adjusted: true }),
        request_json: JSON.stringify({
          terms: JSON.stringify(terms),
          expiry: 1_791_000_000,
          adjustable: true,
          justification: null,
          standing: false,
        }),
      }),
      deployment.factory,
    )
    expect(line).toMatchObject({ title: 'Recurring transfer', amount: { value: '10', token }, adjusted: true })
    expect(line.detail).toMatch(/^every 1 d to 0x3333…3333 · until /)
    expect(approvalLine(approval({ kind: 'permission', request_json: 'not json' }), deployment.factory)).toMatchObject({
      title: 'Permission',
      amount: null,
    })
  })

  it('puts waiting decisions first in the order they came, then the rest newest answer first', () => {
    const list = [
      approval({ id: 'old-wait', created_at: 1 }),
      approval({ id: 'new-wait', created_at: 5 }),
      approval({ id: 'done-early', status: 'rejected', created_at: 2, decided_at: 3 }),
      approval({ id: 'done-late', status: 'executed', created_at: 2, decided_at: 9 }),
    ]
    const { waiting, past } = splitApprovals(list)
    expect(waiting.map((a) => a.id)).toEqual(['old-wait', 'new-wait'])
    expect(past.map((a) => a.id)).toEqual(['done-late', 'done-early'])
  })

  it('keeps approved unfinished hires and unstakes actionable after a reload, apart from terminal history', () => {
    const list = [
      approval({ id: 'hire-retry', status: 'approved', created_at: 2, decided_at: 4 }),
      approval({ id: 'unstake-retry', kind: 'unstake', status: 'approved', created_at: 1, decided_at: 3 }),
      approval({ id: 'permission', kind: 'permission', status: 'approved', created_at: 1, decided_at: 2 }),
      approval({ id: 'done', status: 'executed', created_at: 1, decided_at: 6 }),
      approval({ id: 'denied', status: 'rejected', created_at: 1, decided_at: 5 }),
      approval({ id: 'waiting', created_at: 7 }),
    ]
    expect(splitApprovals(list)).toMatchObject({
      waiting: [list[5]],
      recovering: [list[1], list[0]],
      past: [list[3], list[4], list[2]],
    })
  })

  // ADR-0021: an agent asks for a role; allowing it adds the role at once, so it never waits to be run again.
  it('reads a role request with the agent’s reason, and a decided one is history, never unfinished', () => {
    const asked = approval({ kind: 'role', request_json: JSON.stringify({ role: 'hire', reason: 'post a logo job' }) })
    expect(approvalLine(asked, '0xside')).toMatchObject({
      title: 'Let it hire other agents',
      amount: null,
      detail: 'post a logo job',
    })
    expect(approvalLine(approval({ kind: 'role', request_json: '{"role":"work"}' }), '0xside')).toMatchObject({
      title: 'Let it take and deliver jobs',
      detail: null,
    })
    const allowed = approval({ id: 'role', kind: 'role', status: 'approved', created_at: 1, decided_at: 2 })
    expect(splitApprovals([allowed])).toMatchObject({ waiting: [], recovering: [], past: [allowed] })
  })
})
