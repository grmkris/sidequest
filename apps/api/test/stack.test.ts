import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import * as Effect from 'effect/Effect'
import { Schema } from 'effect'
import * as HttpBody from 'effect/http/HttpBody'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import { expect } from 'vitest'
import Stack from '../../../alchemy.run.ts'
import EventStreamApi, { STREAM_TOKEN, APPEND_TOKEN } from './mcp-event-stream-worker.ts'
import { decodeX402Header } from '@sidequest/board'
import { deployment } from '@sidequest/sdk'
import { pkceChallenge } from '../src/oauth-validation.ts'
import { MAX_API_BODY_BYTES } from '../src/request-body.ts'

/**
 * Deploys the stack into local workerd (`dev: true`) and probes every binding through the Worker.
 * Runs without Cloudflare credentials: every resource here has a local provider.
 */
const { test, beforeAll, deploy } = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  dev: true,
})

const StreamStack = Alchemy.Stack(
  'SidequestEventStreamTest',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const api = yield* EventStreamApi
    return { apiUrl: api.url }
  }),
)
const streamStack = beforeAll(deploy(StreamStack))
const stack = beforeAll(deploy(Stack))
// No `destroy`: the stack is local (`.alchemy/` is gitignored, CI runners are ephemeral) and
// destroying a local stack hangs the harness in alchemy 2.0.0-beta.79. Persisting it also makes
// reruns fast, so every test below must be independent of what earlier runs left behind.

const rpcSet = (process.env.MONAD_TESTNET_RPC_URL ?? '') !== ''

const postJson = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  HttpClient.post(url, { body: HttpBody.text(JSON.stringify(body), 'application/json'), headers })

/** One REST tool call, with an operator session when given. */
const rest = <T>(apiUrl: string, tool: string, body: unknown, session?: string) =>
  Effect.gen(function* () {
    const r = yield* postJson(
      `${apiUrl}/api/${tool}`,
      body,
      session === undefined ? {} : { authorization: `Bearer ${session}` },
    )
    return (yield* r.json) as { ok: boolean; result: T; code?: string; message?: string }
  })

/** A fresh operator wallet signed in over REST (needs an RPC to verify the signature). */
const signIn = (apiUrl: string) =>
  Effect.gen(function* () {
    const account = privateKeyToAccount(generatePrivateKey())
    const { result: challenge } = yield* rest<{ message: string }>(apiUrl, 'auth_challenge', {
      address: account.address,
    })
    const signature = yield* Effect.promise(() => account.signMessage({ message: challenge.message }))
    const login = yield* rest<{ session: string; boardId: string }>(apiUrl, 'auth_login', {
      message: challenge.message,
      signature,
    })
    return { account, login }
  })

test(
  'the real Worker rejects an oversized chunked API body before JSON parsing',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const response = yield* Effect.promise(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_API_BODY_BYTES))
          controller.enqueue(new Uint8Array(1))
          controller.close()
        },
      })
      const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half' }
      return fetch(`${apiUrl}/api/list_messages`, init)
    })
    expect(response.status).toBe(413)
    expect(yield* Effect.promise(() => response.json())).toMatchObject({ ok: false, code: 'invalid' })
  }),
)

