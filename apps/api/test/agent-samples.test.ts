import { expect, it, vi } from 'vitest'
import { agentOperationId, hostedToolNames } from '@sidequest/board'
import { uploadSample, MAX_SAMPLE_BASE64 } from '../src/agent-samples.ts'
import { MAX_AVATAR_BYTES } from '../src/avatars.ts'
import { agentTools } from '../src/tools-agents.ts'
import { networkTool, permittedTool, requiredToolScope, toolAnnotations, toolDecision } from '../src/mcp-policy.ts'
import { fixture, origin, png } from './agent-profile-fixture.ts'

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

function samples() {
  const f = fixture()
  const put = vi.fn(f.bindings.Manifests.put)
  const upload = (key: string, image: unknown = encode(png), boardId = 'public', agentId = 'one') =>
    uploadSample({
      sql: f.sql,
      now: f.now,
      origin,
      boardId,
      bucket: { ...f.bindings.Manifests, put },
      agentId,
      key,
      args: { image },
    })
  return { ...f, put, upload }
}

it('journals only the content key and returns the original URL after restart without storing again', async () => {
  const f = samples()
  const result = await f.upload('sample')
  expect(result.url).toMatch(new RegExp(`^${origin}/samples/[0-9a-f]{64}\\.png$`))
  const op = f.agents.operation(agentOperationId('one', 'sample'))
  expect(op.stage).toBe('confirmed')
  expect(JSON.parse(op.intent_json)).toEqual({ key: new URL(result.url).pathname.slice(1) })
  expect(op.intent_json).not.toContain(encode(png))
  expect(f.files.get(new URL(result.url).pathname.slice(1))).toEqual(png)
  expect(await f.upload('sample')).toEqual(result)
  expect(f.put).toHaveBeenCalledTimes(1)
})

it('refuses changed content or board on a used key before writing', async () => {
  const f = samples()
  await f.upload('sample')
  await expect(f.upload('sample', encode(new Uint8Array([0xff, 0xd8, 0xff])))).rejects.toMatchObject({
    code: 'conflict',
  })
  await expect(f.upload('sample', encode(png), 'another')).rejects.toMatchObject({ code: 'conflict' })
  expect(f.put).toHaveBeenCalledTimes(1)
})

it('sniffs PNG, JPEG and WebP and writes the matching content type', async () => {
  const f = samples()
  for (const [bytes, ext, type] of [
    [png, 'png', 'image/png'],
    [new Uint8Array([0xff, 0xd8, 0xff]), 'jpg', 'image/jpeg'],
    [new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]), 'webp', 'image/webp'],
  ] as const) {
    const result = await f.upload(ext, encode(bytes))
    expect(result.url).toMatch(new RegExp(`\\.${ext}$`))
    expect(f.put).toHaveBeenLastCalledWith(expect.stringContaining('samples/'), bytes, {
      httpMetadata: { contentType: type },
    })
  }
})

it('enforces both the encoded and decoded size limits while accepting exactly 1 MiB', async () => {
  const f = samples()
  const bytes = new Uint8Array(MAX_AVATAR_BYTES)
  bytes.set(png)
  await f.upload('limit', encode(bytes))
  const tooLarge = new Uint8Array(MAX_AVATAR_BYTES + 1)
  tooLarge.set(png)
  expect(encode(tooLarge).length).toBe(MAX_SAMPLE_BASE64)
  await expect(f.upload('decoded-over', encode(tooLarge))).rejects.toMatchObject({ code: 'invalid' })
  await expect(f.upload('encoded-over', 'A'.repeat(MAX_SAMPLE_BASE64 + 1))).rejects.toMatchObject({ code: 'invalid' })
  expect(f.put).toHaveBeenCalledTimes(1)
})

it('refuses empty, malformed, non-image, spoofed and truncated input before journaling', async () => {
  const f = samples()
  for (const image of [
    null,
    1,
    '',
    '???',
    'A',
    'data:image/png;base64,' + encode(png),
    encode(new TextEncoder().encode('<svg/>')),
    encode(new Uint8Array([0x89, 0x50])),
  ])
    await expect(f.upload('invalid', image)).rejects.toMatchObject({ code: 'invalid' })
  expect(f.sql.all('SELECT * FROM agent_operations')).toEqual([])
  expect(f.put).not.toHaveBeenCalled()
})

it('counts at most 40 new operations per UTC day across boards, leaving retries free', async () => {
  const f = samples()
  for (let i = 0; i < 40; i++) await f.upload(`sample-${i}`, encode(png), i % 2 ? 'public' : 'other')
  await expect(f.upload('sample-40')).rejects.toMatchObject({ code: 'conflict' })
  expect(f.sql.all("SELECT * FROM agent_operations WHERE tool='upload_sample'")).toHaveLength(40)
  expect(await f.upload('sample-1')).toEqual(await f.upload('sample-3'))
  expect(f.put).toHaveBeenCalledTimes(40)
  f.advance()
  await f.upload('sample-40')
  expect(f.put).toHaveBeenCalledTimes(41)
})

it('keeps daily caps separate for each agent and ignores other tools', async () => {
  const f = samples()
  const agent = f.agents.get('one')
  f.agents.create({
    id: 'two',
    operator: agent.operator,
    name: 'Two',
    privyUserId: 'two',
    registry: agent.registry,
    chainId: agent.chain_id,
  })
  for (let i = 0; i < 40; i++) {
    await f.upload(`sample-${i}`)
    f.agents.begin('two', `other-${i}`, 'public', 'update_profile', {})
  }
  await f.upload('sample-0', encode(png), 'public', 'two')
  expect(f.put).toHaveBeenCalledTimes(41)
})

it('retries uncertain storage writes on the same operation without consuming another slot', async () => {
  const f = samples()
  f.put.mockRejectedValueOnce(new Error('storage unavailable'))
  await expect(f.upload('retry')).rejects.toThrow('storage unavailable')
  expect(f.agents.operation(agentOperationId('one', 'retry')).stage).toBe('intent')
  expect(await f.upload('retry')).toHaveProperty('url')
  expect(f.sql.all("SELECT * FROM agent_operations WHERE tool='upload_sample'")).toHaveLength(1)
})

it('fails explicitly when storage is unavailable', async () => {
  const f = samples()
  await expect(
    uploadSample({
      sql: f.sql,
      now: f.now,
      origin,
      boardId: 'public',
      bucket: undefined,
      agentId: 'one',
      key: 'missing',
      args: { image: encode(png) },
    }),
  ).rejects.toMatchObject({ code: 'unavailable' })
})

it('registers upload_sample as a reviewed work write on either network', () => {
  expect(hostedToolNames.has('upload_sample')).toBe(true)
  expect(agentTools.upload_sample.inputSchema.properties.image.maxLength).toBe(MAX_SAMPLE_BASE64)
  expect(requiredToolScope('upload_sample')).toBe('sidequest:work')
  expect(permittedTool({ scopes: ['sidequest:read'] }, 'upload_sample')).toBe(false)
  expect(permittedTool({ scopes: ['sidequest:work'] }, 'upload_sample')).toBe(true)
  expect(toolDecision({ scopes: ['sidequest:work'], roles: ['hire'] }, 'upload_sample')).toBe('role')
  expect(toolAnnotations('upload_sample')).toEqual({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  })
  for (const network of ['monad-mainnet', 'monad-testnet']) expect(networkTool(network, 'upload_sample')).toBe(true)
})
