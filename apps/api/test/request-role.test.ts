import { AgentRoles } from '@sidequest/board'
import { Schema } from 'effect'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runAgent, type AgentExecuteRequest } from '../src/agent-runtime.ts'
import { permittedTool, requiredToolScope, toolAnnotations } from '../src/mcp-policy.ts'
import { agentTools } from '../src/tools-agents.ts'
import { operator, resource, setupFixture } from './setup-oauth-fixture.ts'

const fixtures: ReturnType<typeof setupFixture>[] = []
// The runtime resolves tokens against the wall clock; the fixture mints them at t=1000 s.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000_000)
})
afterEach(() => {
  vi.useRealTimers()
  for (const f of fixtures.splice(0)) f.db.close()
})

const Reply = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.Struct({
    status: Schema.String,
    approveUrl: Schema.optionalKey(Schema.String),
    approval: Schema.optionalKey(Schema.Struct({ id: Schema.String, kind: Schema.String })),
    result: Schema.optionalKey(Schema.Unknown),
  }),
})

/** Quill, allowed to work only, connected directly by a client that asked for read and hire. */
async function fixture() {
  const f = setupFixture()
  fixtures.push(f)
  f.active('quill')
  f.agents.setRoles('quill', ['work'])
  const consent = await f.request('sidequest:read sidequest:hire')
  const approved = await f.route(`/oauth/requests/${consent.requestId}/approve`, { agentIds: ['quill'] })
  const code = new URL(
    Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Struct({ redirectUrl: Schema.String }) }))(approved?.body)
      .result.redirectUrl,
  ).searchParams.get('code')!
  const token = await f.route('/oauth/token', {
    grant_type: 'authorization_code',
    client_id: consent.clientId,
    resource,
    redirect_uri: 'http://127.0.0.1:3210/callback',
    code,
    code_verifier: 'a'.repeat(43),
  })
  const bearer = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }))(token?.body).access_token
  const ask = async (args: Record<string, unknown>) => {
    const req: AgentExecuteRequest = {
      tool: 'request_role',
      args,
      agentId: 'quill',
      resource,
      bearer,
      env: {
        network: 'monad-testnet',
        boardId: 'team-board',
        rpcUrl: '',
        domain: 'board.example',
        uri: 'https://board.example',
        manifestBaseUrl: '',
        screening: { baseUrl: '', apiKey: '', model: '' },
        attesterKey: '',
        relayKey: '',
        github: { appId: '', privateKeyPem: '', installationId: '' },
      },
    }
    const reply = await runAgent({
      req,
      sql: f.sql,
      stateId: 'management',
      bindings: {
        NETWORK: 'monad-testnet',
        Board: { idFromName: () => ({ toString: () => 'management' }), get: () => ({}) },
      },
    })
    return Schema.decodeUnknownSync(Reply)(JSON.parse(reply))
  }
  return { ...f, ask }
}

// ADR-0021: an agent asks its operator for a role; the operator's approval adds it, and nothing else does.
it('asks the operator once, answers every retry, and confirms once the operator allows it', async () => {
  const f = await fixture()
  const args = { role: 'hire', reason: 'post a logo job', operationKey: 'ask-hire' }
  const asked = await f.ask(args)
  expect(asked.result).toMatchObject({ status: 'approval', approval: { kind: 'role' } })
  expect(asked.result.approveUrl).toContain(`approval=${asked.result.approval!.id}`)
  expect((await f.ask(args)).result.approval?.id).toBe(asked.result.approval!.id)
  expect(f.agents.roles('quill')).toEqual(['work'])
  new AgentRoles(f.agents).decide(f.agents.approval(asked.result.approval!.id), operator, true)
  expect(await f.ask(args)).toMatchObject({ ok: true, result: { status: 'confirmed', result: { role: 'hire' } } })
  expect(f.agents.roles('quill').toSorted()).toEqual(['hire', 'work'])
  const held = await f.ask({ role: 'work', operationKey: 'ask-work' })
  expect(held.result.status).toBe('confirmed')
})

it('needs a stable operationKey and refuses anything but a role and a short reason', async () => {
  const f = await fixture()
  await expect(f.ask({ role: 'hire' })).rejects.toMatchObject({ code: 'invalid' })
  await expect(f.ask({ role: 'admin', operationKey: 'k' })).rejects.toThrow()
  await expect(f.ask({ role: 'hire', reason: 'x'.repeat(281), operationKey: 'k' })).rejects.toThrow()
  await expect(f.ask({ role: 'hire', amount: '1', operationKey: 'k' })).rejects.toThrow()
  expect(f.agents.approvals(operator)).toEqual([])
})

it('is a reviewed write any connection may call, distinct from the Commons roles', () => {
  expect(Object.hasOwn(agentTools, 'request_role')).toBe(true)
  expect(requiredToolScope('request_role')).toBe('sidequest:read')
  expect(permittedTool({ scopes: ['sidequest:read'] }, 'request_role')).toBe(true)
  expect(toolAnnotations('request_role')).toEqual({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  })
  expect(agentTools.request_role.description).toContain('Not the Commons list_roles')
})
