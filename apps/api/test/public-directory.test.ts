import { Schema } from 'effect'
import type * as sdk from '@sidequest/sdk'
import { zeroAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { expect, it, vi } from 'vitest'
import { directoryTools, runDirectoryTool } from '../src/directory.ts'
import { mcpRoute, type McpReply } from '../src/mcp.ts'
import { PUBLIC_DIRECTORY_TOOLS, toolAnnotations } from '../src/mcp-policy.ts'
import { agentTools } from '../src/tools-agents.ts'
import { directoryFixture, listingService } from './directory-fixture.ts'

const object = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))

async function signPrepared(account: ReturnType<typeof privateKeyToAccount>, json: string) {
  // SAFETY: the endpoint returns standard EIP-712 JSON, which this test signs without the private SDK builder.
  const typed = JSON.parse(json) as {
    domain: Record<string, unknown>
    types: Record<string, Array<{ name: string; type: string }>>
    primaryType: string
    message: Record<string, string | bigint>
  }
  const { EIP712Domain: _domain, ...types } = typed.types
  const message = { ...typed.message }
  for (const field of types[typed.primaryType] ?? [])
    if (/^u?int\d*$/.test(field.type)) message[field.name] = BigInt(message[field.name]!)
  return account.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message })
}

const result = (reply: McpReply) => object(object(reply.body).result)
const route = (
  method: string,
  params: Record<string, unknown> = {},
  patch: Partial<Parameters<typeof mcpRoute>[0]> = {},
) =>
  mcpRoute({
    method: 'POST',
    pathname: '/mcp/directory',
    headers: {},
    origin: 'https://sidequest.test',
    body: { id: 1, method, params },
    publicDirectory: true,
    tools: { ...directoryTools, ...agentTools },
    call: async () => {
      throw new Error('unexpected call')
    },
    ...patch,
  })

it.each([{}, { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }])(
  'lists exactly the public tools with noauth and unchanged schemas (%j)',
  async (params) => {
    const tools = Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)))(
      result(await route('tools/list', params)).tools,
    )
    expect(tools.map((tool) => Schema.decodeUnknownSync(Schema.String)(tool.name)).toSorted()).toEqual(
      [...PUBLIC_DIRECTORY_TOOLS].toSorted(),
    )
    for (const tool of tools) {
      const name = Schema.decodeUnknownSync(Schema.String)(tool.name)
      expect(tool.securitySchemes).toEqual([{ type: 'noauth' }])
      expect(tool.annotations).toEqual(toolAnnotations(name))
      expect(tool.inputSchema).toEqual(
        Object.entries(directoryTools).find(([entry]) => entry === name)?.[1].inputSchema,
      )
      expect(tool.inputSchema).not.toHaveProperty('properties.operationKey')
    }
  },
)

it('negotiates both anonymous protocol lanes and keeps OAuth on /mcp', async () => {
  const initialized = await route('initialize', { protocolVersion: '2025-03-26' })
  expect(initialized.status).toBe(200)
  expect(result(initialized)).toMatchObject({
    protocolVersion: '2025-03-26',
    capabilities: { tools: { listChanged: false } },
  })
  const discovered = await route('server/discover')
  expect(discovered.status).toBe(200)
  expect(result(discovered)).toMatchObject({
    supportedVersions: ['2026-07-28'],
    capabilities: { tools: { listChanged: false } },
  })
  expect(result(discovered).instructions).toContain('sdk.directoryTypedData(record)')
  expect((await route('initialize', {}, { publicDirectory: false, pathname: '/mcp' })).status).toBe(401)
  expect((await route('initialize', {}, { method: 'GET' })).status).toBe(405)
  expect((await route('initialize', {}, { method: 'DELETE' })).status).toBe(204)
  expect(result(await route('ping'))).toEqual({})
  expect(result(await route('notifications/initialized'))).toEqual({})
  expect((await route('tools/list', {}, { body: { method: 'notifications/initialized' } })).status).toBe(202)
})

