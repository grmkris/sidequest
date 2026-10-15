import { AgentStore, fromNodeSqlite, SPONSOR_OBJECT_NAME } from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import { Schema } from 'effect'
import { afterEach, expect, it, vi } from 'vitest'
import { runAgent, type AgentExecuteRequest } from '../src/agent-runtime.ts'
import { mcpRoute } from '../src/mcp.ts'
import { agentTools } from '../src/tools-agents.ts'
import { oauthRoute, resolveOAuth } from '../src/oauth.ts'
import { pkceChallenge } from '../src/oauth-validation.ts'
import { runDirectoryTool } from '../src/directory.ts'
import { directoryFixture, listingService } from './directory-fixture.ts'

afterEach(() => vi.unstubAllGlobals())

async function hostedConnection(context: Awaited<ReturnType<typeof directoryFixture>>) {
  const sql = fromNodeSqlite(context.db)
  const agents = new AgentStore(sql, context.now)
  const owner = context.key.address
  agents.create({
    id: 'lister',
    operator: owner,
    privyUserId: 'did:privy:lister',
    name: 'Lister',
    registry: context.config.identity,
    chainId: context.config.chainId,
  })
  agents.bindWallet('lister', 'wallet-lister', context.key.address)
  agents.bindRegistry('lister', '2013')
  for (const state of ['upgraded', 'grants-live', 'registered', 'active'] as const) agents.advance('lister', state)
  const resource = `${context.audience}/mcp`
  const route = (path: string, body: Record<string, unknown> = {}, query = new URLSearchParams(), method = 'POST') =>
    oauthRoute({
      sql,
      path,
      body,
      query,
      method,
      origin: context.audience,
      siteOrigin: context.audience,
      now: context.now(),
      owner,
    })
  const clientId = Schema.decodeUnknownSync(Schema.Struct({ client_id: Schema.String }))(
    (await route('/oauth/register', { redirect_uris: ['http://127.0.0.1:3210/callback'] }))?.body,
  ).client_id
  const authorize = await route(
    '/oauth/authorize',
    {},
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:3210/callback',
      response_type: 'code',
      scope: 'sidequest:read sidequest:work',
      resource,
      code_challenge_method: 'S256',
      code_challenge: await pkceChallenge('a'.repeat(43)),
    }),
    'GET',
  )
  const requestId = new URL(authorize!.redirect!).searchParams.get('oauth_request')!
  const approved = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Struct({ redirectUrl: Schema.String }) }))(
    (await route(`/oauth/requests/${requestId}/approve`, { agentIds: ['lister'] }))?.body,
  )
  const tokens = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }))(
    (
      await route('/oauth/token', {
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: 'http://127.0.0.1:3210/callback',
        resource,
        code: new URL(approved.result.redirectUrl).searchParams.get('code')!,
        code_verifier: 'a'.repeat(43),
      })
    )?.body,
  )
  const grant = await resolveOAuth(sql, tokens.access_token, resource, context.now())
  if (grant === undefined) throw new Error('fixture OAuth grant missing')
  return { sql, resource, grant, token: tokens.access_token }
}

it.each([false, true])(
  'hosted MCP lists and withdraws on mainnet bindings (modern=%s)',
  async (modern) => {
    const context = await directoryFixture()
    try {
      const connection = await hostedConnection(context)
      const authorization = await sdk.generateAuthorizationKey()
      const signed: string[] = []
      vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        expect(url).toBe('https://api.privy.io/v1/wallets/wallet-lister/rpc')
        // SAFETY: PrivyServer's typed-data request is the production wire format, checked against the local signer.
        const body = JSON.parse(Schema.decodeUnknownSync(Schema.String)(init.body)) as {
          params: { typed_data: { primary_type: string; domain: object; types: object; message: object } }
        }
        const typed = body.params.typed_data
        signed.push(typed.primary_type)
        // SAFETY: the real AgentSigning scope validated this typed-data JSON before PrivyServer sent it.
        const typedData = { ...typed, primaryType: typed.primary_type } as Parameters<
          typeof context.key.signTypedData
        >[0]
        return Response.json({ data: { signature: await context.key.signTypedData(typedData) } })
      })
      const bindings = {
        ...context.bindings,
        PRIVY_APP_ID: 'fixture',
        PRIVY_APP_SECRET: 'fixture',
        PRIVY_SIGNER_KEY: authorization.privateKey,
        Board: {
          idFromName: (name: string) => ({ toString: () => name }),
          get: () => ({
            call: async () => {
              throw new Error('listing must not call a tenant')
            },
            verifyAgentSigning: async () => {
              throw new Error('listing must not verify through a tenant')
            },
          }),
        },
      }
      const env: AgentExecuteRequest['env'] = {
        network: 'monad-mainnet',
        boardId: 'public',
        rpcUrl: 'http://127.0.0.1:1',
        domain: 'sidequest.test',
        uri: context.audience,
        manifestBaseUrl: '',
        screening: { baseUrl: '', apiKey: '', model: '' },
        attesterKey: '',
        relayKey: '',
        github: { appId: '', privateKeyPem: '', installationId: '' },
      }
      const call = (tool: string, args: Record<string, unknown>) =>
        mcpRoute({
          method: 'POST',
          pathname: '/mcp',
          headers: {},
          origin: context.audience,
          grant: connection.grant,
          tools: agentTools,
          body: {
            id: 1,
            method: 'tools/call',
            params: {
              name: tool,
              arguments: args,
              ...(modern ? { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } : {}),
            },
          },
          call: async (name, input, agentId) =>
            JSON.parse(
              await runAgent({
                sql: connection.sql,
                stateId: SPONSOR_OBJECT_NAME,
                bindings,
                req: { env, tool: name, args: input, agentId, resource: connection.resource, bearer: connection.token },
              }),
            ),
        })
      const advertised = await call('advertise_service', { operationKey: 'advertise-1', service: listingService })
      expect(advertised.body).toMatchObject({
        result: {
          structuredContent: { ok: true, result: { listing: { enrolled: true, ads: [{ serviceId: 'research' }] } } },
        },
      })
      expect(signed).toEqual(['Enrollment', 'ServiceAd'])
      expect(context.calls.every((request) => !('admission' in request))).toBe(true)
      expect(await runDirectoryTool(context.deps, 'find_services', {})).toMatchObject({
        services: [{ agentId: '2013', serviceId: 'research' }],
      })
      await call('advertise_service', { operationKey: 'advertise-1', service: listingService })
      expect(signed).toEqual(['Enrollment', 'ServiceAd'])
      expect(
        (await call('withdraw_service', { operationKey: 'withdraw-1', serviceId: 'research' })).body,
      ).toMatchObject({ result: { structuredContent: { ok: true, result: { listing: { ads: [] } } } } })
      expect(await runDirectoryTool(context.deps, 'find_services', {})).toMatchObject({ services: [] })
    } finally {
      context.close()
    }
  },
  30_000,
)
