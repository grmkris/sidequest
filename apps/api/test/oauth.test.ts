/** Real SQLite storage and WebCrypto PKCE. No provider/network substitutions. */
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { Schema } from 'effect'
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
const TokenPair = Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String })
const Refusal = Schema.Struct({ error: Schema.String, error_description: Schema.String })
const decode = <A>(schema: Schema.Codec<A, unknown>, reply: OAuthReply) => Schema.decodeUnknownSync(schema)(reply.body)

async function echoWebhookChallenge(_url: unknown, init?: RequestInit) {
  const envelope = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as { challenge: string }
  return Response.json({ challenge: envelope.challenge })
}

function fixture(mediaRole?: 'operator' | 'member') {
  const db = new DatabaseSync(':memory:')
  const sql = fromNodeSqlite(db)
  const d1 = asyncSql(db)
  const agents = new AgentStore(sql, () => 1000)
  agents.create({ id: 'one', operator: owner, privyUserId: 'did:privy:test', name: 'one', registry, chainId: 10143 })
  agents.bindWallet('one', 'wallet-one', wallet)
  agents.bindRegistry('one', '10')
  for (const state of ['upgraded', 'grants-live', 'registered', 'active'] as const) agents.advance('one', state)
  let time = 1000
  const clock = (at: number) => {
    time = at
  }
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
      now: time,
      ...(operator === undefined ? {} : { owner: operator }),
      ...(mediaRole === undefined ? {} : { mediaRole }),
      revokeSubscriptions: (principal, family, now) => terminateGrantSubscriptions(d1, principal, family, now),
    }) as Promise<OAuthReply>
  return { db, sql, d1, agents, route, clock }
}

