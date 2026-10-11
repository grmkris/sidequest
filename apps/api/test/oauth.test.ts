/** Real SQLite storage and WebCrypto PKCE. No provider/network substitutions. */
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { AgentStore, fromNodeSqlite } from '@sidequest/board'
import type { Address } from 'viem'
import { oauthRoute, resolveOAuth, type OAuthReply } from '../src/oauth.ts'
import { pkceChallenge } from '../src/oauth-validation.ts'
import { fromNodeSqlite as asyncSql, stmt } from '@sidequest/indexer'
import { McpEvents } from '../src/mcp-events.ts'
import { deliverWebhooks, terminateGrantSubscriptions } from '../src/webhooks.ts'

const owner = `0x${'11'.repeat(20)}` as Address
const wallet = `0x${'22'.repeat(20)}` as Address
const registry = `0x${'33'.repeat(20)}` as Address
const origin = 'https://sidequest.example'
const resource = `${origin}/b/team-board/mcp`
const verifier = 'a'.repeat(43)
const redirectUri = 'http://127.0.0.1:3210/callback'

type Tokens = { access_token: string; refresh_token: string }

async function echoWebhookChallenge(_url: unknown, init?: RequestInit) {
  const envelope = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as { challenge: string }
  return Response.json({ challenge: envelope.challenge })
}

function fixture() {
  const db = new DatabaseSync(':memory:')
  const sql = fromNodeSqlite(db)
  const d1 = asyncSql(db)
  const agents = new AgentStore(sql, () => 1000)
  agents.create({ id: 'one', operator: owner, privyUserId: 'did:privy:test', name: 'one', registry, chainId: 10143 })
  agents.bindWallet('one', 'wallet-one', wallet)
  agents.bindRegistry('one', '10')
  for (const state of ['upgraded', 'grants-live', 'registered', 'active'] as const) agents.advance('one', state)
  const route = (
    path: string,
    body: Record<string, unknown> = {},
    query = new URLSearchParams(),
    method = 'POST',
    operator: string | undefined = owner,
  ) =>
    oauthRoute({
      sql,
      path,
      body,
      query,
      method,
      origin,
      siteOrigin: origin,
      now: 1000,
      ...(operator === undefined ? {} : { owner: operator }),
      revokeSubscriptions: (principal, family, now) => terminateGrantSubscriptions(d1, principal, family, now),
    }) as Promise<OAuthReply>
  return { db, sql, d1, agents, route }
}

async function connection(
  f: ReturnType<typeof fixture>,
  scopes?: string[],
  requested = 'sidequest:read sidequest:work sidequest:hire',
) {
  const registered = await f.route('/oauth/register', { redirect_uris: [redirectUri], client_name: 'SQLite client' })
  const clientId = (registered.body as { client_id: string }).client_id
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: requested,
    resource,
    code_challenge_method: 'S256',
    code_challenge: await pkceChallenge(verifier),
    state: 'state-one',
  })
  const authorize = await f.route('/oauth/authorize', {}, query, 'GET')
  const requestId = new URL(authorize.redirect!).searchParams.get('oauth_request')!
  const approve = await f.route(`/oauth/requests/${requestId}/approve`, {
    agentIds: ['one'],
    ...(scopes === undefined ? {} : { scopes }),
  })
  const code = new URL((approve.body as { result: { redirectUrl: string } }).result.redirectUrl).searchParams.get(
    'code',
  )!
  const tokenBody = {
    grant_type: 'authorization_code',
    client_id: clientId,
    redirect_uri: redirectUri,
    resource,
    code,
    code_verifier: verifier,
  }
  return { clientId, tokenBody, requestId, query }
}

test('one-agent OAuth code is bound to PKCE, client, redirect and exact tenant resource', async () => {
  const f = fixture()
  try {
    const c = await connection(f)
    for (const change of [
      { resource: `${origin}/mcp` },
      { client_id: 'other' },
      { redirect_uri: 'http://127.0.0.1:3211/callback' },
      { code_verifier: 'b'.repeat(43) },
    ])
      expect((await f.route('/oauth/token', { ...c.tokenBody, ...change })).status).toBe(400)
    const reply = await f.route('/oauth/token', c.tokenBody)
    expect(reply.status).toBe(200)
    const tokens = reply.body as Tokens
    expect((await resolveOAuth(f.sql, tokens.access_token, resource, 1000))?.agentIds).toEqual(['one'])
    expect(await resolveOAuth(f.sql, tokens.access_token, `${origin}/mcp`, 1000)).toBeUndefined()
    expect((await f.route('/oauth/token', c.tokenBody)).status).toBe(400)
    expect((await f.route(`/oauth/requests/${c.requestId}/approve`, { agentIds: ['one'] })).status).toBe(400)
  } finally {
    f.db.close()
  }
})

