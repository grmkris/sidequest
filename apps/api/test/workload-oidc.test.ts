import { afterEach, expect, it } from 'vitest'
import { Schema } from 'effect'
import { mcpRoute } from '../src/mcp.ts'
import { hostedMcpTools } from '../src/mcp-registry.ts'
import { oauthRoute } from '../src/oauth.ts'
import { runAgent } from '../src/agent-runtime.ts'
import { SPONSOR_OBJECT_NAME } from '@sidequest/board'
import { JWT_BEARER_GRANT, WORKLOAD_EXTENSION } from '../src/workload-policies.ts'
import { verifyOidcToken } from '../src/oidc-verify.ts'
import { ClientCredentialsProvider, PrivateKeyJwtProvider } from '@modelcontextprotocol/sdk/client/auth-extensions.js'
import { workloadFixture, Token, issuer, policy, operator, origin, resource } from './workload-fixture.ts'
import { outsider } from './setup-oauth-fixture.ts'

const fixtures: Awaited<ReturnType<typeof workloadFixture>>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.db.close()
})
async function fixture(alg: 'ES256' | 'RS256' = 'ES256') {
  const f = await workloadFixture(alg)
  fixtures.push(f)
  return f
}
const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))

it.each(['ES256', 'RS256'] as const)(
  'exchanges a fake %s issuer assertion, resolves the agent, and calls its hosted MCP tools',
  async (algorithm) => {
    const f = await fixture(algorithm)
    const id = await f.add()
    const reply = await f.exchange(id, await f.sign())
    expect(reply.status).toBe(200)
    expect(reply.headers).toMatchObject({ 'cache-control': 'no-store' })
    const token = Schema.decodeUnknownSync(Token)(reply.body)
    expect(token.expires_in).toBe(300)
    expect(record(reply.body).refresh_token).toBeUndefined()
    const grant = await f.resolve(token.access_token)
    expect(grant).toMatchObject({ agentIds: ['quill'], registryAgentId: '41', owner: operator })
    const namespace = { idFromName: () => ({ toString: () => SPONSOR_OBJECT_NAME }) }
    const response = await mcpRoute({
      method: 'POST',
      pathname: '/b/team-board/mcp',
      origin,
      headers: {},
      grant: grant!,
      workloadEnabled: true,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_approvals', arguments: {} } },
      tools: hostedMcpTools('monad-testnet'),
      call: async (tool, args, agentId) =>
        JSON.parse(
          await runAgent({
            sql: f.sql,
            stateId: SPONSOR_OBJECT_NAME,
            bindings: { ...f.bindings, Board: namespace },
            req: {
              tool,
              args,
              agentId,
              resource,
              bearer: token.access_token,
              env: {
                network: 'monad-testnet',
                boardId: 'team-board',
                uri: origin,
                rpcUrl: 'http://127.0.0.1:1',
                domain: new URL(origin).hostname,
                manifestBaseUrl: `${origin}/offers`,
                screening: { baseUrl: '', apiKey: '', model: '' },
                attesterKey: '',
                github: { appId: '', privateKeyPem: '', installationId: '' },
                relayKey: '',
              },
            },
          }),
        ),
    })
    expect(response.status).toBe(200)
    expect(record(response.body).result).toMatchObject({ structuredContent: { ok: true, result: { approvals: [] } } })
    expect(f.fetched).toEqual([`${issuer}/.well-known/openid-configuration`, `${issuer}/jwks`])
  },
)

it.each([
  ['aud', { aud: 'wrong' }],
  ['sub', { sub: 'repo:attacker/repo:ref:refs/heads/main' }],
  ['repository', { repository: 'attacker/repo' }],
  ['expired', { exp: 1 }],
  ['issuer', { iss: `${issuer}/` }],
  ['no exp', { exp: undefined }],
  ['no jti', { jti: undefined }],
  ['future', { iat: 9_000_000_000 }],
  ['long lived', { exp: 9_000_000_000 }],
])('refuses an assertion with %s mismatch', async (_name, claims) => {
  const f = await fixture()
  const reply = await f.exchange(await f.add(), await f.sign(claims))
  expect(reply.status).toBe(400)
  expect(record(reply.body).error).toBe('invalid_grant')
  expect(f.sql.all('SELECT * FROM agent_oauth_tokens')).toHaveLength(0)
})

