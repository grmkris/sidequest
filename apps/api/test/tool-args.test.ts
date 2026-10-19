import { describe, expect, it, vi } from 'vitest'
import { agentFailureReply } from '@sidequest/board'
import { admitToolArgs, checkToolArgs, toolArgsMode } from '../src/tool-args.ts'
import { tools } from '../src/tools.ts'
import { agentTools } from '../src/tools-agents.ts'
import { directoryTools } from '../src/directory.ts'
import { tenantTools } from '../src/tools-tenant.ts'
import { telegramTools } from '../src/tools-telegram.ts'
import { feedTools } from '../src/feed.ts'
import { hostedMcpTools } from '../src/mcp-registry.ts'

const registries: Record<string, Record<string, { inputSchema?: object }>> = {
  tools,
  agentTools,
  directoryTools,
  tenantTools,
  telegramTools,
  feedTools,
  hostedMainnet: hostedMcpTools('monad-mainnet'),
  hostedTestnet: hostedMcpTools('monad-testnet'),
}

describe('every published tool schema', () => {
  it('compiles in the Worker-safe validator, accepts empty optional input shapes and is never annotated', () => {
    let count = 0
    for (const registry of Object.values(registries))
      for (const [name, tool] of Object.entries(registry)) {
        if (tool.inputSchema === undefined) continue
        const before = JSON.stringify(tool.inputSchema)
        const checked = checkToolArgs(tool.inputSchema, {})
        // A tool with no required arguments accepts {}; one with requirements names a missing field, never throws.
        if (!checked.ok) expect(checked.error.code, name).toBe('invalid')
        expect(JSON.stringify(tool.inputSchema), `${name} schema mutated`).toBe(before)
        count++
      }
    expect(count).toBeGreaterThan(200)
  })
})

describe('checkToolArgs', () => {
  const apply = tools.apply!.inputSchema

  it('turns a safe JSON integer into its decimal string where the schema says string', () => {
    const checked = checkToolArgs(apply, { taskId: 't1', agentId: 10415 })
    expect(checked).toEqual({ ok: true, args: { taskId: 't1', agentId: '10415' }, coerced: ['agentId'] })
  })

  it('refuses a fraction or an unsafe integer with the field path and a hint, never converting it', () => {
    for (const agentId of [10415.5, 2 ** 53 + 2]) {
      const checked = checkToolArgs(apply, { taskId: 't1', agentId })
      expect(checked.ok).toBe(false)
      if (checked.ok) continue
      const reply = agentFailureReply(checked.error, 'Invalid arguments')
      expect(reply).toMatchObject({ code: 'invalid', reason: 'invalid-arguments', retry: 'none', field: 'agentId' })
      expect(reply.message).toMatch(/^agentId: .*decimal string/)
    }
  })

  it('coerces nothing else: a boolean, an array or a string where a number is declared still fails', () => {
    expect(checkToolArgs(apply, { taskId: true, agentId: '1' })).toMatchObject({
      ok: false,
      error: { field: 'taskId' },
    })
    expect(checkToolArgs(apply, { taskId: ['t1'], agentId: '1' })).toMatchObject({ ok: false })
    const numeric = { type: 'object', properties: { limit: { type: 'number' } } }
    expect(checkToolArgs(numeric, { limit: '5' })).toMatchObject({ ok: false, error: { field: 'limit' } })
  })

  it('names nested fields and array items in the path', () => {
    const schema = {
      type: 'object',
      properties: {
        invite: {
          type: 'object',
          properties: { agentId: { type: 'string', pattern: '^\\d+$' } },
          required: ['agentId'],
        },
        tags: { type: 'array', items: { type: 'string', enum: ['coding'] } },
      },
    }
    expect(checkToolArgs(schema, { invite: { agentId: 7 } })).toMatchObject({
      ok: true,
      args: { invite: { agentId: '7' } },
    })
    expect(checkToolArgs(schema, { invite: { agentId: 'x' } })).toMatchObject({
      ok: false,
      error: { field: 'invite.agentId' },
    })
    expect(checkToolArgs(schema, { tags: ['coding', 'nope'] })).toMatchObject({
      ok: false,
      error: { field: 'tags[1]' },
    })
  })

  it('lets envelope keys through a closed schema without checking them, and keeps them in the arguments', () => {
    const closed = { type: 'object', properties: { taskId: { type: 'string' } }, additionalProperties: false }
    // A schema that declares and requires operationKey (setup_status) still leaves it to the hosted runtime.
    const declared = {
      type: 'object',
      properties: { operationKey: { type: 'string', minLength: 8 } },
      required: ['operationKey'],
      additionalProperties: false,
    }
    expect(checkToolArgs(declared, {})).toMatchObject({ ok: true })
    expect(checkToolArgs(declared, { operationKey: 'k' })).toMatchObject({ ok: true, args: { operationKey: 'k' } })
    const checked = checkToolArgs(closed, { taskId: 't', operationKey: 'k', managedAgentId: 'a', idempotencyKey: 'i' })
    expect(checked).toMatchObject({ ok: true, args: { taskId: 't', operationKey: 'k', managedAgentId: 'a' } })
    expect(checkToolArgs(closed, { taskId: 't', other: 1 })).toMatchObject({ ok: false })
  })
})