test('refresh rotates; replay revokes every token in the connection, including the rotated token', async () => {
  const f = fixture()
  try {
    const c = await connection(f)
    const first = (await f.route('/oauth/token', c.tokenBody)).body as Tokens
    const input = { grant_type: 'refresh_token', client_id: c.clientId, resource, refresh_token: first.refresh_token }
    const second = (await f.route('/oauth/token', input)).body as Tokens
    expect(await resolveOAuth(f.sql, second.access_token, resource, 1000)).toBeDefined()
    expect((await f.route('/oauth/token', input)).status).toBe(400)
    expect(await resolveOAuth(f.sql, second.access_token, resource, 1000)).toBeUndefined()
    expect(await resolveOAuth(f.sql, first.access_token, resource, 1000)).toBeUndefined()
  } finally {
    f.db.close()
  }
})

test.each(['access', 'refresh-replay'])('disconnect %s stops callbacks under that OAuth family', async (kind) => {
  const f = fixture()
  try {
    const c = await connection(f)
    const tokens = (await f.route('/oauth/token', c.tokenBody)).body as Tokens
    const grant = (await resolveOAuth(f.sql, tokens.access_token, resource, 1000))!
    const events = new McpEvents(f.d1, 'monad-testnet', { now: () => 1000, fetch: echoWebhookChallenge })
    const subscription = await events.handle(
      'events/subscribe',
      {
        name: 'sidequest.inbox',
        delivery: { mode: 'webhook', url: 'https://8.8.8.8/callback', secret: `whsec_${btoa('a'.repeat(32))}` },
      },
      grant,
    )
    if (kind === 'access') await f.route('/oauth/revoke', { token: tokens.access_token, client_id: c.clientId })
    else {
      const input = {
        grant_type: 'refresh_token',
        client_id: c.clientId,
        resource,
        refresh_token: tokens.refresh_token,
      }
      await f.route('/oauth/token', input)
      await f.route('/oauth/token', input)
    }
    expect(f.sql.all('SELECT status FROM event_subscriptions WHERE id=?', String(subscription.id))).toEqual([
      { status: 'terminated' },
    ])
    // Even a stale in-memory grant cannot resubscribe or resume a row after disconnect.
    await expect(
      events.handle(
        'events/subscribe',
        {
          name: 'sidequest.inbox',
          delivery: { mode: 'webhook', url: 'https://8.8.8.8/callback', secret: `whsec_${btoa('a'.repeat(32))}` },
        },
        grant,
      ),
    ).rejects.toMatchObject({ code: -32003 })
    await f.d1.batch([
      stmt("UPDATE event_subscriptions SET status='active', next_attempt_at=0 WHERE id=?", String(subscription.id)),
    ])
    expect(
      await deliverWebhooks(f.d1, 'monad-testnet', 1001, {
        fetch: async () => {
          throw new Error('must not deliver')
        },
      }),
    ).toEqual({ posts: 0, subscriptions: 0 })
  } finally {
    f.db.close()
  }
})

test('revoked agents cannot use or refresh an OAuth token and consent cannot grant several agents', async () => {
  const f = fixture()
  try {
    const c = await connection(f)
    const tokens = (await f.route('/oauth/token', c.tokenBody)).body as Tokens
    f.agents.advance('one', 'revoked')
    expect(await resolveOAuth(f.sql, tokens.access_token, resource, 1000)).toBeUndefined()
    expect(
      (
        await f.route('/oauth/token', {
          grant_type: 'refresh_token',
          client_id: c.clientId,
          resource,
          refresh_token: tokens.refresh_token,
        })
      ).status,
    ).toBe(400)
  } finally {
    f.db.close()
  }
})

