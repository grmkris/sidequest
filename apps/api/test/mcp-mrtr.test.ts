import { agentOperationId } from '@sidequest/board'
import { Schema } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { mcpRoute } from '../src/mcp.ts'
import { agentFirstMcpRoute } from '../src/mcp-agent-setup.ts'
import { approvalPrompt, inputRequired, mrtrRetry, urlElicitation } from '../src/mcp-mrtr.ts'
import type { OAuthGrant } from '../src/oauth.ts'

const capable = (elicitation: unknown) => ({
  _meta: { 'io.modelcontextprotocol/clientCapabilities': { elicitation } },
})

it('reads URL elicitation support from the per-request client capabilities', () => {
  expect(urlElicitation(capable({ form: {}, url: {} }))).toBe(true)
  expect(urlElicitation(capable({ form: {} }))).toBe(false)
  expect(urlElicitation(capable({}))).toBe(false)
  expect(urlElicitation({})).toBe(false)
})

it('reads a retry: its state and the answer to the approval prompt', () => {
  expect(mrtrRetry({ name: 'request_role' })).toBeUndefined()
  expect(mrtrRetry({ requestState: 'op', inputResponses: { approval: { action: 'accept' } } })).toEqual({
    state: 'op',
    action: 'accept',
  })
  expect(mrtrRetry({ requestState: 'op' })).toEqual({ state: 'op', action: undefined })
  expect(mrtrRetry({ requestState: 'op', inputResponses: { approval: { action: 'later' } } })).toBeUndefined()
})

it('prompts for a pending approval or a new agent, and never for anything else', () => {
  const approval = {
    ok: true,
    result: {
      status: 'approval',
      operationId: '0xop',
      approveUrl: 'https://dev.sidequest.exchange/agent/41?tab=approvals&approval=0xop',
      approval: { id: '0xop', kind: 'role' },
    },
  }
  const prompt = approvalPrompt('request_role', approval)!
  expect(prompt).toMatchObject({ url: approval.result.approveUrl, state: '0xop' })
  expect(prompt.message).toContain('a new role')
  expect(inputRequired(prompt)).toEqual({
    resultType: 'input_required',
    inputRequests: {
      approval: { method: 'elicitation/create', params: { mode: 'url', message: prompt.message, url: prompt.url } },
    },
    requestState: '0xop',
  })
  const created = {
    ok: true,
    result: { agentKey: 'setup_abc', approveUrl: 'https://x/agents/approve/setup_abc', profile: { name: 'Quill' } },
  }
  expect(approvalPrompt('create_agent', created)).toMatchObject({ state: 'setup_abc', url: created.result.approveUrl })
  expect(approvalPrompt('create_task', { ok: true, result: { status: 'confirmed' } })).toBeUndefined()
  expect(approvalPrompt('create_agent', { ok: false })).toBeUndefined()
})

const modern = (capabilities: Record<string, unknown> = { elicitation: { url: {} } }) => ({
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': capabilities,
})
/** A tool backend that answers each call with the next prepared output. */
const call = (outputs: unknown[]) => vi.fn(async () => outputs.shift())
/** An MCP reply's JSON-RPC body. */
const Body = Schema.Struct({
  result: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Number })),
})
const result = (reply: { body?: unknown }) => Schema.decodeUnknownSync(Body)(reply.body).result
const errorCode = (reply: { body?: unknown }) => Schema.decodeUnknownSync(Body)(reply.body).error?.code

