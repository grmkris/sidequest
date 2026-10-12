import { offerResponse } from './offers.ts'
import { catalogReply, registryProofReply, serverCardReply, type McpMetadataReply } from './mcp-metadata.ts'
import registryProof from './mcp-registry-proof.json' with { type: 'json' }
import { erc20Abi } from 'viem'
import * as Cloudflare from 'alchemy/Cloudflare'
import type { RuntimeContext } from 'alchemy/RuntimeContext'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import {
  BoardError,
  parseHostedAdmission,
  PUBLIC_BOARD_ID,
  SPONSOR_OBJECT_NAME,
  SessionDesk,
  type TenantConfig,
  type TenantToken,
  type RelayRequest,
  failureFromReply,
  isAllowedOrigin,
  publicTenant,
} from '@sidequest/board'
import { admissionDrainBinding, runtimeSecret } from './prod-config.ts'
import { type AsyncSql, agentsOfWallet, fromD1, indexStatus, listAgents, networkStats } from '@sidequest/indexer'
import * as sdk from '@sidequest/sdk'
import { stageProfile } from '../../../infra/stage.ts'
import type { Address, Hex } from 'viem'
import Board, { type BoardCall, type BoardReply } from './board.ts'
import { corsHeaders } from './cors.ts'
import { Database } from './database.ts'
import { dripOnce } from './drip.ts'
import { claimFaucet, faucetChain } from './faucet.ts'
import { Manifests } from './manifests.ts'
import { rpcUrlForNetwork } from './network.ts'
import {
  dripState,
  getBoard,
  jobsOfBoard,
  jobsWithBoards,
  jobWithBoard,
  listBoards,
  migrateRegistry,
  recordOffer,
  recentJobSteps,
  submittedDeliverable,
} from './registry.ts'
import { boardView, tenantArgs, tenantTools } from './tools-tenant.ts'
import { edgeCache, isPreviewPath, previewRoute, previewTarget } from './deliverable-preview.ts'
import DirectoryObject, { directoryObjectName } from './directory-object.ts'
import { directoryTools, migrateDirectory, runDirectoryTool } from './directory.ts'
import { servicesRoute } from './services.ts'
import { hostedCallFailure } from './hosted-admission.ts'
import { enforceHostedRate } from './admission-rate.ts'
import { configurePublicSite, handleTelegramWebhook, migrateTelegram } from './telegram.ts'
import { feedTools } from './feed.ts'
import { telegramTools } from './tools-telegram.ts'
import type { OAuthReply, OAuthGrant } from './oauth.ts'
import { agentFirstMcpRoute as mcpRoute } from './mcp-agent-setup.ts'
import { mcpLogLine } from './mcp-log.ts'
import { hostedMcpTools } from './mcp-registry.ts'
import { McpEvents } from './mcp-events.ts'
import { jsonResponse } from './json.ts'
import { agentRoute } from './routes/agents.ts'
import { approvalRoute } from './routes/approvals.ts'
import { managementRequest } from './agent-requests.ts'
import { isStakingDataPath, stakingDataRoute } from './routes/staking.ts'
import { agentDataBody, identityReads } from './routes/agent-data.ts'
import { workerFailure as failure } from './worker-failure.ts'
import { x402Demo } from './x402-demo.ts'
import { isProfilePath, profileRoute } from './routes/profiles.ts'
import { MAX_AVATAR_BYTES, type AvatarBucket } from './avatars.ts'
import { avatarRouteRequest } from './agent-profile-management.ts'
import { objectFor } from './commons/route.ts'

const STATUS: Record<string, number> = {
  unauthenticated: 401,
  forbidden: 403,
  'not-found': 404,
  invalid: 400,
  conflict: 409,
  'rate-limited': 429,
  unavailable: 503,
  chain: 502,
}

/** A secret from the Worker env; the deploy placeholder "unset" reads as empty (the feature is unavailable). */
const secret = (name: string) =>
  Config.Redacted(name).pipe(Effect.map((v) => (Redacted.value(v) === 'unset' ? '' : Redacted.value(v))))

const BOARD_ROUTE = /^\/b\/([a-z0-9-]{3,32})(\/.*)?$/
const now = () => Math.floor(Date.now() / 1000)
const BOARD_CACHE_SECONDS = 30

// Per-isolate caches: token symbols never change, a board's config rarely, and the schema is created once.
const tokenCache = new Map<string, TenantToken>()
const boardCache = new Map<string, { at: number; config: TenantConfig | undefined }>()
let migrated: Promise<void> | undefined

