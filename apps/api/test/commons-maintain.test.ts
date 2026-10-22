/** ADR-0028: a hosted agent acts as a Commons role holder over MCP only with its operator's sidequest:maintain grant. */
import { SPONSOR_OBJECT_NAME } from '@sidequest/board'
import { COMMONS_OBJECT_NAME, commonsRoleTools } from '@sidequest/commons'
import { Schema } from 'effect'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runAgent, type AgentExecuteRequest } from '../src/agent-runtime.ts'
import type { BoardCall } from '../src/board.ts'
import { resource, setupFixture } from './setup-oauth-fixture.ts'

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

const Redirect = Schema.Struct({ result: Schema.Struct({ redirectUrl: Schema.String }) })
const Token = Schema.Struct({ access_token: Schema.String, scope: Schema.String })
const env: AgentExecuteRequest['env'] = {
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
}

/**
 * Quill, a working agent, connected by a client that asked for the Commons role tools; the operator ticks them or not.
 * The Board namespace double stands in for the Commons object and records what reaches it.
 */
async function fixture(maintain: boolean) {
  const f = setupFixture()
  fixtures.push(f)
  const agent = f.active('quill')
  f.agents.setRoles('quill', ['work'])
  const consent = await f.request('sidequest:read sidequest:work sidequest:maintain')
  const approved = await f.route(`/oauth/requests/${consent.requestId}/approve`, { agentIds: ['quill'], maintain })
  const code = new URL(Schema.decodeUnknownSync(Redirect)(approved?.body).result.redirectUrl).searchParams.get('code')!
  const token = Schema.decodeUnknownSync(Token)(
    (
      await f.route('/oauth/token', {
        grant_type: 'authorization_code',
        client_id: consent.clientId,
        resource,
        redirect_uri: 'http://127.0.0.1:3210/callback',
        code,
        code_verifier: 'a'.repeat(43),
      })
    )?.body,
  )
  const calls: Array<{ object: string; req: BoardCall }> = []
  const bindings = {
    NETWORK: 'monad-testnet',
    // The hosted desk sends user operations; a role action has no transaction, so nothing is sent.
    HOSTED_SEND: 'userop',
    Board: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id: { toString(): string }) => ({
        call: async (req: BoardCall) => {
          calls.push({ object: id.toString(), req })
          return JSON.stringify({ ok: true, result: { gap: { id: 3, status: 'fixed' }, logSeq: 4 } })
        },
      }),
    },
  }
  const run = async (tool: string, args: Record<string, unknown>) =>
    JSON.parse(
      await runAgent({
        req: { tool, args, agentId: 'quill', resource, bearer: token.access_token, env },
        sql: f.sql,
        stateId: SPONSOR_OBJECT_NAME,
        bindings,
      }),
    )
  return { ...f, agent, token, calls, run }
}

it('runs a role tool as the agent wallet with its operation key, and a replay answers without calling again', async () => {
  const f = await fixture(true)
  expect(f.token.scope).toBe('sidequest:maintain sidequest:read sidequest:work')
  const args = { gapId: 3, status: 'fixed', reason: 'The docs now cover it' }
  const reply = await f.run('set_gap_status', { ...args, operationKey: 'gap-3-fixed' })
  expect(reply).toMatchObject({
    ok: true,
    result: { status: 'confirmed', result: { gap: { id: 3, status: 'fixed' }, logSeq: 4 } },
  })
  expect(f.calls).toHaveLength(1)
  const [reached] = f.calls
  // The Commons object authenticates the caller as this connection's agent and checks its wallet against the roles.
  expect(reached!.object).toBe(COMMONS_OBJECT_NAME)
  expect(reached!.req).toMatchObject({
    tool: 'set_gap_status',
    caller: f.agent.address,
    bearer: f.token.access_token,
    agentAuth: { agentId: 'quill', resource },
    args: { ...args, idempotencyKey: reply.result.operationId },
  })
  expect(reached!.req.agentAuth).not.toHaveProperty('operator')
  expect(reached!.req.args).not.toHaveProperty('operationKey')
  expect(await f.run('set_gap_status', { ...args, operationKey: 'gap-3-fixed' })).toEqual(reply)
  expect(f.calls).toHaveLength(1)
})

it('refuses all seven role tools before any Commons call when the operator did not tick the opt-in', async () => {
  const f = await fixture(false)
  expect(f.token.scope).toBe('sidequest:read sidequest:work')
  for (const tool of commonsRoleTools)
    await expect(f.run(tool, { operationKey: `key-${tool}`, reason: 'Duplicate report' })).rejects.toMatchObject({
      code: 'forbidden',
    })
  expect(f.calls).toEqual([])
  expect(f.sql.all('SELECT id FROM agent_operations')).toEqual([])
})
