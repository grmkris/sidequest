import { afterEach, expect, it } from 'vitest'
import { Schema } from 'effect'
import { agentAccess, agentConnections, connectionAccess, touchConnection } from '../src/agent-access.ts'
import { resolveOAuth } from '../src/oauth.ts'
import { agentRoute } from '../src/routes/agents.ts'
import { setupFixture, operator, outsider, resource } from './setup-oauth-fixture.ts'

const fixtures: ReturnType<typeof setupFixture>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.db.close()
})

/** Quill with two live connections: one consented to directly, one setup connection that became it. */
async function fixture() {
  const f = setupFixture()
  fixtures.push(f)
  const waiting = await f.connection()
  f.active('quill')
  const r = await f.request('sidequest:read sidequest:hire')
  const approved = await f.route(`/oauth/requests/${r.requestId}/approve`, { agentIds: ['quill'] })
  const code = new URL(
    Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Struct({ redirectUrl: Schema.String }) }))(approved?.body)
      .result.redirectUrl,
  ).searchParams.get('code')!
  const token = await f.route('/oauth/token', {
    grant_type: 'authorization_code',
    client_id: r.clientId,
    resource,
    redirect_uri: 'http://127.0.0.1:3210/callback',
    code,
    code_verifier: 'a'.repeat(43),
  })
  const direct = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }))(token?.body)
  const access = (action: string, body: Record<string, unknown> = {}, owner = operator) =>
    agentAccess({ request: { action, id: 'quill', body }, sql: f.sql, operator: owner, bindings: {}, now: f.now })
  return { ...f, waiting, direct, access }
}

it('the operator sets the agent roles; nothing else, and only for its own agent', async () => {
  const f = await fixture()
  expect(await f.access('roles', { roles: ['hire'] })).toEqual({ roles: ['hire'] })
  expect(f.agents.roles('quill')).toEqual(['hire'])
  expect(await f.access('roles', { roles: [] })).toEqual({ roles: [] })
  await expect(f.access('roles', { roles: ['admin'] })).rejects.toMatchObject({ code: 'invalid' })
  await expect(f.access('roles', { roles: ['work'], extra: true })).rejects.toMatchObject({ code: 'invalid' })
  await expect(f.access('roles', { roles: ['work'] }, outsider)).rejects.toThrow('another operator')
})

it('lists both kinds of live connection with their client and scope, and disconnects one at a time', async () => {
  const f = await fixture()
  // SAFETY: the connections action answers its list.
  const listed = (
    (await f.access('connections')) as { connections: { id: string; client: string; scopes: string[] }[] }
  ).connections
  expect(listed.map((connection) => connection.scopes).toSorted((a, b) => a.join().localeCompare(b.join()))).toEqual([
    ['sidequest:hire', 'sidequest:read'],
    ['sidequest:read', 'sidequest:work'],
  ])
  expect(listed.every((connection) => connection.client === 'Coding agent')).toBe(true)
  const setupFamily = (await resolveOAuth(f.sql, f.waiting.tokens.access_token, resource, f.now()))!.grantId!
  await f.access('disconnect', { familyId: setupFamily })
  expect(await resolveOAuth(f.sql, f.waiting.tokens.access_token, resource, f.now())).toBeUndefined()
  expect(await resolveOAuth(f.sql, f.direct.access_token, resource, f.now())).toMatchObject({ agentIds: ['quill'] })
  expect(agentConnections(f.sql, 'quill', f.now())).toHaveLength(1)
  await expect(f.access('disconnect', { familyId: setupFamily })).rejects.toMatchObject({ code: 'not-found' })
})

// ADR-0021: a listening connection is told its tools changed exactly when this value does.
it('a connection’s access follows its agent’s roles and ends when it is disconnected', async () => {
  const f = await fixture()
  const direct = (await resolveOAuth(f.sql, f.direct.access_token, resource, f.now()))!.grantId!
  const before = connectionAccess(f.sql, direct)
  expect(before).toContain('quill')
  await f.access('roles', { roles: ['work'] })
  const after = connectionAccess(f.sql, direct)
  expect(after).not.toBe(before)
  // Both kinds of connection carry the agent's roles, which every tool decision reads.
  for (const token of [f.direct.access_token, f.waiting.tokens.access_token])
    expect(await resolveOAuth(f.sql, token, resource, f.now())).toMatchObject({ agentIds: ['quill'], roles: ['work'] })
  await f.access('roles', { roles: ['work'] })
  expect(connectionAccess(f.sql, direct)).toBe(after)
  await f.access('disconnect', { familyId: direct })
  expect(connectionAccess(f.sql, direct)).toBeUndefined()
  expect(connectionAccess(f.sql, 'oauth_unknown')).toBeUndefined()
})

it('records when each connection was last used, at most once a minute', async () => {
  const f = await fixture()
  const direct = (await resolveOAuth(f.sql, f.direct.access_token, resource, f.now()))!.grantId!
  const lastUsed = () => agentConnections(f.sql, 'quill', f.now()).find((row) => row.id === direct)?.lastUsedAt
  expect(lastUsed()).toBeNull()
  touchConnection(f.sql, direct, 1_000)
  touchConnection(f.sql, direct, 1_059)
  expect(lastUsed()).toBe(1_000)
  touchConnection(f.sql, direct, 1_060)
  expect(lastUsed()).toBe(1_060)
})

it('routes roles, connections and a single disconnect to the management object', () => {
  expect(agentRoute('POST', '/api/agents/quill/roles', { roles: ['work'] })).toMatchObject({ action: 'roles' })
  expect(agentRoute('GET', '/api/agents/quill/connections', {})).toMatchObject({ action: 'connections', id: 'quill' })
  expect(agentRoute('POST', `/api/agents/quill/connections/oauth_${'a'.repeat(40)}/disconnect`, {})).toEqual({
    action: 'disconnect',
    id: 'quill',
    body: { familyId: `oauth_${'a'.repeat(40)}` },
  })
  expect(agentRoute('POST', '/api/agents/quill/connections/not-a-family/disconnect', {})).toBeUndefined()
})