describe('admitToolArgs', () => {
  const apply = tools.apply!.inputSchema

  it('refuses in enforce mode and runs coerced in log mode, logging the tool and field but no values', () => {
    const log = vi.fn()
    const bad = { taskId: 't1', agentId: 7.5, note: 3 }
    expect(admitToolArgs('apply', apply, bad, 'enforce', log)).toMatchObject({ ok: false })
    const logged = admitToolArgs('apply', apply, bad, 'log', log)
    // Log mode still applies the one safe coercion (note 3 -> "3") and leaves the refused fraction as sent.
    expect(logged).toEqual({ ok: true, args: { taskId: 't1', agentId: 7.5, note: '3' } })
    expect(admitToolArgs('apply', apply, { taskId: 't1', agentId: 7 }, 'log', log)).toEqual({
      ok: true,
      args: { taskId: 't1', agentId: '7' },
    })
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      { event: 'tool-args-invalid', tool: 'apply', mode: 'enforce', field: expect.any(String) },
      { event: 'tool-args-invalid', tool: 'apply', mode: 'log', field: expect.any(String) },
      { event: 'tool-args-coerced', tool: 'apply', fields: ['agentId'] },
    ])
    expect(JSON.stringify(log.mock.calls)).not.toContain('7.5')
  })

  it('passes a tool without a schema through untouched', () => {
    const args = { anything: 1 }
    expect(admitToolArgs('testnet_faucet', undefined, args, 'enforce')).toEqual({ ok: true, args })
  })
})

describe('toolArgsMode', () => {
  it('logs on production, enforces elsewhere, and an explicit mode wins', () => {
    expect(toolArgsMode({ DEPLOY_STAGE: 'prod', NETWORK: 'monad-mainnet' })).toBe('log')
    expect(toolArgsMode({ NETWORK: 'monad-mainnet' })).toBe('log')
    expect(toolArgsMode({ DEPLOY_STAGE: 'dev', NETWORK: 'monad-testnet' })).toBe('enforce')
    expect(toolArgsMode({})).toBe('enforce')
    expect(toolArgsMode({ DEPLOY_STAGE: 'prod', TOOL_ARGS_MODE: 'enforce' })).toBe('enforce')
    expect(toolArgsMode({ DEPLOY_STAGE: 'dev', TOOL_ARGS_MODE: 'log' })).toBe('log')
    expect(toolArgsMode({ DEPLOY_STAGE: 'prod', TOOL_ARGS_MODE: 'yes' })).toBe('log')
  })
})
