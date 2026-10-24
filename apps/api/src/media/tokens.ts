/**
 * Bearer capabilities for media files (ADR-0029). A preview token lets a team view play one internal asset for at most
 * two hours, because `<video src>` cannot send the session header. An upload token lets its holder PUT one exact file
 * (sha256, size, type) for an hour. A share token is the HMAC of its actor and operationKey, so a retried share answers
 * the same link; only its hash is stored, so a database read never yields a working link. Each kind has its own prefix
 * under the stage's `MEDIA_SIGNING_KEY`.
 */
import { BoardError } from '@sidequest/board'
import { Schema } from 'effect'
import { tokenHash } from '../oauth-validation.ts'

const encoder = new TextEncoder()

/** Bytes as lowercase hex. */
export const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')

/** Whether this stage can sign media links at all. */
export const canSign = (secret: string): boolean => secret.length >= 32

const base64url = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')

const fromBase64url = (text: string): Uint8Array | undefined => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined
  try {
    return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
  } catch {
    return undefined
  }
}

type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>
const keys = new Map<string, Promise<HmacKey>>()
function hmacKey(secret: string): Promise<HmacKey> {
  if (!canSign(secret))
    throw new BoardError('unavailable', 'media uploads, previews and shares are not configured here')
  let key = keys.get(secret)
  if (key === undefined) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ])
    keys.set(secret, key)
  }
  return key
}

const sign = async (secret: string, message: string) =>
  base64url(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(message)))

const verify = async (secret: string, message: string, signature: string) => {
  const bytes = fromBase64url(signature)
  if (bytes === undefined || !canSign(secret)) return false
  return crypto.subtle.verify('HMAC', await hmacKey(secret), bytes, encoder.encode(message))
}

/** A preview expiry between one and two hours away, on the hour, so a view's URLs stay the same for an hour. */
export const previewExpiry = (now: number): number => (Math.floor(now / 3600) + 2) * 3600

export async function previewToken(secret: string, assetId: string, expires: number): Promise<string> {
  return `${expires}.${await sign(secret, `media-preview-v1|${assetId}|${expires}`)}`
}

export async function verifyPreview(secret: string, assetId: string, token: string, now: number): Promise<boolean> {
  const match = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token)
  if (match === null) return false
  const expires = Number(match[1])
  if (expires <= now || expires > now + 2 * 3600) return false
  return verify(secret, `media-preview-v1|${assetId}|${expires}`, match[2]!)
}

const Grant = Schema.Struct({
  sha256: Schema.String,
  bytes: Schema.Number,
  type: Schema.String,
  actor: Schema.String,
  expires: Schema.Number,
})
export type UploadGrant = typeof Grant.Type
const GrantJson = Schema.fromJsonString(Grant)

export async function uploadToken(secret: string, grant: UploadGrant): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(grant)))
  return `${payload}.${await sign(secret, `media-upload-v1|${payload}`)}`
}

/** The grant an upload token carries, when it is genuine, unexpired and for this file. */
export async function verifyUpload(
  secret: string,
  token: string,
  sha256: string,
  now: number,
): Promise<UploadGrant | undefined> {
  const [payload, signature, ...rest] = token.split('.')
  if (payload === undefined || signature === undefined || rest.length > 0) return undefined
  if (!(await verify(secret, `media-upload-v1|${payload}`, signature))) return undefined
  const bytes = fromBase64url(payload)
  if (bytes === undefined) return undefined
  try {
    const grant = Schema.decodeUnknownSync(GrantJson)(new TextDecoder().decode(bytes))
    return grant.sha256 === sha256 && grant.expires > now ? grant : undefined
  } catch {
    return undefined
  }
}

/** A share's token, the same for the same actor and operationKey, so a retried share answers the same link. */
export async function shareToken(secret: string, actor: string, operationKey: string): Promise<string> {
  return hex(
    await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(`media-share-v1|${actor}|${operationKey}`)),
  )
}

export const shareHash = (token: string): Promise<string> => tokenHash(token)

export const isShareToken = (token: string): boolean => /^[0-9a-f]{64}$/.test(token)