it('refuses malformed, missing and wrongly signed assertions without leaking them', async () => {
  const f = await fixture()
  const id = await f.add()
  for (const assertion of ['', 'not-a-jwt', await f.sign({}, true)]) {
    const reply = await f.exchange(id, assertion)
    expect(reply.status).toBe(400)
    if (assertion !== '') expect(JSON.stringify(reply.body)).not.toContain(assertion)
  }
})

it('fails closed on untrusted discovery, invalid policy and issuer errors before key fetch', async () => {
  const f = await fixture()
  const assertion = await f.sign()
  expect(await verifyOidcToken(assertion, [], { now: f.now(), fetch: f.fakeFetch })).toMatchObject({
    code: 'unknown-issuer',
  })
  expect(f.fetched).toHaveLength(0)
  expect(
    await verifyOidcToken(assertion, [{ ...policy, claims: {} }], { now: f.now(), fetch: f.fakeFetch }),
  ).toMatchObject({ code: 'invalid-policy' })
  for (const document of [
    { issuer: 'https://other.test', jwks_uri: `${issuer}/jwks` },
    { issuer, jwks_uri: 'https://other.test/jwks' },
    { issuer, jwks_uri: 'http://issuer.workload.example/jwks' },
  ])
    expect(
      await verifyOidcToken(assertion, [policy], { now: f.now(), fetch: async () => Response.json(document) }),
    ).toMatchObject({ code: 'discovery-failed' })
})

it('atomically refuses simultaneous assertion replay, including reuse under a different policy', async () => {
  const f = await fixture()
  const id = await f.add()
  const assertion = await f.sign()
  const results = await Promise.all([f.exchange(id, assertion), f.exchange(id, assertion)])
  expect(results.map((r) => r.status).toSorted((a, b) => a - b)).toEqual([200, 400])
  expect((await f.exchange(await f.add(), assertion)).status).toBe(400)
  expect(f.sql.all('SELECT * FROM agent_oauth_tokens')).toHaveLength(1)
})

it.each(['disable', 'delete'] as const)('%s policy stops issuance and existing access', async (decision) => {
  const f = await fixture()
  const id = await f.add()
  const token = Schema.decodeUnknownSync(Token)((await f.exchange(id, await f.sign())).body)
  await f.manage('workload-policy-change', { id, decision })
  expect((await f.exchange(id, await f.sign())).status).toBe(400)
  expect(await f.resolve(token.access_token)).toBeUndefined()
})

it('binds tokens to resource, expiry and the feature flag; offers no refresh grant', async () => {
  const f = await fixture()
  const id = await f.add()
  const assertion = await f.sign()
  expect((await f.exchange(id, assertion, {}, false)).status).toBe(400)
  const token = Schema.decodeUnknownSync(Token)((await f.exchange(id, assertion)).body)
  expect(await f.resolve(token.access_token, false)).toBeUndefined()
  expect(await f.resolve(token.access_token, true, `${origin}/mcp`)).toBeUndefined()
  expect(
    (await f.exchange(id, await f.sign(), { grant_type: 'refresh_token', refresh_token: token.access_token })).status,
  ).toBe(400)
  f.clock(f.now() + 300)
  expect(await f.resolve(token.access_token)).toBeUndefined()
})

