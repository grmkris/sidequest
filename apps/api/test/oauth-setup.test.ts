import { afterEach, expect, it } from 'vitest'
import { resolveOAuth, OAUTH_SCOPES } from '../src/oauth.ts'
import { boundScopes } from '../src/oauth-setup.ts'
import { setupFixture, operator, resource, origin } from './setup-oauth-fixture.ts'

const fixtures: ReturnType<typeof setupFixture>[] = []
const fixture = () => {
  const f = setupFixture()
  fixtures.push(f)
  return f
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.db.close()
})

it('advertises setup and approves an agentless resource-bound grant with setup authority only', async () => {
  const f = fixture()
  expect(OAUTH_SCOPES).toContain('sidequest:setup')
  const c = await f.connection()
  expect(c.tokens.scope).toBe('sidequest:setup')
  expect(await resolveOAuth(f.sql, c.tokens.access_token, resource, 1000)).toMatchObject({
    setup: true,
    owner: operator.toLowerCase(),
    scopes: ['sidequest:setup'],
    agentIds: [],
    registryAgentId: null,
  })
  expect(await resolveOAuth(f.sql, c.tokens.access_token, `${origin}/mcp`, 1000)).toBeUndefined()
  expect(f.agents.list(operator, 10143)).toEqual([])
})

it('consent data offers setup and declines selecting an agent or naming an unknown scope', async () => {
  const f = fixture(),
    r = await f.request()
  expect((await f.route(`/oauth/requests/${r.requestId}`, {}, undefined, 'GET'))?.body).toMatchObject({
    result: { agents: [], setup: { available: true, scope: 'sidequest:setup' } },
  })
  for (const body of [
    { setup: true, agentIds: ['quill'] },
    { setup: true, scopes: ['sidequest:setup', 'arbitrary:write'] },
    { setup: true, scopes: 'sidequest:work' },
  ])
    expect((await f.route(`/oauth/requests/${r.requestId}/approve`, body))?.status).toBe(400)
  expect(
    (await f.route(`/oauth/requests/${r.requestId}/approve`, { setup: true }, undefined, 'POST', null))?.status,
  ).toBe(401)
})

it('offers setup to a client that did not request it and keeps its requested roles only to pre-tick approval', async () => {
  const f = fixture(),
    c = await f.connection('sidequest:read sidequest:hire')
  expect(c.tokens.scope).toBe('sidequest:setup')
  expect(await resolveOAuth(f.sql, c.tokens.access_token, resource, 1000)).toMatchObject({
    setup: true,
    scopes: ['sidequest:setup'],
  })
  expect(f.sql.all('SELECT requested_scopes_json FROM agent_oauth_setup_families')).toEqual([
    { requested_scopes_json: JSON.stringify(['sidequest:setup', 'sidequest:read', 'sidequest:hire']) },
  ])
})

it("connecting an existing agent on consent turns the operator's waiting setup connections into it", async () => {
  const f = fixture(),
    waiting = await f.connection()
  f.active('quill')
  const r = await f.request('sidequest:setup sidequest:read sidequest:hire')
  const approved = await f.route(`/oauth/requests/${r.requestId}/approve`, {
    agentIds: ['quill'],
    scopes: ['sidequest:setup', 'sidequest:read', 'sidequest:hire'],
  })
  expect(approved?.status).toBe(200)
  // It keeps the scope its own client asked for (read and work), not the consenting client's.
  expect(await resolveOAuth(f.sql, waiting.tokens.access_token, resource, 1000)).toMatchObject({
    agentIds: ['quill'],
    scopes: ['sidequest:read', 'sidequest:work'],
  })
})