test(
  'the real Worker refuses malformed JSON and holds REST arguments to the published schema, coercing safe integers',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const raw = (tool: string, body: string) =>
      Effect.promise(() =>
        fetch(`${apiUrl}/api/${tool}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }),
      )
    const broken = yield* raw('list_directory', '{"limit": 5')
    expect(broken.status).toBe(400)
    expect(yield* Effect.promise(() => broken.json())).toMatchObject({ code: 'invalid', reason: 'invalid-json' })
    const list = yield* raw('list_directory', '[1]')
    expect(list.status).toBe(400)
    // Worker-local tool (sign-in): a wrong type is refused with its field, before any session work.
    const local = yield* raw('auth_challenge', JSON.stringify({ address: true }))
    expect(local.status).toBe(400)
    expect(yield* Effect.promise(() => local.json())).toMatchObject({
      code: 'invalid',
      reason: 'invalid-arguments',
      retry: 'none',
      field: 'address',
    })
    // Board-object tool: a JSON integer id is coerced to its string and the call runs (no such task); a boolean is not.
    const coerced = yield* raw('get_task', JSON.stringify({ taskId: 5 }))
    expect(yield* Effect.promise(() => coerced.json())).toMatchObject({ ok: false, code: 'not-found' })
    const refused = yield* raw('get_task', JSON.stringify({ taskId: true }))
    expect(refused.status).toBe(400)
    expect(yield* Effect.promise(() => refused.json())).toMatchObject({ code: 'invalid', field: 'taskId' })
  }),
)

test(
  'the real local Worker serves the testnet x402 proof challenge without calling the facilitator',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const response = yield* HttpClient.get(`${apiUrl}/x402/demo`)
    expect(response.status).toBe(402)
    const header = response.headers['payment-required']
    expect(header).toBeDefined()
    const required = decodeX402Header(header!)
    expect(yield* response.json).toEqual(required)
    expect(required).toMatchObject({
      x402Version: 2,
      accepts: [{ amount: '10000', payTo: deployment('monad-testnet').sidequest!.safe, network: 'eip155:10143' }],
    })
  }),
)

test(
  'the worker answers from workerd',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const response = yield* HttpClient.get(`${apiUrl}/health`)
    const body = (yield* response.json) as { ok: boolean; runtime: string; network: string }
    expect(body.ok).toBe(true)
    // The same probe cloudflare-os uses: workerd hardcodes this user agent, Node never does.
    expect(body.runtime).toBe('Cloudflare-Workers')
    expect(body.network).toBe('monad-testnet')
  }),
)

test(
  'public and board metadata works through real workerd without MCP authentication',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    for (const path of ['/mcp/server-card', '/b/public/mcp/server-card']) {
      const response = yield* HttpClient.get(`${apiUrl}${path}`)
      expect(response.status).toBe(200)
      expect(response.headers['content-type']).toBe('application/mcp-server-card+json')
      expect(response.headers['access-control-allow-origin']).toBe('*')
      expect(yield* response.json).toMatchObject({
        name: 'exchange.sidequest/sidequest',
        version: '2.0.0',
        remotes: [
          { url: `${apiUrl}${path.slice(0, -'/server-card'.length)}` },
          { url: `${apiUrl}${path.slice(0, -'/server-card'.length)}/directory`, authentication: { type: 'none' } },
        ],
      })
      const cached = yield* HttpClient.get(`${apiUrl}${path}`, { headers: { 'if-none-match': response.headers.etag! } })
      expect(cached.status).toBe(304)
      const head = yield* HttpClient.head(`${apiUrl}${path}`)
      expect(head.status).toBe(200)
    }
    const missing = yield* HttpClient.get(`${apiUrl}/b/no-such-board/mcp/server-card`)
    expect(missing.status).toBe(404)
    const post = yield* postJson(`${apiUrl}/mcp/server-card`, {})
    expect(post.status).toBe(405)
    const catalog = yield* HttpClient.get(`${apiUrl}/.well-known/ai-catalog.json`)
    expect(catalog.status).toBe(200)
    expect(catalog.headers['content-type']).toBe('application/ai-catalog+json')
    const proof = yield* HttpClient.get(`${apiUrl}/.well-known/mcp-registry-auth`)
    expect(proof.status).toBe(200)
    expect(yield* proof.text).toMatch(/^v=MCPv1; k=ed25519; p=[A-Za-z0-9+/]{43}=\n$/)
  }),
)

test(
  'there is no unauthenticated manifest write (the S0 PUT is gone)',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const put = yield* HttpClient.put(`${apiUrl}/manifests/x.json`, { body: HttpBody.text('{}') })
    expect(put.status).toBe(404)
    const get = yield* HttpClient.get(`${apiUrl}/offers/0x${'00'.repeat(32)}.json`)
    expect(get.status).toBe(404)
  }),
)

test(
  'a deliverable preview is routed on both board paths and is unavailable until the index is built',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    // The local stack has no indexer tables: the chain check cannot run, so the answer is 503, never cached.
    const path = `/data/deliverables/0123456789abcdef/0x${'00'.repeat(32)}/preview`
    for (const url of [`${apiUrl}${path}`, `${apiUrl}/b/public${path}`]) {
      const unbuilt = yield* HttpClient.get(url)
      expect(unbuilt.status).toBe(503)
      expect(unbuilt.headers['cache-control']).toBe('no-store')
      expect(yield* unbuilt.json).toMatchObject({ ok: false, code: 'unavailable' })
    }
    const malformed = yield* HttpClient.get(`${apiUrl}/data/deliverables/x/preview`)
    expect(malformed.status).toBe(400)
  }),
)

test(
  'directory discovery and its Durable Object work without a job or wallet transaction',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const response = yield* HttpClient.get(`${apiUrl}/data/directory`)
    expect(response.status).toBe(200)
    const page = (yield* response.json) as { ok: boolean; agents: unknown[]; nextCursor: string | null }
    expect(page.ok).toBe(true)
    expect(page.agents).toEqual([])
    expect(page.nextCursor).toBeNull()
    const missing = yield* HttpClient.get(`${apiUrl}/data/directory/7001`)
    expect(missing.status).toBe(404)
    const read = yield* postJson(`${apiUrl}/api/list_directory`, {})
    expect(read.status).toBe(200)
    expect(yield* read.json).toMatchObject({ ok: true, result: { agents: [] } })
  }),
)

test.skipIf(!rpcSet)(
  'website SIWE prepares an offer and serves its manifest, but is not a hosted MCP grant',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const account = privateKeyToAccount(generatePrivateKey())
    const challenge = (yield* (yield* postJson(`${apiUrl}/api/auth_challenge`, { address: account.address })).json) as {
      result: { message: string }
    }
    const signature = yield* Effect.promise(() => account.signMessage({ message: challenge.result.message }))
    const login = (yield* (yield* postJson(`${apiUrl}/api/auth_login`, {
      message: challenge.result.message,
      signature,
    })).json) as { ok: boolean; result: { session: string } }
    expect(login.ok).toBe(true)
    const token = login.result.session
    const created = yield* postJson(
      `${apiUrl}/api/create_task`,
      {
        title: 'stack test',
        brief: 'nothing is published',
        acceptanceCriteria: [],
        token: 'mUSD',
        reward: '1',
        workerBond: '0',
        deliveryDeadline: Math.floor(Date.now() / 1000) + 3600,
        stack: 'main',
      },
      { authorization: `Bearer ${token}` },
    )
    const body = (yield* created.json) as { ok: boolean; result: { termsHash: string; transactions: unknown[] } }
    expect(body.ok).toBe(true)
    expect(body.result.transactions.length).toBeGreaterThan(0)
    const manifest = yield* HttpClient.get(`${apiUrl}/offers/${body.result.termsHash}.json`)
    expect(manifest.status).toBe(200)
    expect(((yield* manifest.json) as { title: string }).title).toBe('stack test')
  }),
)

test(
  'tenant boards: a board route that does not exist, CORS only for allowed origins, the boards listing',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const missing = yield* postJson(`${apiUrl}/b/nope/api/protocol_info`, {})
    expect(missing.status).toBe(404)
    expect(((yield* missing.json) as { code: string }).code).toBe('not-found')
    const preflight = yield* HttpClient.execute(
      HttpClientRequest.options(`${apiUrl}/b/public/api/list_tasks`, { headers: { origin: 'https://evil.example' } }),
    )
    expect(preflight.status).toBe(204)
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined()
    const boards = yield* HttpClient.get(`${apiUrl}/data/boards`)
    const body = (yield* boards.json) as { ok: boolean; boards: Array<{ id: string; public: boolean }> }
    expect(body.ok).toBe(true)
    expect(body.boards.find((b) => b.id === 'public')?.public).toBe(true)
  }),
)

test.skipIf(!rpcSet)(
  'tenant boards: sign in over REST, create a board, use its route, get CORS on its origin, refused token',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const { account, login } = yield* signIn(apiUrl!)
    expect(login.ok).toBe(true)
    expect(login.result.boardId).toBe('public')
    const slug = `t-${Math.random().toString(36).slice(2, 8)}`
    const created = yield* rest<{ board: { id: string; owner: string; tokens: Array<{ symbol: string }> } }>(
      apiUrl!,
      'create_board',
      {
        slug,
        name: 'Stack test board',
        stacks: ['main'],
        rewardTokens: ['mUSD'],
        allowedOrigins: ['https://host.example'],
        drip: false,
      },
      login.result.session,
    )
    expect(created.ok).toBe(true)
    expect(created.result.board.owner).toBe(account.address)
    expect(created.result.board.tokens.map((t) => t.symbol)).toEqual(['mUSD'])
    const card = yield* HttpClient.get(`${apiUrl}/b/${slug}/mcp/server-card`)
    expect(card.status).toBe(200)
    expect(card.headers['access-control-allow-origin']).toBe('*')
    expect(yield* card.json).toMatchObject({ remotes: [{ url: `${apiUrl}/b/${slug}/mcp` }] })
    const info = yield* postJson(`${apiUrl}/b/${slug}/api/protocol_info`, {}, { origin: 'https://host.example' })
    expect(info.status).toBe(200)
    expect(info.headers['access-control-allow-origin']).toBe('https://host.example')
    const listed = (yield* (yield* HttpClient.get(`${apiUrl}/data/boards`)).json) as { boards: Array<{ id: string }> }
    expect(listed.boards.some((b) => b.id === slug)).toBe(true)
    // The same session works on the new board (one session store), and its token subset is enforced.
    const refused = yield* postJson(
      `${apiUrl}/b/${slug}/api/create_task`,
      {
        title: 't',
        brief: 'b',
        acceptanceCriteria: [],
        token: 'mEUR',
        reward: '1',
        creatorBond: '0',
        workerBond: '0',
        deliveryDeadline: Math.floor(Date.now() / 1000) + 3600,
        mode: 'hire',
      },
      { authorization: `Bearer ${login.result.session}` },
    )
    expect(refused.status).toBe(400)
    expect(((yield* refused.json) as { message: string }).message).toMatch(/pays in mUSD/)
    const who = yield* rest<{ address: string; boardId: string }>(apiUrl!, 'whoami', {}, login.result.session)
    expect(who.result.address).toBe(account.address)
  }),
)

test(
  'hosted MCP requires OAuth and advertises exact public and tenant protected resources',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    for (const resourcePath of ['/mcp', '/b/public/mcp']) {
      const denied = yield* postJson(`${apiUrl}${resourcePath}`, { jsonrpc: '2.0', id: 1, method: 'initialize' })
      expect(denied.status).toBe(401)
      expect(denied.headers['www-authenticate']).toContain(`/.well-known/oauth-protected-resource${resourcePath}`)
      const metadata = yield* HttpClient.get(`${apiUrl}/.well-known/oauth-protected-resource${resourcePath}`)
      expect(metadata.status).toBe(200)
      expect(yield* metadata.json).toMatchObject({
        resource: `${apiUrl}${resourcePath}`,
        authorization_servers: [apiUrl],
        scopes_supported: ['sidequest:read', 'sidequest:hire', 'sidequest:work', 'sidequest:setup'],
      })
    }
    const discovery = yield* HttpClient.get(`${apiUrl}/.well-known/oauth-authorization-server`)
    expect(discovery.status).toBe(200)
    expect(yield* discovery.json).toMatchObject({
      token_endpoint: `${apiUrl}/oauth/token`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    })
  }),
)

test(
  'OAuth registration and authorize enforce exact redirect/resource and the website origin in workerd',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const bad = yield* postJson(`${apiUrl}/oauth/register`, { redirect_uris: ['http://untrusted.example/callback'] })
    expect(bad.status).toBe(400)
    const registration = yield* postJson(`${apiUrl}/oauth/register`, {
      redirect_uris: ['http://localhost:3333/callback'],
      client_name: 'Workerd OAuth client',
    })
    expect(registration.status).toBe(201)
    const client = (yield* registration.json) as { client_id: string }
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'http://localhost:3333/callback',
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      scope: 'sidequest:read',
      resource: `${apiUrl}/mcp`,
    })
    const evilOrigin = yield* HttpClient.get(`${apiUrl}/oauth/authorize?${query}`, {
      headers: { origin: 'https://evil.example' },
    })
    expect(evilOrigin.status).toBe(403)
    query.set('resource', 'https://evil.example/mcp')
    const evilResource = yield* HttpClient.get(`${apiUrl}/oauth/authorize?${query}`)
    expect(evilResource.status).toBe(400)
    query.set('resource', `${apiUrl}/b/public/mcp`)
    query.set('redirect_uri', 'http://localhost:3334/callback')
    expect((yield* HttpClient.get(`${apiUrl}/oauth/authorize?${query}`)).status).toBe(400)
    const consent = yield* postJson(
      `${apiUrl}/oauth/requests/oauth_${'a'.repeat(40)}/approve`,
      { agentIds: ['someone-else'] },
      { origin: 'https://evil.example' },
    )
    expect(consent.status).toBe(403)
  }),
)

test(
  'release_pick is internal: REST never reaches it',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const refused = yield* postJson(`${apiUrl}/api/release_pick`, { requestId: 'r1', taskId: 't1' })
    expect(refused.status).toBe(403)
  }),
)

test(
  'agent lifecycle and approval routes refuse unauthenticated and cross-origin decisions',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    for (const path of ['/api/agents', '/api/approvals', '/api/agents/not-owned/recovery']) {
      const response = yield* HttpClient.get(`${apiUrl}${path}`)
      expect(response.status).toBe(401)
    }
    const create = yield* postJson(
      `${apiUrl}/api/agents`,
      { id: 'fixture', name: 'fixture' },
      { origin: new URL(apiUrl!).origin },
    )
    expect(create.status).toBe(401)
    const foreign = yield* postJson(
      `${apiUrl}/api/agents/not-owned/stop-access`,
      {},
      { origin: 'https://foreign.invalid' },
    )
    expect(foreign.status).toBe(403)
  }),
)

/** Reads SSE frames off a live response until `count` arrive or the stream ends, as parsed JSON-RPC messages. */
async function sseFrames(reader: ReadableStreamDefaultReader<Uint8Array>, count: number) {
  const decoder = new TextDecoder()
  const seen: unknown[] = []
  let buffer = ''
  while (seen.length < count) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) if (block.startsWith('data: ')) seen.push(JSON.parse(block.slice('data: '.length)))
  }
  return seen
}

// ADR-0021: the listen stream is made in the management object and crosses Workers RPC into the Worker's response.
test.skipIf(!rpcSet)(
  'a 2026 setup connection listens through the real Worker and management object; revoking it ends the stream',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const origin = new URL(apiUrl!).origin
    const { login } = yield* signIn(apiUrl!)
    const redirect = 'http://localhost:3333/callback'
    const registration = yield* postJson(`${apiUrl}/oauth/register`, {
      redirect_uris: [redirect],
      client_name: 'Workerd listen client',
    })
    const { client_id } = Schema.decodeUnknownSync(Schema.Struct({ client_id: Schema.String }))(
      yield* registration.json,
    )
    const verifier = 'b'.repeat(43)
    const query = new URLSearchParams({
      client_id,
      redirect_uri: redirect,
      response_type: 'code',
      code_challenge: yield* Effect.promise(() => pkceChallenge(verifier)),
      code_challenge_method: 'S256',
      scope: 'sidequest:setup sidequest:read',
      resource: `${apiUrl}/mcp`,
      state: 'listen',
    })
    const authorize = yield* Effect.promise(() =>
      fetch(`${apiUrl}/oauth/authorize?${query.toString()}`, { redirect: 'manual' }),
    )
    const requestId = new URL(authorize.headers.get('location')!).searchParams.get('oauth_request')!
    const approved = yield* postJson(
      `${apiUrl}/oauth/requests/${requestId}/approve`,
      { setup: true, agentIds: [] },
      { origin, authorization: `Bearer ${login.result.session}` },
    )
    const { result } = Schema.decodeUnknownSync(
      Schema.Struct({ result: Schema.Struct({ redirectUrl: Schema.String }) }),
    )(yield* approved.json)
    const token = yield* postJson(`${apiUrl}/oauth/token`, {
      grant_type: 'authorization_code',
      client_id,
      resource: `${apiUrl}/mcp`,
      redirect_uri: redirect,
      code: new URL(result.redirectUrl).searchParams.get('code')!,
      code_verifier: verifier,
    })
    const { access_token } = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }))(yield* token.json)
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    }
    const discover = yield* postJson(
      `${apiUrl}/mcp`,
      { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } },
      { authorization: `Bearer ${access_token}` },
    )
    expect(yield* discover.json).toMatchObject({ result: { capabilities: { tools: { listChanged: true } } } })
    const listen = yield* Effect.promise(() =>
      fetch(`${apiUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${access_token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'listen-1',
          method: 'subscriptions/listen',
          params: { notifications: { toolsListChanged: true, resourcesListChanged: true }, _meta: meta },
        }),
      }),
    )
    expect(listen.status).toBe(200)
    expect(listen.headers.get('content-type')).toBe('text/event-stream')
    const reader = listen.body!.getReader()
    const subscription = { _meta: { 'io.modelcontextprotocol/subscriptionId': 'listen-1' } }
    expect(yield* Effect.promise(() => sseFrames(reader, 2))).toEqual([
      {
        jsonrpc: '2.0',
        method: 'notifications/subscriptions/acknowledged',
        params: { notifications: { toolsListChanged: true }, ...subscription },
      },
      { jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: subscription },
    ])
    const revoked = yield* postJson(`${apiUrl}/oauth/revoke`, { token: access_token, client_id })
    expect(revoked.status).toBe(200)
    expect(yield* Effect.promise(() => sseFrames(reader, 2))).toEqual([
      { jsonrpc: '2.0', id: 'listen-1', result: { resultType: 'complete', ...subscription } },
    ])
  }),
)