it('caps scope by both policy and agent roles, retains 403 insufficient_scope and live role refusal', async () => {
  const f = await fixture()
  f.agents.setRoles('quill', ['work'])
  const id = await f.add(['sidequest:read', 'sidequest:hire'])
  expect((await f.exchange(id, await f.sign(), { scope: 'sidequest:hire' })).status).toBe(400)
  for (const scope of ['sidequest:maintain', 'sidequest:setup', 'sidequest:work', 'unknown'])
    expect((await f.exchange(id, await f.sign(), { scope })).status).toBe(400)
  const token = Schema.decodeUnknownSync(Token)((await f.exchange(id, await f.sign())).body)
  expect(token.scope).toBe('sidequest:read')
  f.agents.setRoles('quill', ['work', 'hire'])
  const grant = (await f.resolve(token.access_token))!
  const reply = await mcpRoute({
    method: 'POST',
    pathname: '/mcp',
    origin,
    headers: {},
    grant,
    tools: hostedMcpTools('monad-testnet'),
    call: async () => {
      throw new Error('Refused call must not execute')
    },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: {} } },
  })
  expect(reply.status).toBe(403)
  expect(reply.headers?.['www-authenticate']).toContain('insufficient_scope')
  const workId = await f.add()
  const workToken = Schema.decodeUnknownSync(Token)((await f.exchange(workId, await f.sign())).body)
  f.agents.setRoles('quill', [])
  const workGrant = (await f.resolve(workToken.access_token))!
  const role = await mcpRoute({
    method: 'POST',
    pathname: '/mcp',
    origin,
    headers: {},
    grant: workGrant,
    tools: hostedMcpTools('monad-testnet'),
    call: async () => {
      throw new Error('Role refusal must not execute')
    },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'apply', arguments: { taskId: '1' } } },
  })
  expect(JSON.stringify(role.body)).toContain('role-required')
})

it('only the owning operator can save/delete trust, with aud, sub, resource and bounded scopes required', async () => {
  const f = await fixture()
  await expect(
    f.manage('workload-policy-add', { policy, resource, scopes: ['sidequest:read'] }, outsider),
  ).rejects.toThrow('another operator')
  for (const body of [
    { policy: { ...policy, claims: {} }, resource, scopes: ['sidequest:read'] },
    { policy: { ...policy, claims: { aud: ['aud'] } }, resource, scopes: ['sidequest:read'] },
    { policy, resource: 'https://other.test/mcp', scopes: ['sidequest:read'] },
    { policy, resource, scopes: ['sidequest:maintain'] },
  ])
    await expect(f.manage('workload-policy-add', body)).rejects.toThrow()
  const id = await f.add()
  await expect(f.manage('workload-policy-change', { id, decision: 'delete' }, outsider)).rejects.toThrow(
    'another operator',
  )
})

it('advertises the JWT bearer grant and MCP extension only when enabled', async () => {
  const f = await fixture()
  const id = await f.add()
  const token = Schema.decodeUnknownSync(Token)((await f.exchange(id, await f.sign())).body)
  const grant = (await f.resolve(token.access_token))!
  for (const enabled of [false, true]) {
    const metadata = await oauthRoute({
      sql: f.sql,
      method: 'GET',
      path: '/.well-known/oauth-authorization-server',
      query: new URLSearchParams(),
      body: {},
      origin,
      siteOrigin: origin,
      now: f.now(),
      workloadEnabled: enabled,
    })
    const grants = Schema.decodeUnknownSync(Schema.Struct({ grant_types_supported: Schema.Array(Schema.String) }))(
      metadata?.body,
    )
    expect(grants.grant_types_supported.includes(JWT_BEARER_GRANT)).toBe(enabled)
    const reply = await mcpRoute({
      method: 'POST',
      pathname: '/mcp',
      origin,
      headers: {},
      grant,
      workloadEnabled: enabled,
      tools: {},
      call: async () => ({}),
      body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    })
    expect(
      Object.hasOwn(record(record(record(record(reply.body).result).capabilities).extensions), WORKLOAD_EXTENSION),
    ).toBe(enabled)
  }
})

it('the installed SDK providers use client_credentials, so RFC 7523 needs a minimal assertion client', () => {
  const common = { clientId: 'fixture-client', expectedIssuer: origin }
  const basic = new ClientCredentialsProvider({ ...common, clientSecret: 'unit-test-only' })
  const privateKey = new PrivateKeyJwtProvider({
    ...common,
    privateKey: 'unused-in-this-metadata-test',
    algorithm: 'ES256',
  })
  expect(basic.prepareTokenRequest().get('grant_type')).toBe('client_credentials')
  expect(privateKey.prepareTokenRequest().get('grant_type')).toBe('client_credentials')
})
