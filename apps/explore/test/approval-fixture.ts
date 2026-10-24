import * as sdk from '@sidequest/sdk'
import { encodeFunctionData, keccak256, stringToHex } from 'viem'
import type { AgentApproval } from '../src/agent-api.ts'
import type { ManagedAgent } from '../src/api.ts'
import type { Page } from 'playwright-core'
import { installFetchMock, jsonResponse, type InitScriptRequest } from './init-script-mock.ts'

const operator = '0x1111111111111111111111111111111111111111'
const wallet = '0x2222222222222222222222222222222222222222'
const deployment = sdk.deployment('monad-testnet')
const token = deployment.factory
const agent: ManagedAgent = {
  id: 'grok',
  name: 'Grok Bot',
  address: wallet,
  agent_id: '10399',
  state: 'active',
  last_activity_at: null,
  revoke_json: '{}',
}

function request(version: number): AgentApproval {
  const hire = {
    taskId: `task-${version}`,
    title: 'A 4cm eulogy for Karl',
    brief: version === 1 ? 'Open to all\nWrite a eulogy.' : 'Reserved for Agent Minimum\nWrite a eulogy.',
    acceptanceCriteria: ['15 characters'],
    creatorBond: '1000000000000000000000000',
  }
  const termsHash = keccak256(stringToHex(JSON.stringify(hire)))
  const publish = encodeFunctionData({
    abi: sdk.sidequestHoldingAbi,
    functionName: 'publish',
    args: [
      {
        token,
        reward: 40000n * 10n ** 18n,
        creatorBond: BigInt(hire.creatorBond),
        workerBond: 0n,
        approver: operator,
        arbitrator: operator,
        manifestHash: termsHash,
        policyHash: termsHash,
        deliveryDeadline: 2000000000,
        expiredAt: 1999000000,
        reviewWindow: 1000,
        disputeWindow: 1000,
        arbitrationWindow: 1000,
      },
    ],
  })
  return {
    id: `v${version}`,
    agent_id: agent.id,
    operation_id: `op-${version}`,
    kind: 'hire-over-limit',
    status: 'pending',
    created_at: 1792390000 + version,
    request_json: JSON.stringify({ token, amount: String(40000n * 10n ** 18n), publish }),
    context: { operationKey: `karl-v${version}`, boardId: 'public', tool: 'create_task', hire: { ...hire, termsHash } },
  }
}

export function backend() {
  const writes: { path: string; body: Record<string, unknown> }[] = []
  return {
    approvals: [request(1), request(2)],
    agents: [agent],
    agentError: false,
    approvalsError: false,
    reads: 0,
    outcome: 'confirmed',
    loseResponse: false,
    holdAgents: Promise.resolve(),
    holdApprovals: Promise.resolve(),
    holdDecision: Promise.resolve(),
    writes,
  }
}

function preparedGrant() {
  const start = Math.floor(Date.now() / 1000) - 1
  const grant = sdk.buildGrant(
    { deployment, stack: deployment.stacks.main! },
    { kind: 'allowance-once', delegator: operator, agent: wallet, token, amount: 40000n * 10n ** 18n, start, salt: 1n },
  )
  return {
    hash: sdk.delegationHash(grant),
    grant: { ...grant, salt: String(grant.salt) },
    description: { validAfter: start },
  }
}

const send = (result: unknown) => jsonResponse({ ok: true, result })
const unavailable = () => jsonResponse({ ok: false, message: 'Records unavailable' }, 503)

export async function connectBackend(page: Page, state: ReturnType<typeof backend>) {
  await installFetchMock(page, async (input: InitScriptRequest) => {
    const pathname = new URL(input.url).pathname
    if (pathname === '/api/agents') {
      await state.holdAgents
      return state.agentError ? unavailable() : send({ agents: state.agents })
    }
    if (pathname === '/api/approvals') {
      state.reads++
      await state.holdApprovals
      return state.approvalsError ? unavailable() : send({ approvals: state.approvals })
    }
    const approval = state.approvals.find((item) => pathname.includes(`/${item.id}/`))
    if (approval === undefined) return unavailable()
    // SAFETY: fixture callers send JSON objects through agentEndpoint; no live input reaches this test backend.
    const body = JSON.parse(input.body || '{}') as Record<string, unknown>
    state.writes.push({ path: pathname, body })
    if (pathname.endsWith('/prepare')) {
      return send(preparedGrant())
    }
    approval.status = body.approved === false ? 'rejected' : 'approved'
    await state.holdDecision
    if (body.approved === false) return send({ approval })
    if (state.outcome === 'confirmed') approval.status = 'executed'
    if (state.loseResponse) throw new Error('simulated lost response')
    return send({ status: state.outcome, operationId: approval.operation_id })
  })
}