export async function activityRoute(
  sql: AsyncSql,
  deployment: sdk.Deployment,
  url: URL,
  boardId: string,
  cors: Record<string, string>,
): Promise<HttpServerResponse.HttpServerResponse> {
  try {
    const which = url.searchParams.get('board') ?? (boardId === PUBLIC_BOARD_ID ? null : boardId)
    const cursor = url.searchParams.get('cursor')
    const limit = url.searchParams.get('limit')
    const wallet = url.searchParams.get('wallet')
    const page = await recentJobSteps(sql, deployment, {
      ...(which === null ? {} : { boardId: which }),
      ...(cursor === null ? {} : { cursor }),
      ...(limit === null ? {} : { limit: Number(limit) }),
      ...(wallet === null ? {} : { wallet }),
    })
    return jsonResponse({ ok: true, ...page }, { headers: cors })
  } catch (error) {
    const reply =
      error instanceof BoardError
        ? { ok: false, code: error.code, message: error.message }
        : { ok: false, code: 'unavailable', message: 'the index is not built yet' }
    return jsonResponse(reply, { status: STATUS[reply.code] ?? 503, headers: cors })
  }
}

/**
 * The hosted board service (spec §5, ADR-0008): several boards behind one Worker. `/b/<slug>/api/<tool>` and
 * `/b/<slug>/mcp` address one board's Durable Object; without the prefix the routes are the `public` board's, exactly
 * as before. Sign-in (SIWE) lives in one D1 session store shared by every board, bound to the page's origin; the
 * registry tools, CORS for a board's allowed origins, the testnet MON drip and the attribution of offers to boards are
 * the Worker's. Manifests are written only by `create_task` / `pick_quote` for a signed-in creator.
 */
