import { expect, it } from 'vitest'
import {
  avatarPrompt,
  avatarResponse,
  identifyAvatar,
  MAX_AVATAR_BYTES,
  sniffAvatar,
  storeAvatar,
} from '../src/avatars.ts'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'

class Bucket {
  readonly values = new Map<string, Uint8Array>()
  async put(key: string, value: Uint8Array) {
    this.values.set(key, value)
    return { key }
  }

  async get(key: string) {
    const value = this.values.get(key)
    return value === undefined ? null : { arrayBuffer: async () => new Uint8Array(value).buffer }
  }
}

it('sniffs supported avatar formats and rejects declared-type spoofing', () => {
  expect(sniffAvatar(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
  expect(sniffAvatar(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toBe('image/jpeg')
  expect(sniffAvatar(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp')
  expect(sniffAvatar(new Uint8Array([0, 1, 2]))).toBeUndefined()
})

it('stores content-addressed avatars and keeps prompts in one house style', async () => {
  const bucket = new Bucket()
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const stored = await storeAvatar(bucket, bytes)
  expect(stored.key).toMatch(/^avatars\/[0-9a-f]{64}\.png$/)
  expect(bucket.values.get(stored.key)).toEqual(bytes)
  expect(avatarPrompt('a sleepy fox')).toContain('a sleepy fox')
})

it('serves exact bytes with the sniffed extension and immutable caching', async () => {
  const bucket = new Bucket()
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00])
  const { key } = await storeAvatar(bucket, bytes)
  const response = await avatarResponse(bucket, `/${key}`)
  expect(response.status).toBe(200)
  expect(response.headers['content-type']).toBe('image/jpeg')
  expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable')
  expect(new Uint8Array(await HttpServerResponse.toWeb(response).arrayBuffer())).toEqual(bytes)
})

it('returns uncached 404 for unknown and non-canonical paths', async () => {
  const bucket = new Bucket()
  for (const path of [`/avatars/${'a'.repeat(64)}.png`, '/avatars/../../secret', `/avatars/${'a'.repeat(64)}.svg`]) {
    const response = await avatarResponse(bucket, path)
    expect(response.status).toBe(404)
    expect(response.headers['cache-control']).toBeUndefined()
  }
})

it('rejects unsupported, empty, oversized and truncated bytes before writing', async () => {
  const bucket = new Bucket()
  for (const bytes of [
    new Uint8Array(),
    new TextEncoder().encode('<svg/>'),
    new Uint8Array([0x89, 0x50]),
    new Uint8Array(MAX_AVATAR_BYTES + 1),
  ])
    await expect(storeAvatar(bucket, bytes)).rejects.toMatchObject({ code: 'invalid' })
  expect(bucket.values.size).toBe(0)
})

it('recognizes a WebP whose RIFF size is nonzero', () => {
  expect(sniffAvatar(new Uint8Array([0x52, 0x49, 0x46, 0x46, 12, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp')
})

it('keeps sample and avatar keys separate for the same image, with the same digest and metadata', async () => {
  const bucket = new Bucket()
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00])
  const avatar = await identifyAvatar(bytes)
  const sample = await storeAvatar(bucket, bytes, 'samples')
  expect(sample).toEqual({ key: avatar.key.replace('avatars/', 'samples/'), type: avatar.type })
  const response = await avatarResponse(bucket, `/${sample.key}`, 'samples')
  expect(response.status).toBe(200)
  expect(response.headers).toMatchObject({
    'content-type': 'image/jpeg',
    'cache-control': 'public, max-age=31536000, immutable',
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
  })
  expect(new Uint8Array(await HttpServerResponse.toWeb(response).arrayBuffer())).toEqual(bytes)
  expect((await avatarResponse(bucket, `/${sample.key}`)).status).toBe(404)
  expect((await avatarResponse(bucket, `/${avatar.key}`, 'samples')).status).toBe(404)
})

it('refuses non-canonical sample paths and missing storage without caching failures', async () => {
  for (const path of [
    `/samples/${'a'.repeat(64)}.png`,
    '/samples/../../secret',
    `/samples/${'a'.repeat(64)}.svg`,
    `/samples/${'A'.repeat(64)}.jpg`,
    `/samples/${'a'.repeat(64)}.png/extra`,
  ]) {
    const response = await avatarResponse(new Bucket(), path, 'samples')
    expect(response.status).toBe(404)
    expect(response.headers['cache-control']).toBeUndefined()
    expect(response.headers['access-control-allow-origin']).toBe('*')
  }
  expect((await avatarResponse(undefined, `/samples/${'a'.repeat(64)}.png`, 'samples')).status).toBe(404)
})