test(
  'events/stream crosses the real Worker and management object, delivers an appended D1 row and ends on revocation',
  Effect.gen(function* () {
    const { apiUrl } = yield* streamStack
    if (apiUrl === undefined) throw new Error('The local event-stream Worker has no URL')
    yield* Effect.promise(async () => {
      const response = await postEventStream(apiUrl, STREAM_TOKEN, 'events/stream')
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/event-stream')
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('x-accel-buffering')).toBe('no')
      const reader = response.body!.getReader()
      const subscription = { _meta: { 'io.modelcontextprotocol/subscriptionId': 'stream-1' } }
      try {
        expect(await sseFrames(reader, 1)).toMatchObject([
          { method: 'notifications/events/active', params: { truncated: false, ...subscription } },
        ])
        const appendedAt = Date.now()
        const appended = await postEventStream(apiUrl, APPEND_TOKEN, 'events/list')
        expect(appended.status).toBe(200)
        expect(await appended.json()).toMatchObject({
          result: {
            events: expect.arrayContaining([expect.objectContaining({ delivery: ['poll', 'webhook', 'push'] })]),
          },
        })
        const delivered = await sseFrames(reader, 1)
        expect(Date.now() - appendedAt).toBeLessThan(6_000)
        expect(delivered).toMatchObject([
          {
            method: 'notifications/events/event',
            params: {
              name: 'sidequest.inbox',
              data: { kind: 'job.overdue', summary: 'Local stream integration' },
              ...subscription,
            },
          },
        ])
        expect(await sseFrames(reader, 1)).toMatchObject([
          { method: 'notifications/events/heartbeat', params: subscription },
        ])
        const revoked = await fetch(`${apiUrl}/oauth/revoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: STREAM_TOKEN, client_id: 'local-stream-client' }),
        })
        expect(revoked.status).toBe(200)
        expect(await sseFrames(reader, 2)).toMatchObject([
          { method: 'notifications/events/terminated', params: { error: { code: -32003 }, ...subscription } },
          { id: 'stream-1', result: { resultType: 'complete', ...subscription } },
        ])
        expect((await reader.read()).done).toBe(true)
      } finally {
        await reader.cancel()
      }
    })
  }),
)

function postEventStream(apiUrl: string, token: string, method: string) {
  return fetch(`${apiUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      origin: 'https://host.example',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'stream-1',
      method,
      params: { name: 'sidequest.inbox', arguments: {}, cursor: null },
    }),
  })
}
