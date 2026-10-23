/** Adapted from https://ui.shadcn.com/oidc/r/verify.json; no tokens or provider errors reach logs. */
import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify } from 'jose'
import { Schema } from 'effect'
import { matchOidcPolicy, validateOidcPolicy, type OidcPolicy } from '@sidequest/sdk/oidc-policy'

const Discovery = Schema.Struct({ issuer: Schema.String, jwks_uri: Schema.String })
const MAX_DOCUMENT_BYTES = 64 * 1024

/** Bound discovery/JWKS traffic, disallow redirects, and keep test transport injection out of bindings. */
function boundedFetch(fetcher: typeof fetch): typeof fetch {
  return async (url, init) => {
    const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error('OIDC document unavailable')
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('OIDC document missing')
    let bytes = 0
    const chunks: Uint8Array[] = []
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > MAX_DOCUMENT_BYTES) throw new Error('OIDC document too large')
        chunks.push(part.value)
      }
    } finally {
      await reader.cancel()
    }
    return new Response(new Blob(chunks), { status: 200, headers: response.headers })
  }
}

type VerificationError =
  | 'missing-token'
  | 'malformed-token'
  | 'unknown-issuer'
  | 'invalid-policy'
  | 'discovery-failed'
  | 'invalid-token'
  | 'claims-mismatch'

const failure = (code: VerificationError) => ({ ok: false as const, code })
const AssertionClaims = Schema.Struct({
  exp: Schema.Number,
  iat: Schema.Number,
  sub: Schema.String.check(Schema.isMinLength(1)),
  jti: Schema.String.check(Schema.isMinLength(1)),
})

async function discoverKeys(issuer: string, fetcher: typeof fetch) {
  const bounded = boundedFetch(fetcher)
  const response = await bounded(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)
  const discovery = Schema.decodeUnknownSync(Discovery)(await response.json())
  const url = new URL(discovery.jwks_uri)
  if (
    discovery.issuer !== issuer ||
    url.protocol !== 'https:' ||
    url.origin !== new URL(issuer).origin ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  )
    throw new Error('Untrusted discovery')
  return createRemoteJWKSet(url, { [customFetch]: bounded, timeoutDuration: 5000 })
}

/** Strict issuer equality precedes any fetch; only saved, valid trust candidates can cause discovery. */
export async function verifyOidcToken(
  token: string | undefined,
  policies: readonly OidcPolicy[],
  options: { now: number; fetch?: typeof fetch },
) {
  if (token === undefined || token === '') return failure('missing-token')
  let issuer: string
  try {
    if (token.length > 16_384) return failure('malformed-token')
    issuer = Schema.decodeUnknownSync(Schema.String)(decodeJwt(token).iss)
  } catch {
    return failure('malformed-token')
  }
  const candidates = policies.filter((policy) => policy.issuer === issuer)
  if (candidates.length === 0) return failure('unknown-issuer')
  const valid = candidates.filter((policy) => validateOidcPolicy(policy).length === 0)
  if (valid.length === 0) return failure('invalid-policy')
  let keys: ReturnType<typeof createRemoteJWKSet>
  try {
    keys = await discoverKeys(issuer, options.fetch ?? fetch)
  } catch {
    return failure('discovery-failed')
  }
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      algorithms: ['ES256', 'RS256'],
      requiredClaims: ['exp', 'iat', 'sub', 'jti'],
      maxTokenAge: 600,
      currentDate: new Date(options.now * 1000),
    })
    const checked = Schema.decodeUnknownSync(AssertionClaims)(payload)
    if (checked.exp - checked.iat > 600) return failure('invalid-token')
    const policy = valid.find((candidate) => matchOidcPolicy(candidate, payload))
    return policy === undefined
      ? failure('claims-mismatch')
      : { ok: true as const, policy, claims: { ...payload, ...checked } }
  } catch {
    return failure('invalid-token')
  }
}
