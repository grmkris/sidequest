import { Schema } from 'effect'
import { validRedirect } from './oauth-validation.ts'

/** Trust policy: fetched identity is limited to the clients supported by this service. */
const DOCUMENTS = new Set([
  'https://claude.ai/oauth/mcp-oauth-client-metadata',
  'https://chatgpt.com/oauth/client.json',
  'https://chatgpt.com/oauth/codex/client.json',
  'https://vscode.dev/oauth/client-metadata.json',
])
const Metadata = Schema.Struct({
  client_id: Schema.String,
  client_name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  redirect_uris: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  token_endpoint_auth_method: Schema.optional(Schema.Literal('none')),
})
export type ClientMetadata = typeof Metadata.Type
const cached = new Map<string, { metadata: ClientMetadata; until: number }>()

function cacheSeconds(headers: Headers): number {
  const control = headers.get('cache-control') ?? ''
  if (/no-store|no-cache/i.test(control)) return 0
  const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(control)?.[1]
  return Math.max(0, Math.min(3600, Number(maxAge ?? 0)) - Number(headers.get('age') ?? 0))
}

/** Stream the decoded body under the same abort deadline as the fetch; Content-Length is not trusted. */
async function readMetadata(response: Response): Promise<ClientMetadata> {
  if (!response.ok || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
    throw new Error('Client metadata must be a successful JSON response')
  if (response.body === null) throw new Error('Client metadata is empty')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > 5120) throw new Error('Client metadata exceeds 5 KiB')
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  const metadata = Schema.decodeUnknownSync(Metadata)(JSON.parse(new TextDecoder().decode(bytes)))
  if (!metadata.redirect_uris.every(validRedirect)) throw new Error('Invalid client redirect URI')
  return metadata
}

/** Runs in the Worker before the sponsor object's serialized queue; never accepts redirects or credentials. */
export async function resolveClientMetadata(clientId: string, fetcher: typeof fetch = fetch): Promise<ClientMetadata> {
  if (!DOCUMENTS.has(clientId)) throw new Error('Client metadata URL is not trusted')
  const hit = cached.get(clientId)
  if (hit !== undefined && hit.until > Date.now()) return hit.metadata
  const response = await fetcher(clientId, {
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
    headers: { accept: 'application/json' },
  })
  const metadata = await readMetadata(response)
  if (metadata.client_id !== clientId) throw new Error('Client metadata identity mismatch')
  cached.set(clientId, { metadata, until: Date.now() + cacheSeconds(response.headers) * 1000 })
  return metadata
}
