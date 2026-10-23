import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { Schema } from 'effect'
import * as sdk from '@sidequest/sdk'
import { agentRoute } from '../src/routes/agents.ts'
import { agentManagement } from '../src/agent-management.ts'
import { oauthRoute, resolveOAuth } from '../src/oauth.ts'
import { JWT_BEARER_GRANT } from '../src/workload-policies.ts'
import { setupFixture, operator, origin, resource } from './setup-oauth-fixture.ts'

export { operator, origin, resource }
export const issuer = 'https://issuer.workload.example/tenant'
const subject = 'repo:acme/agent:ref:refs/heads/main'
export const policy = {
  issuer,
  label: 'Local CI',
  claims: { aud: [`${origin}/oauth/token`], sub: [subject], repository: ['acme/agent'] },
}
const List = Schema.Struct({ enabled: Schema.Boolean, policies: Schema.Array(Schema.Struct({ id: Schema.String })) })
export const Token = Schema.Struct({ access_token: Schema.String, expires_in: Schema.Number, scope: Schema.String })

/** Real SQLite and real signatures; all issuer documents are served by this hermetic injected transport. */
export async function workloadFixture(algorithm: 'ES256' | 'RS256' = 'ES256') {
  const f = setupFixture()
  f.clock(Math.floor(Date.now() / 1000))
  f.active()
  const key = await generateKeyPair(algorithm)
  const wrong = await generateKeyPair(algorithm)
  const publicKey = { ...(await exportJWK(key.publicKey)), kid: 'fixture-key', alg: algorithm }
  const fetched: string[] = []
  const fakeFetch: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : input.toString()
    fetched.push(url)
    if (url === `${issuer}/.well-known/openid-configuration`)
      return Response.json({ issuer, jwks_uri: `${issuer}/jwks` })
    if (url === `${issuer}/jwks`) return Response.json({ keys: [publicKey] })
    throw new Error('Fixture refused unexpected network access')
  }
  const bindings = { WORKLOAD_OIDC_ENABLED: '1', PUBLIC_ORIGIN: origin, NETWORK: 'monad-testnet' }
  const manage = async (action = 'workload-policies', body: Record<string, unknown> = {}, owner = operator) => {
    const request = agentRoute(action === 'workload-policies' ? 'GET' : 'POST', `/api/agents/quill/${action}`, body)
    if (request === undefined) throw new Error('Missing policy route')
    return List.pipe(Schema.decodeUnknownSync)(
      await agentManagement({
        request,
        sql: f.sql,
        operator: owner,
        bindings,
        context: sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1'),
        relayKey: '0x',
        rpcUrl: '',
        now: f.now,
        execute: async () => {
          throw new Error('Policy management must not execute agent actions')
        },
      }),
    )
  }
  const add = async (scopes = ['sidequest:read', 'sidequest:work', 'sidequest:hire']) => {
    const before = await manage()
    const list = await manage('workload-policy-add', { policy, resource, scopes })
    return list.policies.find((row) => !before.policies.some((old) => old.id === row.id))!.id
  }
  const sign = (claims: Record<string, unknown> = {}, badSignature = false) =>
    new SignJWT({
      iss: issuer,
      aud: `${origin}/oauth/token`,
      sub: subject,
      repository: 'acme/agent',
      iat: f.now(),
      exp: f.now() + 300,
      jti: crypto.randomUUID(),
      ...claims,
    })
      .setProtectedHeader({ alg: algorithm, kid: 'fixture-key' })
      .sign(badSignature ? wrong.privateKey : key.privateKey)
  const exchange = async (id: string, assertion: string, overrides: Record<string, unknown> = {}, enabled = true) => {
    const reply = await oauthRoute({
      sql: f.sql,
      method: 'POST',
      path: '/oauth/token',
      query: new URLSearchParams(),
      origin,
      siteOrigin: origin,
      body: { grant_type: JWT_BEARER_GRANT, client_id: id, resource, assertion, ...overrides },
      now: f.now(),
      workloadEnabled: enabled,
      workloadFetch: fakeFetch,
    })
    if (reply === undefined) throw new Error('Missing token route')
    return reply
  }
  const resolve = (token: string, enabled = true, target = resource) =>
    resolveOAuth(f.sql, token, target, f.now(), enabled)
  return { ...f, bindings, fetched, fakeFetch, manage, add, sign, exchange, resolve }
}