// ADR-0021 through the real router: the 2026 lane prompts natively, the legacy lane keeps the link.
describe('native approvals on the 2026 lane', () => {
  const origin = 'https://sidequest.test'
  const grant: OAuthGrant = {
    owner: 'operator',
    address: '0x1111111111111111111111111111111111111111',
    chainId: 10143,
    scopes: ['sidequest:read', 'sidequest:hire'],
    agentIds: ['a1'],
    registryAgentId: '7',
    clientId: 'c',
    resource: `${origin}/mcp`,
  }
  const operationId = agentOperationId('a1', 'hire-logo')
  const approvalOutput = {
    ok: true,
    result: {
      status: 'approval',
      operationId,
      approveUrl: `${origin}/agent/7?tab=approvals&approval=${operationId}`,
      approval: { id: operationId, kind: 'hire-over-limit', status: 'pending' },
    },
  }
  const route = (params: Record<string, unknown>, fn: ReturnType<typeof call>, id = 1) =>
    mcpRoute({
      method: 'POST',
      pathname: '/mcp',
      origin,
      headers: {},
      body: { jsonrpc: '2.0', id, method: 'tools/call', params },
      grant,
      tools: { create_task: { description: 'Post a job' } },
      call: fn,
    })
  const args = { operationKey: 'hire-logo', reward: '30' }

  it('asks for the approval URL, then completes the same call once the operator decided', async () => {
    const fn = call([approvalOutput, approvalOutput, { ok: true, result: { status: 'confirmed', operationId } }])
    const first = await route({ name: 'create_task', arguments: args, _meta: modern() }, fn)
    expect(result(first)).toEqual({
      resultType: 'input_required',
      inputRequests: {
        approval: {
          method: 'elicitation/create',
          params: {
            mode: 'url',
            message: expect.stringContaining('weekly allowance'),
            url: approvalOutput.result.approveUrl,
          },
        },
      },
      requestState: operationId,
    })
    const retry = { name: 'create_task', arguments: args, _meta: modern(), requestState: operationId }
    const waiting = await route({ ...retry, inputResponses: { approval: { action: 'accept' } } }, fn, 2)
    expect(result(waiting)).toMatchObject({ resultType: 'input_required' })
    const done = await route({ ...retry, inputResponses: { approval: { action: 'accept' } } }, fn, 3)
    expect(result(done)).toMatchObject({
      resultType: 'complete',
      structuredContent: { result: { status: 'confirmed' } },
    })
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('ends a closed prompt with the link, refuses a state from another call, and keeps the link without URL support', async () => {
    const fn = call([approvalOutput])
    const closed = await route(
      {
        name: 'create_task',
        arguments: args,
        _meta: modern(),
        requestState: operationId,
        inputResponses: { approval: { action: 'decline' } },
      },
      fn,
    )
    expect(result(closed)).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining(approvalOutput.result.approveUrl) }],
    })
    const forged = await route({ name: 'create_task', arguments: args, _meta: modern(), requestState: '0xother' }, fn)
    expect(errorCode(forged)).toBe(-32602)
    expect(fn).toHaveBeenCalledTimes(1)
    const linked = await route({ name: 'create_task', arguments: args, _meta: modern({}) }, call([approvalOutput]))
    expect(result(linked)).toMatchObject({
      resultType: 'complete',
      structuredContent: { result: { approveUrl: approvalOutput.result.approveUrl } },
    })
  })

  it('leaves the legacy lane exactly as it was', async () => {
    const legacy = await route({ name: 'create_task', arguments: args }, call([approvalOutput]))
    expect(result(legacy)).not.toHaveProperty('resultType')
    expect(result(legacy)).toMatchObject({
      structuredContent: { result: { approveUrl: approvalOutput.result.approveUrl } },
    })
  })

  it('finishes create_agent once this connection acts as the approved agent, and asks again while it waits', async () => {
    const created = {
      ok: true,
      result: { agentKey: 'a1', approveUrl: `${origin}/agents/approve/a1`, profile: { name: 'Quill' } },
    }
    const retry = { name: 'create_agent', arguments: {}, _meta: modern(), requestState: 'a1' }
    const settled = await route(retry, call([]))
    expect(result(settled)).toMatchObject({
      resultType: 'complete',
      structuredContent: { result: { agentKey: 'a1', agentId: '7', state: 'ready' } },
    })
    const setup = {
      ...grant,
      scopes: ['sidequest:read', 'sidequest:setup'],
      setup: true,
      agentIds: [],
      registryAgentId: null,
    }
    // Production wraps a setup connection so its calls run as the operator, never as an agent.
    const setupRoute = (status: unknown) =>
      agentFirstMcpRoute({
        method: 'POST',
        pathname: '/mcp',
        origin,
        headers: {},
        body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: retry },
        grant: setup,
        tools: { whoami: { description: 'Who' }, create_agent: { description: 'Create an agent' } },
        call: call([created, status]),
      })
    const waiting = await setupRoute({ ok: true, result: { state: 'awaiting-approval' } })
    expect(result(waiting)).toMatchObject({
      resultType: 'input_required',
      requestState: 'a1',
    })
    const stopped = { ok: true, result: { state: 'failed', message: 'Hosted access to this agent was stopped.' } }
    const failed = await setupRoute(stopped)
    expect(result(failed)).toMatchObject({
      resultType: 'complete',
      structuredContent: stopped,
    })
  })
})