export default class Api extends Cloudflare.Worker<Api>()(
  'Api',
  {
    main: import.meta.url,
    ...(stageProfile() ? { name: stageProfile()!.resources.Api } : {}),
    compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
    // Logs already run at the platform default. Cloudflare.Telemetry enables the
    // trace channel below; this Alchemy release exposes only the supported logs/
    // traces metadata fields here.
    observability: { enabled: true },
    dev: { port: 8788 },
    // Values come from the deploying shell (.env.local); secrets are bound as secret_text, never plain text.
    env: {
      DIRECTORY_DATABASE: Database,
      NETWORK: stageProfile()?.network ?? process.env.SIDEQUEST_NETWORK ?? 'monad-testnet',
      PUBLIC_ORIGIN: stageProfile()?.origin ?? 'http://localhost:5173',
      RELAY_ADDRESS:
        stageProfile()?.relay ??
        sdk.deployment((process.env.SIDEQUEST_NETWORK ?? 'monad-testnet') as sdk.Network).relay,
      TELEGRAM_BOT_USERNAME: stageProfile()?.telegram.botUsername ?? '',
      DEPLOY_STAGE: process.env.SIDEQUEST_STAGE ?? 'local',
      MONAD_RPC_URL: Redacted.make(rpcUrlForNetwork() || 'unset'),
      SCREENING_BASE_URL: process.env.ARBITER_MODEL_BASE_URL || 'https://ai-gateway.vercel.sh/v1',
      SCREENING_MODEL: process.env.SCREENING_MODEL || 'anthropic/claude-haiku-4.5',
      AI_GATEWAY_API_KEY: Redacted.make(runtimeSecret('AI_GATEWAY_API_KEY') || 'unset'),
      ATTESTER_PRIVATE_KEY: Redacted.make(runtimeSecret('ATTESTER_PRIVATE_KEY') || 'unset'),
      RELAY_PRIVATE_KEY: Redacted.make(runtimeSecret('RELAY_PRIVATE_KEY') || 'unset'),
      GITHUB_APP_ID: process.env.GITHUB_APP_ID || '',
      GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID || '',
      GITHUB_APP_PRIVATE_KEY: Redacted.make(runtimeSecret('GITHUB_APP_PRIVATE_KEY') || 'unset'),
      PRIVY_APP_ID: process.env.PRIVY_APP_ID || '',
      PRIVY_SIGNER_ID: process.env.PRIVY_SIGNER_ID || '',
      PRIVY_POLICY_ID: process.env.PRIVY_POLICY_ID || '',
      PRIVY_APP_SECRET: Redacted.make(runtimeSecret('PRIVY_APP_SECRET') || 'unset'),
      PRIVY_SIGNER_KEY: Redacted.make(runtimeSecret('PRIVY_SIGNER_KEY') || 'unset'),
      TELEGRAM_BOT_TOKEN: Redacted.make(runtimeSecret('TELEGRAM_BOT_TOKEN') || 'unset'),
      TELEGRAM_WEBHOOK_SECRET: Redacted.make(runtimeSecret('TELEGRAM_WEBHOOK_SECRET') || 'unset'),
      // Retain existing binding names for guarded staging updates; these obsolete lists are ignored.
      PROD_APPROVED_WALLETS: '',
      PROD_APPROVED_BOARDS: '',
      PROD_APPROVED_ACTIONS: '',
      PROD_ADMISSION_DRAIN: admissionDrainBinding(process.env.PROD_ADMISSION_DRAIN),
      // ADR-0019, from the stage profile: '1' when hosted boards accept posts only from agents.
      REQUIRE_POSTER_AGENT: stageProfile()?.boards?.requirePosterAgent === true ? '1' : '0',
    },
  },
  Effect.gen(function* () {
    const boards = yield* Board
    const runtimeEnv = yield* Cloudflare.WorkerEnvironment
    const directory = yield* DirectoryObject
    const manifests = yield* Cloudflare.R2.ReadWriteBucket(Manifests)
    // Workers AI and Images, bound as env.AI and env.IMAGES: agents' generated avatars, drawn and resized to 256 px
    // (workers-ai-images.ts) in the management object.
    yield* Cloudflare.Workers.AI()
    yield* Cloudflare.Images.Images()
    // Explore's chain facts (read-only here; the indexer is the only writer of its tables) and the board registry.
    const facts = yield* Cloudflare.D1.QueryDatabase(Database)

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.originalUrl)
        const network = (yield* Config.String('NETWORK')) as sdk.Network
        sdk.setRelayOverride((yield* Config.String('RELAY_ADDRESS')) as Address)
        configurePublicSite(yield* Config.String('PUBLIC_ORIGIN'), yield* Config.String('TELEGRAM_BOT_USERNAME'))
        const stage = yield* Config.String('DEPLOY_STAGE')
        const telegramSecret = yield* secret('TELEGRAM_WEBHOOK_SECRET')
        const telegramToken = yield* secret('TELEGRAM_BOT_TOKEN')
        if (network === 'monad-mainnet' && stage !== 'prod')
          return HttpServerResponse.jsonUnsafe(
            { ok: false, code: 'unavailable', message: 'production stage mismatch' },
            { status: 503 },
          )
        const rpcUrl = yield* secret('MONAD_RPC_URL')
        const relayKey = yield* secret('RELAY_PRIVATE_KEY')
        if (url.pathname === '/x402/demo' && request.method === 'GET') {
          if (network !== 'monad-testnet') return HttpServerResponse.text('not found', { status: 404 })
          const reply = yield* Effect.promise(() =>
            x402Demo(url.href, request.headers['payment-signature'], { deployment: sdk.deployment(network) }),
          )
          return HttpServerResponse.jsonUnsafe(reply.body, { status: reply.status, headers: reply.headers })
        }
        const deployment = sdk.deployment(network)
        const chainId = deployment.chainId
        const raw = yield* facts.raw
        const sql: AsyncSql = fromD1(raw as never)

        if (url.pathname === '/telegram/webhook' && request.method === 'POST') {
          const supplied = request.headers['x-telegram-bot-api-secret-token'] ?? null
          if (telegramSecret === '' || supplied !== telegramSecret)
            return HttpServerResponse.jsonUnsafe({ ok: false }, { status: 401 })
          let body: unknown
          try {
            body = JSON.parse(yield* request.text)
          } catch {
            return HttpServerResponse.jsonUnsafe({ ok: false }, { status: 400 })
          }
          const result = yield* Effect.promise(async () => {
            await migrateTelegram(sql)
            return handleTelegramWebhook(sql, network, body, supplied, telegramSecret, now())
          })
          return HttpServerResponse.jsonUnsafe(result, { status: result.ok ? 200 : 401 })
        }

        // Which board: `/b/<slug>/...` or the public one.
        let path = url.pathname
        let boardId = PUBLIC_BOARD_ID
        const routed = BOARD_ROUTE.exec(path)
        if (routed !== null) {
          boardId = routed[1] as string
          path = routed[2] ?? '/'
        }

        // Discovery is public static metadata; it must not depend on OAuth, signing or token RPC reads.
        const isCard = path === '/mcp/server-card'
        const isCatalog = url.pathname === '/.well-known/ai-catalog.json'
        const isRegistryProof = url.pathname === '/.well-known/mcp-registry-auth'
        if (isCard || isCatalog || isRegistryProof) {
          if (request.method === 'OPTIONS')
            return HttpServerResponse.empty({
              status: 204,
              headers: {
                'access-control-allow-origin': '*',
                'access-control-allow-methods': 'GET, HEAD, OPTIONS',
                'access-control-allow-headers': 'Content-Type, If-None-Match',
              },
            })
          if (request.method !== 'GET' && request.method !== 'HEAD')
            return HttpServerResponse.text('method not allowed', {
              status: 405,
              headers: { allow: 'GET, HEAD, OPTIONS' },
            })
          if (isCard && boardId !== PUBLIC_BOARD_ID) {
            yield* Effect.promise(() => migrateRegistry(sql))
            const board = yield* Effect.promise(() => getBoard(sql, boardId))
            if (board === undefined)
              return HttpServerResponse.jsonUnsafe({ ok: false, code: 'not-found' }, { status: 404 })
          }
          const reply: McpMetadataReply = isCard
            ? serverCardReply(url.origin, routed === null ? '' : `/b/${boardId}`, request.headers)
            : isCatalog
              ? catalogReply(url.origin, request.headers)
              : registryProofReply(registryProof.proof)
          return request.method === 'HEAD' || reply.status === 304
            ? HttpServerResponse.empty({ status: reply.status, headers: reply.headers })
            : HttpServerResponse.text(reply.body, { status: reply.status, headers: reply.headers })
        }

        const reads = rpcUrl === '' ? undefined : sdk.context(network, 'main', rpcUrl).publicClient
        const tokenInfo = async (address: Address): Promise<TenantToken> => {
          const cached = tokenCache.get(address.toLowerCase())
          if (cached !== undefined) return cached
          if (reads === undefined) return { address, symbol: address.slice(0, 8), decimals: 18 }
          const [symbol, decimals] = await Promise.all([
            reads.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
            reads.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
          ])
          const t = { address, symbol, decimals }
          tokenCache.set(address.toLowerCase(), t)
          return t
        }
        const desk = new SessionDesk({
          sql,
          now,
          verify: async (input) => (reads === undefined ? false : reads.verifyMessage(input)),
        })
        migrated ??= (async () => {
          await migrateRegistry(sql)
          await migrateDirectory(sql)
          await desk.migrate()
          await migrateTelegram(sql)
        })()
        yield* Effect.promise(() => migrated as Promise<void>)
        yield* boards.getByName('__sidequest_fleet_v1__').management({ kind: 'retire' })
        yield* boards.getByName(SPONSOR_OBJECT_NAME).management({ kind: 'migrate' })

        const tenant = yield* Effect.promise(async (): Promise<TenantConfig | undefined> => {
          if (boardId === PUBLIC_BOARD_ID)
            return publicTenant(deployment, await Promise.all(deployment.rewardTokens.map(tokenInfo)))
          const cached = boardCache.get(boardId)
          if (cached !== undefined && cached.at + BOARD_CACHE_SECONDS > now()) return cached.config
          const config = (await getBoard(sql, boardId))?.config
          boardCache.set(boardId, { at: now(), config })
          return config
        })
        const origin = request.headers.origin
        const allowed = tenant === undefined ? false : isAllowedOrigin(tenant, origin, url.host)
        const cors = corsHeaders(origin, allowed)
        const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
          jsonResponse(body, { status, headers: { ...cors, ...headers } })

        if (request.method === 'OPTIONS') return HttpServerResponse.empty({ status: 204, headers: cors })
        if (tenant === undefined) return json({ ok: false, code: 'not-found', message: `no board "${boardId}"` }, 404)
        boardCache.set(tenant.id, { at: now(), config: tenant })

        // SIWE: the page's own domain when it is one the board allows, else the API host.
        const siweDomain = allowed && origin !== undefined ? new URL(origin).host : url.host
        const siweUri = allowed && origin !== undefined ? origin : url.origin
        const domainAllowed = (domain: string) =>
          domain === url.host ||
          tenant.allowedOrigins.some((o) => {
            if (o === 'http://localhost:*') return /^localhost(:\d+)?$/.test(domain)
            try {
              return new URL(o).host === domain
            } catch {
              return false
            }
          })

        const admission = parseHostedAdmission(yield* Config.String('PROD_ADMISSION_DRAIN'))
        const requirePosterAgent = (yield* Config.withDefault(Config.String('REQUIRE_POSTER_AGENT'), '0')) === '1'
        const env: BoardCall['env'] = {
          network,
          boardId: tenant.id,
          rpcUrl,
          domain: url.host,
          uri: url.origin,
          manifestBaseUrl: `${url.origin}/offers`,
          requirePosterAgent,
          screening: {
            baseUrl: yield* Config.String('SCREENING_BASE_URL'),
            model: yield* Config.String('SCREENING_MODEL'),
            apiKey: yield* secret('AI_GATEWAY_API_KEY'),
          },
          attesterKey: yield* secret('ATTESTER_PRIVATE_KEY'),
          relayKey,
          github: {
            appId: yield* Config.String('GITHUB_APP_ID'),
            installationId: yield* Config.String('GITHUB_APP_INSTALLATION_ID'),
            privateKeyPem: yield* secret('GITHUB_APP_PRIVATE_KEY'),
          },
        }
        const relaySend = async (relayRequest: RelayRequest): Promise<Hex> => {
          const reply = JSON.parse(
            await Effect.runPromise(boards.getByName(SPONSOR_OBJECT_NAME).relay({ env, request: relayRequest })),
          ) as BoardReply
          if (!reply.ok) throw failureFromReply(reply)
          return reply.result as Hex
        }
        const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '') || undefined
        const ip = request.headers['cf-connecting-ip']
        const directoryCall = (tool: string, args: Record<string, unknown>, mcpSession?: string, caller?: string) =>
          runDirectoryTool(
            {
              sql,
              network,
              rpcUrl,
              audience: url.origin,
              call: async (id, req) =>
                JSON.parse(
                  await yieldlessDirectoryCall(id, {
                    ...req,
                    admission: { boardId: tenant.id, bearer, mcpSession, caller, ip },
                  }),
                ),
              activity: async (agentIds) =>
                JSON.parse(
                  await Effect.runPromise(boards.getByName(SPONSOR_OBJECT_NAME).managedActivity({ agentIds })),
                ),
            },
            tool,
            args,
          )
        const yieldlessDirectoryCall = async (id: string, req: import('./directory-object.ts').DirectoryCall) =>
          Effect.runPromise(
            directory.getByName(directoryObjectName(chainId, deployment.identity, url.origin, id)).call(req),
          )

        /**
         * Calls one tool: sign-in and registry tools in the Worker, everything else in the board's Durable Object with
         * the shared session's wallet as caller. A new offer's manifest goes to R2 and its board to the registry.
         */
        const call = (tool: string, args: Record<string, unknown>, mcpSession?: string, oauthCaller?: string) =>
          Effect.gen(function* () {
            const pre = yield* Effect.promise(
              async (): Promise<
                { reply: BoardReply } | { forward: { args: Record<string, unknown>; caller: string | undefined } }
              > => {
                try {
                  const session =
                    oauthCaller === undefined
                      ? await desk.resolve({ bearer, mcpSession })
                      : { address: oauthCaller as Address, origin: url.origin, boardId: tenant.id }
                  // Board tools are limited inside the DO, so direct RPC cannot bypass the counters.
                  // Worker-local tools, including sign-in, use exactly the same reserved object.
                  if (
                    tool === 'auth_challenge' ||
                    tool === 'auth_login' ||
                    tool === 'prepare_agent_profile' ||
                    tool === 'testnet_faucet' ||
                    Object.hasOwn(tenantTools, tool) ||
                    Object.hasOwn(telegramTools, tool)
                  ) {
                    const rate = await enforceHostedRate(runtimeEnv as Record<string, unknown>, {
                      network,
                      tool,
                      boardId: tenant.id,
                      bearer,
                      mcpSession,
                      caller: session?.address,
                      ip,
                    })
                    if (!rate.ok) return { reply: rate }
                  }
                  if (tool === 'auth_challenge') {
                    return {
                      reply: {
                        ok: true,
                        result: await desk.challenge({
                          address: String(args.address ?? ''),
                          domain: siweDomain,
                          uri: siweUri,
                          chainId,
                          boardId: tenant.id,
                        }),
                      },
                    }
                  }
                  if (tool === 'auth_login') {
                    const r = await desk.login({
                      message: String(args.message ?? ''),
                      signature: String(args.signature ?? ''),
                      boardId: tenant.id,
                      domainAllowed,
                    })
                    if (mcpSession !== undefined) await desk.bindMcp(mcpSession, r.session)
                    const drip =
                      network === 'monad-testnet' && tenant.drip
                        ? await dripOnce(
                            { sql, network, rpcUrl, relayKey, now, relaySend },
                            { boardId: tenant.id, address: r.address },
                          )
                        : undefined
                    return {
                      reply: {
                        ok: true,
                        result: { ...r, boardId: tenant.id, ...(drip === undefined ? {} : { drip }) },
                      },
                    }
                  }
                  if (tool === 'testnet_faucet') {
                    if (session === undefined)
                      return { reply: { ok: false, code: 'unauthenticated', message: 'Sign in to claim test tokens' } }
                    return {
                      reply: {
                        ok: true,
                        result: await claimFaucet(
                          { sql, network, now, chain: faucetChain({ sql, network, rpcUrl, relayKey, now, relaySend }) },
                          { address: session.address },
                        ),
                      },
                    }
                  }
                  if (tool === 'whoami' && session !== undefined) {
                    const drip = await dripState(sql, tenant.id, session.address)
                    return {
                      reply: {
                        ok: true,
                        result: {
                          address: session.address,
                          boardId: tenant.id,
                          origin: session.origin,
                          dripped: drip?.status ?? null,
                        },
                      },
                    }
                  }
                  // Worker-local discovery and feed reads do not enter hosted board admission.
                  if (tool === 'find_services') return { reply: { ok: true, result: await directoryCall(tool, args) } }
                  if (tool === 'inbox')
                    return {
                      reply: {
                        ok: true,
                        result: await feedTools.inbox.run({ sql, network, now: now() }, session?.address, args),
                      },
                    }
                  const denied = hostedCallFailure(admission, network, tenant.id, tool, args, session?.address, stage)
                  if (denied !== undefined) return { reply: { ok: false, code: 'forbidden', message: denied } }
                  if (Object.hasOwn(directoryTools, tool))
                    return {
                      reply: { ok: true, result: await directoryCall(tool, args, mcpSession, session?.address) },
                    }
                  const telegram = telegramTools[tool]
                  if (telegram !== undefined)
                    return {
                      reply: {
                        ok: true,
                        result: await telegram.run(
                          {
                            sql,
                            network,
                            now,
                            configured: telegramSecret !== '' && telegramToken !== '',
                            verify: async (input) => (reads === undefined ? false : reads.verifyMessage(input)),
                          },
                          session?.address,
                          args,
                        ),
                      },
                    }
                  const registry = tenantTools[tool]
                  if (registry !== undefined) {
                    return {
                      reply: {
                        ok: true,
                        result: await registry.run(
                          { sql, deployment, resolveToken: tokenInfo, now },
                          session?.address,
                          tenant,
                          args,
                        ),
                      },
                    }
                  }
                  return { forward: { args: tenantArgs(tenant, tool, args), caller: session?.address } }
                } catch (e) {
                  return { reply: failure(e) }
                }
              },
            )
            if ('reply' in pre) return pre.reply
            const reply = JSON.parse(
              yield* boards
                .getByName(objectFor(tool, tenant.id))
                .call({ tool, args: pre.forward.args, bearer, mcpSession, caller: pre.forward.caller, ip, env }),
            ) as BoardReply
            if (reply.ok && (tool === 'create_task' || tool === 'pick_quote')) {
              const r = reply.result as { taskId: string; termsHash: string; manifest?: string }
              if (r.manifest !== undefined) {
                yield* manifests.put(`offers/${r.termsHash}.json`, r.manifest)
                delete r.manifest
              }
              yield* Effect.promise(() =>
                recordOffer(sql, { boardId: tenant.id, termsHash: r.termsHash, taskId: r.taskId, now: now() }),
              )
            }
            // Selection and new-request notices are sent by the Board DO (feed-board.ts), so managed calls get them too.
            return reply
          })

        // An avatar upload is raw image bytes: read as bytes, at most 1 MiB by its length, before any text parsing.
        const avatarUpload =
          request.method === 'POST' &&
          /^\/api\/agents\/[A-Za-z0-9_-]{1,128}\/avatar$/.test(path) &&
          (request.headers['content-type'] ?? '').toLowerCase().startsWith('image/')
        if (avatarUpload && !(Number(request.headers['content-length']) <= MAX_AVATAR_BYTES))
          return json({ ok: false, code: 'invalid', message: 'An avatar upload is at most 1 MiB' }, 413)
        const avatarBytes = avatarUpload ? new Uint8Array(yield* request.arrayBuffer) : undefined
        // Hosted MCP OAuth is deliberately separate from the legacy website SIWE session.
        const rawBody = request.method === 'POST' && !avatarUpload ? yield* request.text : ''
        const oauthBody: Record<string, unknown> =
          rawBody === ''
            ? {}
            : (() => {
                if (request.headers['content-type']?.includes('application/x-www-form-urlencoded'))
                  return Object.fromEntries(new URLSearchParams(rawBody))
                try {
                  return JSON.parse(rawBody) as Record<string, unknown>
                } catch {
                  return {}
                }
              })()
        const lifecycleRequest =
          avatarBytes === undefined
            ? (agentRoute(request.method, path, oauthBody) ?? approvalRoute(request.method, path, oauthBody))
            : avatarRouteRequest({
                method: request.method,
                path,
                contentType: request.headers['content-type'],
                bytes: avatarBytes,
                ...(request.headers['idempotency-key'] === undefined
                  ? {}
                  : { operationKey: request.headers['idempotency-key'] }),
              })
        if (lifecycleRequest !== undefined) {
          if (request.method === 'POST' && (origin === undefined || !allowed))
            return json({ ok: false, code: 'forbidden', message: 'Agent decisions require the website origin' }, 403)
          const reply = JSON.parse(
            yield* boards
              .getByName(SPONSOR_OBJECT_NAME)
              .agentManage(managementRequest(env, lifecycleRequest, bearer, request.headers)),
          ) as BoardReply
          return json(reply, reply.ok ? 200 : (STATUS[reply.code] ?? 503), { 'cache-control': 'no-store' })
        }
        if (path.startsWith('/oauth/') || path.startsWith('/.well-known/oauth-')) {
          if (origin !== undefined && origin !== url.origin)
            return json(
              { error: 'invalid_request', error_description: 'OAuth requests require the website origin' },
              403,
            )
          const reply = JSON.parse(
            yield* boards.getByName(SPONSOR_OBJECT_NAME).oauth({
              env,
              method: request.method,
              path: url.pathname,
              query: url.searchParams.toString(),
              body: oauthBody,
              origin: url.origin,
              ...(bearer === undefined ? {} : { bearer }),
            }),
          ) as OAuthReply | null
          if (reply !== null)
            return reply.redirect === undefined
              ? json(reply.body, reply.status, reply.headers)
              : HttpServerResponse.empty({
                  status: reply.status,
                  headers: { ...reply.headers, location: reply.redirect },
                })
        }
        if (path === '/mcp') {
          const runMcp = Effect.runPromiseWith(yield* Effect.context<RuntimeContext>())
          const resource = `${url.origin}${url.pathname}`
          const started = Date.now()
          // One resolution per MCP request, which also records the connection's use.
          const grant = JSON.parse(
            yield* boards
              .getByName(SPONSOR_OBJECT_NAME)
              .oauthResolve({ resource, activity: true, ...(bearer === undefined ? {} : { bearer }) }),
          ) as OAuthGrant | null
          const reply = yield* Effect.promise(() =>
            mcpRoute({
              method: request.method,
              pathname: url.pathname,
              body: oauthBody,
              origin: url.origin,
              headers: request.headers,
              events: new McpEvents(sql, network),
              ...(grant === null ? {} : { grant }),
              tools: hostedMcpTools(network),
              call: async (tool, args, agentId) => {
                if (
                  [
                    'list_boards',
                    'get_board',
                    'list_directory',
                    'get_directory_agent',
                    'find_services',
                    'inbox',
                  ].includes(tool) ||
                  (tool === 'whoami' && grant!.setup !== true)
                )
                  return runMcp(call(tool, args, undefined, grant!.address))
                const result = JSON.parse(
                  await Effect.runPromise(
                    boards.getByName(SPONSOR_OBJECT_NAME).agentExecute({
                      env,
                      tool,
                      args: tenantArgs(tenant, tool, args),
                      agentId,
                      resource,
                      ...(ip === undefined ? {} : { ip }),
                      ...(bearer === undefined ? {} : { bearer }),
                    }),
                  ),
                ) as BoardReply
                return result
              },
            }),
          )
          console.log(JSON.stringify(mcpLogLine({ request: oauthBody, reply, grant, ms: Date.now() - started })))
          // ADR-0021: a 2026 listen is answered by the management object's stream for this connection.
          if (reply.listen !== undefined) {
            const stream = yield* boards
              .getByName(SPONSOR_OBJECT_NAME)
              .mcpListen({ resource, listen: reply.listen, ...(bearer === undefined ? {} : { bearer }) })
            return HttpServerResponse.setHeaders(HttpServerResponse.fromWeb(stream), cors)
          }
          return reply.status === 204 || reply.status === 202
            ? HttpServerResponse.empty({ status: reply.status, headers: { ...cors, ...reply.headers } })
            : json(reply.body, reply.status, reply.headers)
        }
        if (request.method === 'GET' && isProfilePath(path)) {
          const publicOrigin = yield* Config.String('PUBLIC_ORIGIN')
          return yield* Effect.promise(() =>
            profileRoute(path, publicOrigin, {
              // SAFETY: Manifests is this Worker's R2 binding (manifests.ts); its raw form serves the stored bytes.
              bucket: (runtimeEnv as Record<string, unknown>).Manifests as AvatarBucket | undefined,
              read: (req) => Effect.runPromise(boards.getByName(SPONSOR_OBJECT_NAME).managedProfiles(req)),
            }),
          )
        }
        if (path.startsWith('/data/') && request.method === 'GET') {
          if (isStakingDataPath(path)) {
            const dataUrl = new URL(url)
            dataUrl.pathname = path
            return yield* Effect.promise(() =>
              stakingDataRoute(
                sql,
                rpcUrl === '' ? undefined : sdk.context(network, 'main', rpcUrl),
                dataUrl,
                now(),
                cors,
              ),
            )
          }
          if (path === '/data/directory' || /^\/data\/directory\/\d{1,78}$/.test(path)) {
            const reply = yield* Effect.promise(async () => {
              try {
                const args =
                  path === '/data/directory'
                    ? {
                        ...(url.searchParams.has('after') ? { after: url.searchParams.get('after') } : {}),
                        ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
                      }
                    : { agentId: path.slice('/data/directory/'.length) }
                return {
                  ok: true as const,
                  result: await directoryCall(
                    path === '/data/directory' ? 'list_directory' : 'get_directory_agent',
                    args,
                  ),
                }
              } catch (error) {
                return failure(error)
              }
            })
            return json(
              reply.ok ? { ok: true, ...(reply.result as Record<string, unknown>) } : reply,
              reply.ok ? 200 : (STATUS[reply.code] ?? 503),
              { 'cache-control': 'no-store' },
            )
          }
          if (path === '/data/services')
            return yield* Effect.promise(() =>
              servicesRoute(
                {
                  sql,
                  network,
                  audience: url.origin,
                  activity: async (agentIds) =>
                    JSON.parse(
                      await Effect.runPromise(boards.getByName(SPONSOR_OBJECT_NAME).managedActivity({ agentIds })),
                    ),
                },
                url,
                now(),
                cors,
              ),
            )
          if (path === '/data/activity')
            return yield* Effect.promise(() => activityRoute(sql, deployment, url, boardId, cors))
          if (isPreviewPath(path)) {
            const target = previewTarget(path)
            if (target === null)
              return json(
                {
                  ok: false,
                  code: 'invalid',
                  message: 'expected /data/deliverables/<taskId>/<deliverableHash>/preview',
                },
                400,
              )
            const run = Effect.runPromiseWith(yield* Effect.context<RuntimeContext>())
            const site = new URL(yield* Config.String('PUBLIC_ORIGIN')).host
            const prefix = routed === null ? '' : `/b/${boardId}`
            return yield* Effect.promise(() =>
              previewRoute(
                { ...target, key: `${url.origin}${prefix}${path}?v=1`, cors },
                {
                  submitted: (taskId, hash) =>
                    submittedDeliverable(sql, deployment, { boardId: tenant.id, taskId, hash }),
                  task: (taskId) => run(call('get_task', { taskId })),
                  fetch: (input, init) => fetch(input, init),
                  cache: edgeCache(),
                  selfHosts: [url.host, site],
                },
              ),
            )
          }
          const body = yield* Effect.promise(async () => {
            try {
              if (path === '/data/boards') {
                const stored = await listBoards(sql)
                const pub = publicTenant(deployment, await Promise.all(deployment.rewardTokens.map(tokenInfo)))
                return { ok: true, boards: [pub, ...stored].map((config) => boardView(config, deployment.relay)) }
              }
              if (path === '/data/jobs') {
                const which = url.searchParams.get('board') ?? (boardId === PUBLIC_BOARD_ID ? null : boardId)
                // Newest first, a page at a time: `cursor` is the last job id of the page before.
                const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 500)
                const cursor = url.searchParams.get('cursor') ?? undefined
                if (cursor !== undefined && !/^\d{1,18}$/.test(cursor))
                  return { ok: false, code: 'invalid', message: 'cursor must be a job id' }
                const jobs =
                  which === null
                    ? await jobsWithBoards(sql, deployment, limit, cursor)
                    : await jobsOfBoard(sql, deployment, which, limit, cursor)
                const nextCursor = jobs.length === limit ? (jobs.at(-1)?.job_id ?? null) : null
                return { ok: true, index: await indexStatus(sql, chainId), board: which, jobs, nextCursor }
              }
              const m = /^\/data\/jobs\/(\d+)$/.exec(path)
              if (m !== null) return await jobWithBoard(sql, deployment, m[1] as string, now())
              // Agents and headline numbers: chain facts across every board (an agent's record is not a board's).
              if (path === '/data/stats') return { ok: true, ...(await networkStats(sql, chainId)) }
              if (path === '/data/agents') {
                const wallet = url.searchParams.get('wallet')
                if (wallet !== null) {
                  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet))
                    return { ok: false, code: 'invalid', message: 'wallet must be a 0x address' }
                  return { ok: true, wallet, agents: await agentsOfWallet(sql, chainId, wallet) }
                }
                const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 500)
                return { ok: true, agents: await listAgents(sql, chainId, limit) }
              }
              const agent = /^\/data\/agents\/(\d{1,78})$/.exec(path)
              if (agent !== null)
                return await agentDataBody(
                  sql,
                  chainId,
                  agent[1] as string,
                  reads === undefined ? undefined : identityReads(reads, deployment.identity),
                )
              return { ok: false, code: 'not-found', message: 'no such data route' }
            } catch (error) {
              if (error instanceof BoardError) return { ok: false, code: error.code, message: error.message }
              return { ok: false, code: 'unavailable', message: 'the index is not built yet' }
            }
          })
          return json(body, body.ok ? 200 : 'code' in body ? (STATUS[body.code] ?? 503) : 404)
        }

        if (path === '/health') {
          return json({ ok: true, runtime: navigator.userAgent, network, board: tenant.id })
        }

        if (path.startsWith('/offers/') && request.method === 'GET') {
          const key = path.slice(1)
          if (!/^offers\/0x[0-9a-f]{64}\.json$/.test(key)) return offerResponse(null)
          const object = yield* manifests.get(key)
          return offerResponse(object === null ? null : yield* object.text())
        }

        if (path.startsWith('/api/') && request.method === 'POST') {
          const tool = path.slice('/api/'.length)
          const args = oauthBody
          const reply = yield* call(tool, args)
          return json(
            reply,
            reply.ok ? 200 : (STATUS[reply.code] ?? 500),
            !reply.ok && reply.retryAfter !== undefined ? { 'retry-after': String(reply.retryAfter) } : {},
          )
        }

        return HttpServerResponse.text('not found', { status: 404 })
      }).pipe(Effect.orDie),
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.R2.ReadWriteBucketBinding,
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.Workers.AIBinding,
        Cloudflare.Images.ImagesBinding,
        Cloudflare.Telemetry({ headSamplingRate: 1, persist: true }),
      ),
    ),
  ),
) {}