it.each(['events/list', 'events/stream', 'skills/list', 'resources/list', 'prompts/list', 'subscriptions/listen'])(
  'excludes %s from the public transport',
  async (method) => {
    expect(object((await route(method)).body)).toMatchObject({ error: { code: -32601 } })
  },
)

it.each(['advertise_service', 'create_task'])('cannot run hosted tool %s anonymously', async (name) => {
  const call = vi.fn()
  expect(result(await route('tools/call', { name, arguments: {} }, { call }))).toMatchObject({ isError: true })
  expect(call).not.toHaveBeenCalled()
})

it('binds public modern headers and rejects unsupported versions', async () => {
  expect(
    (
      await route(
        'tools/list',
        { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
        { headers: { 'mcp-method': 'tools/call' } },
      )
    ).status,
  ).toBe(400)
  expect((await route('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': 'bad' } })).status).toBe(400)
})

it('self-custody wallet enrolls, publishes, replays and revokes without OAuth; another wallet cannot sign', async () => {
  const context = await directoryFixture()
  try {
    const call = async (tool: string, args: Record<string, unknown>) => ({
      ok: true,
      result: await runDirectoryTool(context.deps, tool, args),
    })
    const invoke = async (name: string, args: Record<string, unknown>) =>
      result(await route('tools/call', { name, arguments: args }, { call }))
    const prepare = async (name: string, payload: Record<string, unknown>) => {
      const prepared = await invoke(name, { agentId: '2013', payload })
      const envelope = object(object(prepared.structuredContent).result)
      // SAFETY: successful prepare returns the validated envelope with a serialized EIP-712 message.
      return {
        record: envelope.record as sdk.DirectoryEnvelope,
        typedData: Schema.decodeUnknownSync(Schema.String)(envelope.typedData),
      }
    }
    const preparedEnrollment = await prepare('prepare_directory_enrollment', {
      profile: { name: 'Self-run researcher', description: '', services: ['Research'] },
      delegate: zeroAddress,
      adDelegate: false,
      grantExpiresAt: 0,
      enrolled: true,
    })
    const enrollment = preparedEnrollment.record
    const wrong = privateKeyToAccount(generatePrivateKey())
    expect(
      await invoke('enroll_directory', {
        record: enrollment,
        signature: await signPrepared(wrong, preparedEnrollment.typedData),
      }),
    ).toMatchObject({ isError: true, structuredContent: { code: 'forbidden' } })
    expect(context.service.state().mutations).toHaveLength(0)
    expect(
      await invoke('enroll_directory', {
        record: enrollment,
        signature: await signPrepared(context.key, preparedEnrollment.typedData),
      }),
    ).not.toHaveProperty('isError')
    const heartbeat = await prepare('prepare_heartbeat', {
      state: 'available',
      capacity: 1,
      sessionId: 'self-run-process',
      capabilitiesHash: `0x${'11'.repeat(32)}`,
      endpointHash: `0x${'22'.repeat(32)}`,
    })
    expect(
      await invoke('post_heartbeat', {
        record: heartbeat.record,
        signature: await signPrepared(context.key, heartbeat.typedData),
      }),
    ).not.toHaveProperty('isError')
    const preparedAd = await prepare('prepare_service_ad', listingService)
    const args = { record: preparedAd.record, signature: await signPrepared(context.key, preparedAd.typedData) }
    expect(await invoke('publish_service_ad', args)).not.toHaveProperty('isError')
    expect(await invoke('publish_service_ad', args)).toMatchObject({
      structuredContent: { result: { idempotent: true } },
    })
    expect(await invoke('find_services', {})).toMatchObject({
      structuredContent: { result: { services: [{ agentId: '2013', serviceId: 'research' }] } },
    })
    const revoke = await prepare('prepare_revoke_service_ad', { serviceId: 'research' })
    await invoke('revoke_service_ad', {
      record: revoke.record,
      signature: await signPrepared(context.key, revoke.typedData),
    })
    expect(await invoke('find_services', {})).toMatchObject({ structuredContent: { result: { services: [] } } })
  } finally {
    context.close()
  }
})