// ADR-0028: only a consent for an existing agent grants sidequest:maintain, and only to that consent's connection.
it('never grants sidequest:maintain through setup: a setup consent naming it is refused', async () => {
  const f = fixture(),
    r = await f.request('sidequest:setup sidequest:read sidequest:maintain')
  for (const body of [
    { setup: true, maintain: true },
    { setup: true, maintain: false },
    { setup: true, scopes: ['sidequest:setup', 'sidequest:maintain'] },
    { setup: true, media: true },
    { setup: true, scopes: ['sidequest:setup', 'sidequest:media'] },
  ]) {
    const refused = await f.route(`/oauth/requests/${r.requestId}/approve`, body)
    expect(refused, JSON.stringify(body)).toMatchObject({ status: 400, body: { error: 'invalid_request' } })
  }
  expect(boundScopes(['sidequest:setup', 'sidequest:read', 'sidequest:maintain', 'sidequest:work'])).toEqual([
    'sidequest:read',
    'sidequest:work',
  ])
})

it('binds waiting setup connections without sidequest:maintain, even when the consent that binds them ticks it', async () => {
  const f = fixture(),
    waiting = await f.connection('sidequest:setup sidequest:read sidequest:maintain')
  expect(waiting.tokens.scope).toBe('sidequest:setup')
  f.active('quill')
  const r = await f.request('sidequest:setup sidequest:read sidequest:maintain')
  const approved = await f.route(`/oauth/requests/${r.requestId}/approve`, { agentIds: ['quill'], maintain: true })
  expect(approved?.status).toBe(200)
  expect(await resolveOAuth(f.sql, waiting.tokens.access_token, resource, 1000)).toMatchObject({
    agentIds: ['quill'],
    scopes: ['sidequest:read'],
  })
  // The consenting connection itself holds the tick.
  expect(f.sql.all('SELECT scopes_json FROM agent_oauth_requests WHERE id=?', r.requestId)).toEqual([
    { scopes_json: JSON.stringify(['sidequest:maintain', 'sidequest:read']) },
  ])
})

it('binds setup codes to PKCE, client, redirect and resource and consumes them once', async () => {
  const f = fixture(),
    c = await f.connection()
  expect((await f.route('/oauth/token', c.tokenBody))?.status).toBe(400)
  const next = await f.request()
  const approved = await f.route(`/oauth/requests/${next.requestId}/approve`, { setup: true })
  expect(approved?.status).toBe(200)
  // The already-issued grant remains usable while wrong exchange attempts are rejected.
  for (const change of [
    { client_id: 'other' },
    { resource: `${origin}/mcp` },
    { redirect_uri: 'https://other.example/cb' },
    { code_verifier: 'b'.repeat(43) },
  ])
    expect((await f.route('/oauth/token', { ...c.tokenBody, ...change }))?.status).toBe(400)
  expect(await resolveOAuth(f.sql, c.tokens.access_token, resource, 1000)).toBeDefined()
})

it('rotates refresh tokens and revokes the whole setup family on replay or explicit disconnect', async () => {
  const f = fixture(),
    c = await f.connection()
  const body = { grant_type: 'refresh_token', client_id: c.clientId, resource, refresh_token: c.tokens.refresh_token }
  expect((await f.route('/oauth/token', { ...body, resource: `${origin}/mcp` }))?.status).toBe(400)
  expect((await f.route('/oauth/token', body))?.status).toBe(200)
  expect((await f.route('/oauth/token', body))?.status).toBe(400)
  expect(await resolveOAuth(f.sql, c.tokens.access_token, resource, 1000)).toBeUndefined()
  const other = await f.connection()
  await f.route('/oauth/revoke', { token: other.tokens.access_token, client_id: other.clientId })
  expect(await resolveOAuth(f.sql, other.tokens.access_token, resource, 1000)).toBeUndefined()
})

it('keeps agent-family authority isolated from setup and rejects expired setup tokens', async () => {
  const f = fixture(),
    c = await f.connection()
  f.clock(4600)
  expect(await resolveOAuth(f.sql, c.tokens.access_token, resource, f.now())).toBeUndefined()
  expect(f.sql.all('SELECT * FROM agent_oauth_families')).toEqual([])
})
