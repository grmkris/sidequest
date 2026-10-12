import { expect, it } from 'vitest'
import { Schema } from 'effect'
import { hostedToolNames } from '@sidequest/board'
import { AgentProfileUpdates, parseProfileInput } from '../src/agent-profiles.ts'
import { networkTool, permittedTool, requiredToolScope, toolAnnotations } from '../src/mcp-policy.ts'
import { agentTools } from '../src/tools-agents.ts'
import { mcpRoute } from '../src/mcp.ts'
import type { OAuthGrant } from '../src/oauth.ts'
import { fixture, origin, operator, png } from './agent-profile-fixture.ts'

it('validates profile fields through Schema before changing anything', () => {
  for (const input of [
    null,
    [],
    {},
    { name: '' },
    { name: 1 },
    { name: 'x'.repeat(81) },
    { description: 'x'.repeat(601) },
    { tagline: 'x'.repeat(121) },
    { avatar: { generate: ' ' } },
    { avatar: { url: 'https://elsewhere.example' } },
    { agentId: 'someone-else' },
  ])
    expect(() => parseProfileInput(input)).toThrow()
  expect(parseProfileInput({ name: ' Quill ', description: '', tagline: '' })).toEqual({
    name: 'Quill',
    description: '',
    tagline: '',
  })
})

it('journals the updated profile and reuses the generated avatar after restart or a lost response', async () => {
  const f = fixture()
  const input = { name: 'New name', description: 'Reviews code', tagline: 'Careful', avatar: { generate: 'a fox' } }
  const result = await f.boot().update('one', 'profile-1', input, 'agent')
  expect(result).toMatchObject({
    name: 'New name',
    description: 'Reviews code',
    tagline: 'Careful',
    image: expect.stringMatching(/\/avatars\/[0-9a-f]{64}\.png$/),
  })
  expect(await f.boot().update('one', 'profile-1', input, 'agent')).toEqual(result)
  expect(f.generations()).toBe(1)
  expect(f.files.size).toBe(1)
  expect(f.agents.begin('one', 'profile-1', 'public', 'update_profile', { ...input, updatedBy: 'agent' }).stage).toBe(
    'confirmed',
  )
  await expect(f.boot().update('one', 'profile-1', { name: 'Other' }, 'agent')).rejects.toMatchObject({
    code: 'conflict',
  })
  expect(f.boot().profiles.read('one').updatedBy).toBe('agent')
  // The summary reads the profile as it is now, so a later rename shows through.
  expect(f.boot().summary('one')).toEqual(result)
  await f.boot().update('one', 'profile-2', { name: 'Renamed' }, 'agent')
  expect(f.boot().summary('one')).toEqual({ ...result, name: 'Renamed' })
})

it('limits model attempts to ten per UTC day and never regenerates a completed key', async () => {
  const f = fixture()
  for (let i = 0; i < 10; i++) await f.boot().update('one', `avatar-${i}`, { avatar: { generate: 'fox' } }, 'agent')
  await expect(f.boot().update('one', 'avatar-10', { avatar: { generate: 'fox' } }, 'agent')).rejects.toMatchObject({
    code: 'conflict',
  })
  expect(f.generations()).toBe(10)
  await f.boot().update('one', 'avatar-0', { avatar: { generate: 'fox' } }, 'agent')
  expect(f.generations()).toBe(10)
  f.advance()
  await f.boot().update('one', 'avatar-10', { avatar: { generate: 'fox' } }, 'agent')
  expect(f.generations()).toBe(11)
})

it('charges failed model attempts and permits metadata edits without a model', async () => {
  const f = fixture()
  f.fail(true)
  for (let i = 0; i < 10; i++)
    await expect(f.boot().update('one', 'uncertain', { avatar: { generate: 'fox' } }, 'agent')).rejects.toThrow(
      'provider unavailable',
    )
  await expect(f.boot().update('one', 'uncertain', { avatar: { generate: 'fox' } }, 'agent')).rejects.toMatchObject({
    code: 'conflict',
  })
  expect(f.generations()).toBe(10)
  const noModel = new AgentProfileUpdates({
    sql: f.sql,
    now: () => 1_800_000_000,
    origin,
    boardId: 'public',
    directory: () => undefined,
  })
  expect(await noModel.update('one', 'text', { description: 'Still editable' }, 'owner')).toMatchObject({
    description: 'Still editable',
  })
  await expect(noModel.update('one', 'missing', { avatar: { generate: 'fox' } }, 'owner')).rejects.toMatchObject({
    code: 'unavailable',
  })
})

it('rejects an upload operation conflict before writing objects and reuses a completed upload', async () => {
  const f = fixture()
  const uploaded = await f.boot().upload('one', 'upload', png, 'owner')
  expect(await f.boot().upload('one', 'upload', png, 'owner')).toEqual(uploaded)
  await expect(f.boot().upload('one', 'upload', new Uint8Array([...png, 1]), 'owner')).rejects.toMatchObject({
    code: 'conflict',
  })
  expect(f.files.size).toBe(1)
  const operation = f.agents.begin('one', 'upload', 'public', 'update_profile', {
    avatar: { upload: f.boot().profiles.read('one').avatarKey },
    updatedBy: 'owner',
  })
  expect(operation.stage).toBe('confirmed')
})

it('makes update_profile a reviewed hosted write available with the read scope on either network', () => {
  expect(Object.hasOwn(agentTools, 'update_profile')).toBe(true)
  expect(hostedToolNames.has('update_profile')).toBe(true)
  expect(requiredToolScope('update_profile')).toBe('sidequest:read')
  expect(permittedTool({ scopes: ['sidequest:read'] }, 'update_profile')).toBe(true)
  expect(toolAnnotations('update_profile')).toEqual({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  })
  for (const network of ['monad-testnet', 'monad-mainnet']) expect(networkTool(network, 'update_profile')).toBe(true)
})

it('advertises the explicit operation key and profile limits in the MCP registry merge', async () => {
  const grant: OAuthGrant = {
    owner: operator,
    address: operator,
    chainId: 10143,
    scopes: ['sidequest:read'],
    agentIds: ['one'],
    registryAgentId: '2089',
    clientId: 'client',
    resource: `${origin}/mcp`,
  }
  const reply = await mcpRoute({
    method: 'POST',
    pathname: '/mcp',
    origin,
    headers: {},
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    grant,
    tools: { ...agentTools },
    call: async () => ({}),
  })
  const schema = Schema.decodeUnknownSync(
    Schema.Struct({
      result: Schema.Struct({
        tools: Schema.Array(
          Schema.Struct({ name: Schema.String, inputSchema: Schema.Unknown, annotations: Schema.Unknown }),
        ),
      }),
    }),
  )(reply.body)
  const profileTool = schema.result.tools.find((entry) => entry.name === 'update_profile')!
  expect(profileTool.inputSchema).toMatchObject({
    required: ['operationKey'],
    properties: { name: { maxLength: 80 }, operationKey: { type: 'string' } },
  })
  expect(profileTool.annotations).toMatchObject({ readOnlyHint: false })
})