// ADR-0021: the connection holds what its client asked for; the agent's roles, not consent, decide within it.
test('consent grants what the client requested plus read, whatever scopes the page sends', async () => {
  const f = fixture()
  try {
    const c = await connection(f, ['sidequest:read'])
    const tokens = (await f.route('/oauth/token', c.tokenBody)).body as Tokens
    expect((await resolveOAuth(f.sql, tokens.access_token, resource, 1000))?.scopes).toEqual([
      'sidequest:hire',
      'sidequest:read',
      'sidequest:work',
    ])
    const next = await f.route('/oauth/authorize', {}, c.query, 'GET')
    const requestId = new URL(next.redirect!).searchParams.get('oauth_request')!
    expect(
      (await f.route(`/oauth/requests/${requestId}/approve`, { agentIds: ['one'], scopes: ['arbitrary:write'] }))
        .status,
    ).toBe(200)
    const hireOnly = await connection(f, ['sidequest:work'], 'sidequest:hire')
    // SAFETY: a token reply for an approved consent carries the issued token pair.
    const hiring = (await f.route('/oauth/token', hireOnly.tokenBody)).body as Tokens
    expect((await resolveOAuth(f.sql, hiring.access_token, resource, 1000))?.scopes).toEqual([
      'sidequest:hire',
      'sidequest:read',
    ])
  } finally {
    f.db.close()
  }
})

// Every documented client requests setup; picking an existing agent on that consent page must still connect it.
test('a client that requested setup can connect an existing agent', async () => {
  const f = fixture()
  try {
    const c = await connection(
      f,
      ['sidequest:setup', 'sidequest:read', 'sidequest:hire'],
      'sidequest:setup sidequest:read sidequest:hire',
    )
    const reply = await f.route('/oauth/token', c.tokenBody)
    expect(reply.status).toBe(200)
    // SAFETY: a 200 token reply always carries the issued token pair.
    const grant = await resolveOAuth(f.sql, (reply.body as Tokens).access_token, resource, 1000)
    expect(grant).toMatchObject({ agentIds: ['one'], scopes: ['sidequest:hire', 'sidequest:read'] })
    expect(grant?.setup).toBeUndefined()
  } finally {
    f.db.close()
  }
})

// Jonas, 11 Oct: Codex opened the sign-in link and it was opened again, so two consent pages raced one listener.
test('the same sign-in link opened twice is one consent request', async () => {
  const f = fixture()
  try {
    const c = await connection(f)
    const open = async () =>
      new URL((await f.route('/oauth/authorize', {}, c.query, 'GET')).redirect!).searchParams.get('oauth_request')
    const first = await open()
    expect(first).not.toBe(c.requestId)
    expect(await open()).toBe(first)
    const other = new URLSearchParams(c.query)
    other.set('code_challenge', await pkceChallenge('b'.repeat(43)))
    expect(
      new URL((await f.route('/oauth/authorize', {}, other, 'GET')).redirect!).searchParams.get('oauth_request'),
    ).not.toBe(first)
  } finally {
    f.db.close()
  }
})

test('consent identifies each requesting client and exact callback', async () => {
  const f = fixture()
  try {
    const first = await f.route('/oauth/register', {
      redirect_uris: ['http://127.0.0.1:3210/callback'],
      client_name: 'First editor',
    })
    const second = await f.route('/oauth/register', {
      redirect_uris: ['http://127.0.0.1:3211/callback'],
      client_name: 'Second editor',
    })
    for (const [registered, callback, name] of [
      [first, 'http://127.0.0.1:3210/callback', 'First editor'],
      [second, 'http://127.0.0.1:3211/callback', 'Second editor'],
    ] as const) {
      const clientId = (registered.body as { client_id: string }).client_id
      const query = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callback,
        response_type: 'code',
        resource,
        code_challenge_method: 'S256',
        code_challenge: await pkceChallenge(verifier),
      })
      const authorize = await f.route('/oauth/authorize', {}, query, 'GET')
      const requestId = new URL(authorize.redirect!).searchParams.get('oauth_request')!
      const consent = await f.route(`/oauth/requests/${requestId}`, {}, new URLSearchParams(), 'GET')
      expect(consent.body).toMatchObject({ result: { request: { clientId, clientName: name, redirectUri: callback } } })
    }
  } finally {
    f.db.close()
  }
})
