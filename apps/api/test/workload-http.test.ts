/** A real local HTTP MCP client through the production OAuth, MCP and executor functions; no cloud stage. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ClientCredentialsProvider } from '@modelcontextprotocol/sdk/client/auth-extensions.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { expect, it } from 'vitest'
import { Schema } from 'effect'
import { SPONSOR_OBJECT_NAME } from '@sidequest/board'
import type { BoardCall } from '../src/board.ts'
import { oauthRoute } from '../src/oauth.ts'
import { agentFirstMcpRoute } from '../src/mcp-agent-setup.ts'
import { hostedMcpTools } from '../src/mcp-registry.ts'
import { runAgent } from '../src/agent-runtime.ts'
import { JWT_BEARER_GRANT } from '../src/workload-policies.ts'
import { workloadFixture, Token, origin, resource } from './workload-fixture.ts'

const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))
const executeEnv: BoardCall['env'] = {
  network: 'monad-testnet',
  boardId: 'team-board',
  uri: origin,
  rpcUrl: 'http://127.0.0.1:1',
  domain: new URL(origin).hostname,
  manifestBaseUrl: `${origin}/offers`,
  screening: { baseUrl: '', apiKey: '', model: '' },
  attesterKey: '',
  relayKey: '',
  github: { appId: '', privateKeyPem: '', installationId: '' },
}

function localHandler(f: Awaited<ReturnType<typeof workloadFixture>>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString()
    const path = new URL(req.url ?? '/', origin).pathname
    const body =
      text === ''
        ? {}
        : path === '/oauth/token'
          ? Object.fromEntries(new URLSearchParams(text))
          : record(JSON.parse(text))
    const bearer = req.headers.authorization?.replace(/^Bearer /, '')
    const grant = bearer === undefined ? undefined : await f.resolve(bearer)
    const reply =
      path === '/oauth/token'
        ? await oauthRoute({
            sql: f.sql,
            method: 'POST',
            path,
            query: new URLSearchParams(),
            origin,
            siteOrigin: origin,
            body,
            now: f.now(),
            workloadEnabled: true,
            workloadFetch: f.fakeFetch,
          })
        : await agentFirstMcpRoute({
            method: req.method ?? 'POST',
            pathname: path,
            origin,
            headers: {},
            ...(grant === undefined ? {} : { grant }),
            body,
            tools: hostedMcpTools('monad-testnet'),
            call: async (tool, args, agentId) =>
              JSON.parse(
                await runAgent({
                  sql: f.sql,
                  stateId: SPONSOR_OBJECT_NAME,
                  bindings: { ...f.bindings, Board: { idFromName: () => ({ toString: () => SPONSOR_OBJECT_NAME }) } },
                  req: { tool, args, agentId, resource, env: executeEnv, ...(bearer === undefined ? {} : { bearer }) },
                }),
              ),
          })
    res.writeHead(reply?.status ?? 404, { 'content-type': 'application/json', ...reply?.headers })
    res.end(reply?.body === undefined ? undefined : JSON.stringify(reply.body))
  }
}

it('assertion POST → short-lived token → SDK initialize and hosted MCP tool call over loopback HTTP', async () => {
  const f = await workloadFixture()
  const handler = localHandler(f)
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      res.writeHead(500)
      res.end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || Schema.is(Schema.String)(address)) throw new Error('No local test port')
  const local = `http://127.0.0.1:${address.port}`
  const client = new Client({ name: 'workload-spike-test', version: '1.0.0' })
  try {
    const id = await f.add()
    // RFC 7523 §2.1 minimal exchange: installed providers only construct the client_credentials grant.
    const response = await fetch(`${local}/oauth/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: JWT_BEARER_GRANT,
        client_id: id,
        resource,
        assertion: await f.sign(),
        scope: 'sidequest:read',
      }),
    })
    expect(response.status).toBe(200)
    const token = Schema.decodeUnknownSync(Token)(await response.json())
    // Reuse the installed SDK provider's token storage and bearer transport; this fixture secret is never presented.
    const provider = new ClientCredentialsProvider({
      clientId: id,
      clientSecret: 'unused-local-fixture',
      expectedIssuer: origin,
    })
    provider.saveTokens({ ...token, token_type: 'Bearer' })
    const transport = new StreamableHTTPClientTransport(new URL(`${local}/b/team-board/mcp`), {
      authProvider: provider,
    })
    // SAFETY: SDK 1.32.1's transport implements Transport, but its sessionId getter includes undefined while
    // Transport declares an optional string. The SDK handles an undefined sessionId before initializing.
    await client.connect(transport as Transport)
    const result = await client.callTool({ name: 'list_approvals', arguments: {} })
    expect(result.structuredContent).toMatchObject({ ok: true, result: { approvals: [] } })
    await f.manage('workload-policy-change', { id, decision: 'disable' })
    const denied = await fetch(`${local}/b/team-board/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'list_approvals', arguments: {} },
      }),
    })
    expect(denied.status).toBe(401)
  } finally {
    await client.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    )
    f.db.close()
  }
})
