import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { BoardError } from '@sidequest/board'

export const MAX_AVATAR_BYTES = 1024 * 1024
type ImagePrefix = 'avatars' | 'samples'

export type AvatarType = 'image/png' | 'image/jpeg' | 'image/webp'
export interface ImageModel {
  generate(prompt: string): Promise<{ bytes: Uint8Array; type: AvatarType }>
}

interface AvatarObject {
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface AvatarBucket {
  get(key: string): Promise<AvatarObject | null>
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<object | null>
}

const contentTypes: Readonly<Record<string, AvatarType>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
}

const extension: Readonly<Record<AvatarType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

const equalBytes = (left: Uint8Array, right: readonly number[]): boolean =>
  left.length >= right.length && right.every((byte, index) => left[index] === byte)

export function sniffAvatar(bytes: Uint8Array): AvatarType | undefined {
  if (equalBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (equalBytes(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (
    bytes.length >= 12 &&
    equalBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    equalBytes(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  )
    return 'image/webp'
  return undefined
}

export function avatarPrompt(subject: string): string {
  return `A friendly mascot portrait for an AI agent: ${subject}. Flat vector illustration, bold shapes, soft lighting, plain pastel background. No text, letters, words, numbers or logos anywhere in the image.`
}

export async function identifyAvatar(
  bytes: Uint8Array,
  prefix: ImagePrefix = 'avatars',
): Promise<{ key: string; type: AvatarType }> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES)
    throw new BoardError('invalid', 'Avatar must be at most 1 MiB')
  const type = sniffAvatar(bytes)
  if (type === undefined) throw new BoardError('invalid', 'Avatar must be PNG, JPEG or WebP')
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
  const key = `${prefix}/${hash}.${extension[type]}`
  return { key, type }
}

export async function storeAvatar(
  bucket: AvatarBucket,
  bytes: Uint8Array,
  prefix: ImagePrefix = 'avatars',
): Promise<{ key: string; type: AvatarType }> {
  const { key, type } = await identifyAvatar(bytes, prefix)
  await bucket.put(key, bytes, { httpMetadata: { contentType: type } })
  return { key, type }
}

export async function avatarResponse(bucket: AvatarBucket | undefined, path: string, prefix: ImagePrefix = 'avatars') {
  const match = new RegExp(`^\\/?${prefix}/([0-9a-f]{64})\\.(png|jpg|webp)$`).exec(path)
  if (match === null || bucket === undefined)
    return HttpServerResponse.text('not found', { status: 404, headers: { 'access-control-allow-origin': '*' } })
  const type = contentTypes[match[2]!]!
  const object = await bucket.get(`${prefix}/${match[1]}.${match[2]}`)
  if (object === null)
    return HttpServerResponse.text('not found', { status: 404, headers: { 'access-control-allow-origin': '*' } })
  return HttpServerResponse.uint8Array(new Uint8Array(await object.arrayBuffer()), {
    contentType: type,
    headers: {
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    },
  })
}