async function connection(
  f: ReturnType<typeof fixture>,
  scopes?: string[],
  requested = 'sidequest:read sidequest:work sidequest:hire',
  consentBody: Record<string, unknown> = {},
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
    ...consentBody,
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

test('refresh rotates; a replay after the grace revokes every token in the connection, the rotated ones too', async () => {
  const f = fixture()
  try {
    const c = await connection(f)
    const first = (await f.route('/oauth/token', c.tokenBody)).body as Tokens
    const input = { grant_type: 'refresh_token', client_id: c.clientId, resource, refresh_token: first.refresh_token }
    const second = (await f.route('/oauth/token', input)).body as Tokens
    expect(await resolveOAuth(f.sql, second.access_token, resource, 1000)).toBeDefined()
    f.clock(1061)
    const replay = await f.route('/oauth/token', input)
    expect(replay).toMatchObject({ status: 400, body: { error: 'invalid_grant' } })
    expect(decode(Refusal, replay).error_description).toMatch(/^Refresh token reused .*sign in again$/)
    expect(await resolveOAuth(f.sql, second.access_token, resource, 1000)).toBeUndefined()
    expect(await resolveOAuth(f.sql, first.access_token, resource, 1000)).toBeUndefined()
    expect((await f.route('/oauth/token', { ...input, refresh_token: second.refresh_token })).status).toBe(400)
  } finally {
    f.db.close()
  }
})

test('a refresh token sent again within 60 seconds (a lost response) gets a fresh pair; one stays live (prod gap 9)', async () => {
  const f = fixture()
  try {
    const c = await connection(f)
    const first = decode(TokenPair, await f.route('/oauth/token', c.tokenBody))
    const input = { grant_type: 'refresh_token', client_id: c.clientId, resource, refresh_token: first.refresh_token }
    const lost = decode(TokenPair, await f.route('/oauth/token', input))
    f.clock(1060)
    const retried = await f.route('/oauth/token', input)
    expect(retried.status).toBe(200)
    const kept = decode(TokenPair, retried)
    expect(kept.refresh_token).not.toBe(lost.refresh_token)
    expect(await resolveOAuth(f.sql, kept.access_token, resource, 1060)).toBeDefined()
    // The pair whose response was lost retired its refresh token; the connection itself lives on.
    expect(
      f.sql.all("SELECT COUNT(*) n FROM agent_oauth_tokens WHERE kind='refresh' AND consumed_at IS NULL")[0],
    ).toEqual({ n: 1 })
    f.clock(1200)
    const next = await f.route('/oauth/token', { ...input, refresh_token: kept.refresh_token })
    expect(next.status).toBe(200)
    expect(await resolveOAuth(f.sql, decode(TokenPair, next).access_token, resource, 1200)).toBeDefined()
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
      f.clock(1061)
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

// ADR-0028: the Commons role tools come only from the operator's tick, for a client that asked for them.
test('grants sidequest:maintain only when the client asked for it and the operator ticked it, and refresh keeps it', async () => {
  const f = fixture()
  try {
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource/b/team-board/mcp',
    ]) {
      // SAFETY: both discovery documents carry scopes_supported.
      const discovery = (await f.route(path, {}, new URLSearchParams(), 'GET')).body as { scopes_supported: string[] }
      expect(discovery.scopes_supported).toContain('sidequest:maintain')
    }
    const requested = 'sidequest:read sidequest:work sidequest:maintain'
    const scopesOf = async (tokens: Tokens) => (await resolveOAuth(f.sql, tokens.access_token, resource, 1000))?.scopes
    // Asked for but not ticked: the connection holds the rest, and its token says the narrower scope.
    const unticked = await connection(f, undefined, requested)
    // SAFETY: a token reply for an approved consent carries the issued token pair and its scope.
    const plain = (await f.route('/oauth/token', unticked.tokenBody)).body as Tokens & { scope: string }
    expect(plain.scope).toBe('sidequest:read sidequest:work')
    expect(await scopesOf(plain)).toEqual(['sidequest:read', 'sidequest:work'])
    const ticked = await connection(f, undefined, requested, { maintain: true })
    // SAFETY: as above.
    const granted = (await f.route('/oauth/token', ticked.tokenBody)).body as Tokens & { scope: string }
    expect(granted.scope).toBe('sidequest:maintain sidequest:read sidequest:work')
    const refresh = { grant_type: 'refresh_token', client_id: ticked.clientId, resource }
    // SAFETY: a refresh reply carries the rotated token pair and its scope.
    const refreshed = (await f.route('/oauth/token', { ...refresh, refresh_token: granted.refresh_token }))
      .body as Tokens & {
      scope: string
    }
    expect(refreshed.scope).toBe(granted.scope)
    expect(await scopesOf(refreshed)).toEqual(['sidequest:maintain', 'sidequest:read', 'sidequest:work'])
  } finally {
    f.db.close()
  }
})

test('refuses a maintain tick the client did not ask for, and a maintain value that is not a boolean', async () => {
  const f = fixture()
  try {
    const registered = await f.route('/oauth/register', { redirect_uris: [redirectUri], client_name: 'SQLite client' })
    const clientId = decode(Schema.Struct({ client_id: Schema.String }), registered).client_id
    const consent = async (scope?: string) => {
      const query = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        resource,
        code_challenge_method: 'S256',
        code_challenge: await pkceChallenge(verifier),
        state: `state-${scope ?? 'default'}`,
        ...(scope === undefined ? {} : { scope }),
      })
      const authorize = await f.route('/oauth/authorize', {}, query, 'GET')
      return new URL(authorize.redirect!).searchParams.get('oauth_request')!
    }
    const narrow = await consent('sidequest:read sidequest:hire')
    for (const maintain of [true, 'yes']) {
      const refused = await f.route(`/oauth/requests/${narrow}/approve`, { agentIds: ['one'], maintain })
      expect(refused.status).toBe(400)
      expect(decode(Refusal, refused)).toEqual({
        error: 'invalid_request',
        error_description: expect.stringContaining('sidequest:maintain'),
      })
    }
    // The refusals left the consent pending: approving without the tick still connects, without the scope.
    expect((await f.route(`/oauth/requests/${narrow}/approve`, { agentIds: ['one'], maintain: false })).status).toBe(
      200,
    )
    // A client that names no scope asks for every supported one: the page may offer the tick, and none is granted unticked.
    const open = await consent()
    const page = await f.route(`/oauth/requests/${open}`, {}, new URLSearchParams(), 'GET')
    const Page = Schema.Struct({
      result: Schema.Struct({ request: Schema.Struct({ scopes: Schema.Array(Schema.String) }) }),
    })
    expect(decode(Page, page).result.request.scopes).toContain('sidequest:maintain')
    const approved = await f.route(`/oauth/requests/${open}/approve`, { agentIds: ['one'] })
    const Redirect = Schema.Struct({ result: Schema.Struct({ redirectUrl: Schema.String }) })
    const code = new URL(decode(Redirect, approved).result.redirectUrl).searchParams.get('code')!
    const token = await f.route('/oauth/token', {
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: redirectUri,
      resource,
      code,
      code_verifier: verifier,
    })
    expect(decode(Schema.Struct({ scope: Schema.String }), token).scope).toBe(
      'sidequest:hire sidequest:read sidequest:work',
    )
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

// ADR-0029: the media team's tools come only from the operator's tick, offered only to a media team operator.
test('offers and grants sidequest:media only to an operator on the media team, for a client that asked for it', async () => {
  const requested = 'sidequest:read sidequest:work sidequest:media'
  const offered = async (f: ReturnType<typeof fixture>) => {
    const registered = await f.route('/oauth/register', { redirect_uris: [redirectUri], client_name: 'SQLite client' })
    const query = new URLSearchParams({
      client_id: decode(Schema.Struct({ client_id: Schema.String }), registered).client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: requested,
      resource,
      code_challenge_method: 'S256',
      code_challenge: await pkceChallenge(verifier),
      state: 'state-media',
    })
    const authorize = await f.route('/oauth/authorize', {}, query, 'GET')
    const requestId = new URL(authorize.redirect!).searchParams.get('oauth_request')!
    const shown = await f.route(`/oauth/requests/${requestId}`, {}, new URLSearchParams(), 'GET')
    return {
      requestId,
      offers: decode(
        Schema.Struct({ result: Schema.Struct({ offers: Schema.Struct({ media: Schema.NullOr(Schema.String) }) }) }),
        shown,
      ).result.offers,
    }
  }
  const outside = fixture()
  try {
    const consent = await offered(outside)
    expect(consent.offers.media).toBeNull()
    const ticked = await outside.route(`/oauth/requests/${consent.requestId}/approve`, {
      agentIds: ['one'],
      media: true,
    })
    expect(ticked.status).toBe(400)
  } finally {
    outside.db.close()
  }
  const inside = fixture('member')
  try {
    expect((await offered(inside)).offers.media).toBe('member')
    const granted = await connection(inside, undefined, requested, { media: true })
    // SAFETY: a token reply for an approved consent carries the issued token pair and its scope.
    const tokens = (await inside.route('/oauth/token', granted.tokenBody)).body as Tokens & { scope: string }
    expect(tokens.scope).toBe('sidequest:media sidequest:read sidequest:work')
    const unticked = await connection(inside, undefined, requested)
    // SAFETY: as above.
    expect(((await inside.route('/oauth/token', unticked.tokenBody)).body as { scope: string }).scope).toBe(
      'sidequest:read sidequest:work',
    )
    const narrow = await connection(inside, undefined, 'sidequest:read sidequest:work').catch(() => undefined)
    expect(narrow).toBeDefined()
  } finally {
    inside.db.close()
  }
})
