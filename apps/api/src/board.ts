import { traceRpc } from './rpc-observability.ts'
import { observedQueue } from './observability.ts'
import {
  ADMISSION_OBJECT_NAME,
  SPONSOR_OBJECT_NAME,
  AdmissionRateLimits,
  admissionFailure,
  Board as BoardService,
  BoardError,
  fromDurableObjectSql,
  parseHostedAdmission,
  SessionDesk,
  type RelayRequest,
  migrateAgentSchema,
  retireFleetSchema,
  AgentStore,
  agentFailureReply,
  errorDiagnostics,
  failureFromReply,
  type AgentRetry,
  hostedCreatorFacts,
  type HostedCreatorFacts,
  type HostedCreatorQuery,
  readOnlyHostedTools,
} from '@sidequest/board'
import { fromD1 } from '@sidequest/indexer'
import * as sdk from '@sidequest/sdk'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import { type Hex, getAddress, decodeFunctionData, isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { type ToolContext, toJson, tools } from './tools.ts'
import {
  admissionIdentity,
  admissionIpHash,
  enforceHostedRate,
  needsWriteRate,
  type AdmissionCall,
  type AdmissionNamespace,
  type AdmissionReply,
} from './admission-rate.ts'
import { collectSnapshot } from './collect-index.ts'
import { stakingSnapshot } from './staking-index.ts'
import { oauthRoute, resolveOAuth } from './oauth.ts'
import { terminateGrantSubscriptions } from './webhooks.ts'
import type { OAuthGrant } from './oauth.ts'
import { OPERATOR_CONTINUATIONS, requiredToolScope, toolAnnotations, toolDecision } from './mcp-policy.ts'
import { resourceBoard } from './oauth-validation.ts'
import { runAgent, type AgentExecuteRequest } from './agent-runtime.ts'
import { agentManagement } from './agent-management.ts'
import { connectionAccess, touchConnection } from './agent-access.ts'
import { McpListeners, type ListenRequest } from './mcp-listen.ts'
import {
  McpEventStreams,
  eventStreamAccess,
  eventStreamStart,
  readEventStreamPage,
  type EventStreamRequest,
} from './mcp-event-stream.ts'
import { eventArguments, eventCursor, eventMaxAge } from '@sidequest/indexer/mcp-events'
import { profileReader } from './profiles.ts'
import { recordBoardEvent } from './feed-board.ts'
import { configurePublicSite } from './telegram.ts'
import { operatorRequest, type AgentManagementRequest } from './agent-requests.ts'
import { commonsToolNames } from '@sidequest/commons'
import { commonsHostFactory } from './commons/host.ts'
import { commonsRpcs, disputeThreadReader } from './commons/rpc.ts'
import { objectFor } from './commons/route.ts'

/** What the Worker passes on every call: the tool, its arguments, the caller's credentials and the runtime env. */
export interface BoardCall {
  readonly tool: string
  readonly args: Record<string, unknown>
  readonly bearer?: string | undefined
  readonly mcpSession?: string | undefined
  /** The signed-in wallet, when the Worker already resolved it from the shared session store (ADR-0008). */
  readonly caller?: string | undefined
  readonly ip?: string | undefined
  readonly agentAuth?: { readonly agentId: string; readonly resource: string; readonly operator?: boolean }
  readonly env: {
    readonly network: sdk.Network
    readonly boardId: string
    readonly rpcUrl: string
    readonly domain: string
    readonly uri: string
    readonly manifestBaseUrl: string
    /** ADR-0019: whether this stage's boards accept posts only from agents. */
    readonly requirePosterAgent?: boolean
    /** Jev's model endpoint; an empty key means "unscreened". */
    readonly screening: { readonly baseUrl: string; readonly apiKey: string; readonly model: string }
    /** Attester and relay keys and the GitHub App; empty means evidence is unavailable. */
    readonly attesterKey: string
    readonly relayKey: string
    readonly github: { readonly appId: string; readonly privateKeyPem: string; readonly installationId: string }
  }
}

const key32 = (k: string) => /^0x[0-9a-fA-F]{64}$/.test(k)

export type BoardReply =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false
      readonly code: string
      readonly message: string
      readonly retryAfter?: number
      readonly reason?: string
      readonly retry?: AgentRetry
      readonly errorId?: string
    }

/**
 * One Durable Object per hosted board (spec §5). It owns the board's SQLite (tasks, applications, selections,
 * sessions, operation records) and runs every tool single-threaded, so two requests never interleave inside one
 * board. Chain reads and verifications go to the RPC the Worker passes in.
 */
export default class Board extends Cloudflare.DurableObject<Board>()(
  'Board',
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState
    const runtimeEnv = yield* Cloudflare.WorkerEnvironment
    const startup = runtimeEnv as Record<string, unknown>
    if (typeof startup.RELAY_ADDRESS === 'string') sdk.setRelayOverride(startup.RELAY_ADDRESS as Hex)
    if (typeof startup.PUBLIC_ORIGIN === 'string')
      configurePublicSite(startup.PUBLIC_ORIGIN, String(startup.TELEGRAM_BOT_USERNAME ?? ''))
    let service: { key: string; board: BoardService } | undefined
    let limits: AdmissionRateLimits | undefined
    // Serialize across awaits and service/config replacement, including callers from different tenants.
    const callQueue = observedQueue('call')
    // Management execution may await a tenant object. Keep that queue separate from relay sends, which can be
    // requested by the tenant while the management object is waiting.
    const managementQueue = observedQueue('management')
    // Relay sends retain one nonce-serialized queue in the reserved object.
    const relayQueue = observedQueue('relay')
    // SAFETY: Alchemy provides this object's SQL state and the API Worker's declared binding record.
    const commonsHost = commonsHostFactory({ state, bindings: runtimeEnv as never })

    const boardFor = (env: BoardCall['env']): BoardService => {
      const key = JSON.stringify(env)
      if (service?.key === key) return service.board
      const contexts: Partial<Record<sdk.StackName, sdk.Ctx>> = {}
      for (const name of ['main'] as const) {
        if (sdk.deployment(env.network).stacks[name] !== undefined)
          contexts[name] = sdk.context(env.network, name, env.rpcUrl, { batch: true, trace: traceRpc })
      }
      const board = new BoardService(
        fromDurableObjectSql(state.storage.sql.raw, (write) => state.raw.storage.transactionSync(write)),
        {
          network: env.network,
          contexts,
          domain: env.domain,
          uri: env.uri,
          manifestBaseUrl: env.manifestBaseUrl,
          requirePosterAgent: env.requirePosterAgent === true,
          // SAFETY: Alchemy's WorkerEnvironment is the binding record of this Worker.
          disputeThread: disputeThreadReader(runtimeEnv as Record<string, unknown>, env),
          collectSnapshot: (wallet) =>
            collectSnapshot(
              fromD1((runtimeEnv as Record<string, unknown>).Database as never),
              contexts.main!,
              wallet,
              Math.floor(Date.now() / 1000),
            ),
          delegationSnapshot: (filters) =>
            stakingSnapshot(
              fromD1((runtimeEnv as Record<string, unknown>).Database as never),
              contexts.main!,
              filters,
              Math.floor(Date.now() / 1000),
            ),
          ...(env.screening.apiKey === '' ? {} : { screening: env.screening }),
          ...(key32(env.relayKey)
            ? { relay: { account: privateKeyToAccount(env.relayKey as `0x${string}`), rpcUrl: env.rpcUrl } }
            : {}),
          relaySend: async (request) => {
            const namespace = (runtimeEnv as Record<string, unknown>).Board as {
              idFromName(name: string): { toString(): string }
              get(id: unknown): { relay(req: { env: BoardCall['env']; request: RelayRequest }): Promise<string> }
            }
            const id = namespace.idFromName(SPONSOR_OBJECT_NAME)
            if (id.toString() === state.id.toString()) return board.relayTransaction(request)
            const reply = JSON.parse(await namespace.get(id).relay({ env, request })) as BoardReply
            if (!reply.ok) throw failureFromReply(reply)
            return reply.result as Hex
          },
          // Hosted agents live in the reserved object. Its RPC below is not queued, so a hosted agent's own list read
          // (already inside that object's management queue) cannot deadlock on it.
          hostedCreators: async (query) => {
            const namespace = (runtimeEnv as Record<string, unknown>).Board as {
              idFromName(name: string): { toString(): string }
              get(id: unknown): {
                hostedCreators(req: { env: BoardCall['env']; query: HostedCreatorQuery }): Promise<string>
              }
            }
            const id = namespace.idFromName(SPONSOR_OBJECT_NAME)
            if (id.toString() === state.id.toString()) {
              const sql = fromDurableObjectSql(state.storage.sql.raw, (write) =>
                state.raw.storage.transactionSync(write),
              )
              migrateAgentSchema(sql)
              return hostedCreatorFacts(
                sql,
                sdk.context(env.network, 'main', env.rpcUrl, { batch: true, trace: traceRpc }),
                query,
                Math.floor(Date.now() / 1000),
              )
            }
            return JSON.parse(await namespace.get(id).hostedCreators({ env, query })) as HostedCreatorFacts
          },
          // ADR-0023: the board signs the attestation and the worker attaches it in its own submit; no relay sends it.
          ...(key32(env.attesterKey)
            ? {
                evidence: {
                  attester: privateKeyToAccount(env.attesterKey as `0x${string}`),
                  ...(env.github.appId === '' ? {} : { github: env.github }),
                },
              }
            : {}),
        },
      )
      service = { key, board }
      return board
    }

    const authenticatedAgent = async (req: BoardCall): Promise<{ address: string }> => {
      if (req.agentAuth === undefined) throw new BoardError('forbidden', 'Agent authentication is required')
      const bindings = runtimeEnv as Record<string, unknown>
      const namespace = bindings.Board as {
        idFromName(name: string): unknown
        get(id: unknown): { oauthResolve(req: { resource: string; bearer?: string }): Promise<string> }
      }
      if (req.agentAuth.operator === true) {
        const management = namespace.get(namespace.idFromName(SPONSOR_OBJECT_NAME)) as unknown as {
          operatorAgent(req: { agentId: string; bearer?: string }): Promise<string>
        }
        const agent = JSON.parse(
          await management.operatorAgent({
            agentId: req.agentAuth.agentId,
            ...(req.bearer === undefined ? {} : { bearer: req.bearer }),
          }),
        ) as { address: string; chain_id: number }
        if (
          agent.address.toLowerCase() !== req.caller?.toLowerCase() ||
          agent.chain_id !== sdk.deployment(req.env.network).chainId ||
          !OPERATOR_CONTINUATIONS.has(req.tool)
        )
          throw new BoardError('forbidden', 'Operator continuation is outside this agent action')
        return { address: agent.address }
      }
      const grant = JSON.parse(
        await namespace.get(namespace.idFromName(SPONSOR_OBJECT_NAME)).oauthResolve({
          resource: req.agentAuth.resource,
          ...(req.bearer === undefined ? {} : { bearer: req.bearer }),
        }),
      ) as OAuthGrant | null
      const origin = new URL(req.agentAuth.resource).origin
      if (
        grant === null ||
        !grant.agentIds.includes(req.agentAuth.agentId) ||
        grant.chainId !== sdk.deployment(req.env.network).chainId ||
        resourceBoard(grant.resource, origin) !== req.env.boardId ||
        toolDecision(grant, req.tool, true) !== 'allow' ||
        req.caller?.toLowerCase() !== grant.address.toLowerCase()
      )
        throw new BoardError('forbidden', 'Agent scope, board or wallet mismatch')
      return grant
    }

    const executeAgent = (req: AgentExecuteRequest) =>
      runAgent({
        req,
        bindings: runtimeEnv as Record<string, unknown>,
        sql: fromDurableObjectSql(state.storage.sql.raw, (write) => state.raw.storage.transactionSync(write)),
        stateId: state.id.toString(),
        background: (work) => state.raw.waitUntil(work),
      })

    // 2026 subscriptions/listen streams live here, where every access change happens (ADR-0021).
    const listeners = new McpListeners({ now: () => Date.now() })
    let keepalive: ReturnType<typeof setInterval> | undefined
    let streamTick: ReturnType<typeof setInterval> | undefined
    let streamHead = -1
    let streamPending = false
    let streamBusy = false
    let streamGeneration = 0
    let lastStreamHeartbeat = Date.now()
    const streams = new McpEventStreams({
      now: () => Date.now(),
      changed: () => {
        if (streams.active() || streamTick === undefined) return
        clearInterval(streamTick)
        streamTick = undefined
      },
    })
    /** After a management call: connections whose access changed hear it, and connections that are gone end. */
    const syncListeners = () => {
      if (!listeners.active() && !streams.active()) return
      try {
        const sql = fromDurableObjectSql(state.storage.sql.raw, (write) => state.raw.storage.transactionSync(write))
        listeners.sync((grantId) => connectionAccess(sql, grantId))
        streams.sync((grantId) => eventStreamAccess(connectionAccess(sql, grantId)))
      } catch (error) {
        // A failed notice must never fail the call that changed access; clients still re-list on their next turn.
        console.error(JSON.stringify({ event: 'mcp-listen-sync-failed', ...errorDiagnostics(error) }))
      }
    }

    return Effect.succeed({
      // SAFETY: Alchemy's WorkerEnvironment is the binding record of this Worker.
      ...commonsRpcs({ state, bindings: runtimeEnv as Record<string, unknown>, host: commonsHost }),
      agentExecute: (req: AgentExecuteRequest) =>
        managementQueue(async () => {
          try {
            return await executeAgent(req)
          } catch (error) {
            return toJson(
              agentFailureReply(
                error,
                'Hosted agent execution failed',
                undefined,
                'unavailable',
                (requiredToolScope(req.tool) === 'sidequest:read' && toolAnnotations(req.tool).readOnlyHint) ||
                  req.tool === 'setup_status'
                  ? 'read'
                  : 'same-key',
              ),
            )
          } finally {
            syncListeners()
          }
        }),
      agentManage: (req: AgentManagementRequest) =>
        managementQueue(async () => {
          try {
            const bindings = runtimeEnv as Record<string, unknown>
            const namespace = bindings.Board as { idFromName(name: string): { toString(): string } }
            if (
              namespace.idFromName(SPONSOR_OBJECT_NAME).toString() !== state.id.toString() ||
              req.env.network !== bindings.NETWORK
            )
              throw new BoardError('forbidden', 'Management identity mismatch')
            const desk = new SessionDesk({
              sql: fromD1(bindings.Database as never),
              now: () => Math.floor(Date.now() / 1000),
              verify: async () => false,
            })
            const session = await desk.resolve({ bearer: req.bearer })
            if (session === undefined) throw new BoardError('unauthenticated', 'Sign in with your operator wallet')
            const context = sdk.context(req.env.network, 'main', req.env.rpcUrl)
            const sql = fromDurableObjectSql(state.storage.sql.raw, (write) => state.raw.storage.transactionSync(write))
            const managementResult = await agentManagement({
              request: req.request,
              sql,
              context,
              operator: session.address,
              bindings,
              rpcUrl: req.env.rpcUrl,
              relayKey: req.env.relayKey as Hex,
              now: () => Math.floor(Date.now() / 1000),
              ...(req.privyToken === undefined ? {} : { privyToken: req.privyToken }),
              execute: async (agentId, tool, args, key, _approvalId, originalBoard) => {
                const reply = JSON.parse(
                  await executeAgent(
                    operatorRequest(req, session.address, { agentId, tool, args, key, boardId: originalBoard }),
                  ),
                ) as BoardReply
                if (!reply.ok) throw failureFromReply(reply)
                return reply.result
              },
            })
            return toJson({ ok: true, result: managementResult })
          } catch (error) {
            return toJson(agentFailureReply(error, 'Agent management failed'))
          } finally {
            syncListeners()
          }
        }),
      operatorAgent: (req: { agentId: string; bearer?: string }) =>
        Effect.promise(async () => {
          const bindings = runtimeEnv as Record<string, unknown>
          const namespace = bindings.Board as { idFromName(name: string): { toString(): string } }
          if (namespace.idFromName(SPONSOR_OBJECT_NAME).toString() !== state.id.toString())
            throw new Error('Management identity mismatch')
          const desk = new SessionDesk({
            sql: fromD1(bindings.Database as never),
            now: () => Math.floor(Date.now() / 1000),
            verify: async () => false,
          })
          const session = await desk.resolve({ bearer: req.bearer })
          if (session === undefined) throw new BoardError('unauthenticated', 'Operator session required')
          const agent = new AgentStore(
            fromDurableObjectSql(state.storage.sql.raw, (write) => state.raw.storage.transactionSync(write)),
            () => Math.floor(Date.now() / 1000),
          ).owned(req.agentId, session.address)
          if (agent.state !== 'active') throw new BoardError('forbidden', 'Agent is not active')
          return toJson(agent)
        }),
      verifyAgentSigning: (req: BoardCall & { typedData: string }) =>
        Effect.promise(async () => {
          await authenticatedAgent(req)
          return boardFor(req.env).verifyAgentSigning(
            { address: getAddress(req.caller!) },
            { tool: req.tool, args: req.args, typedData: req.typedData },
          )
        }),
      /** OAuth lives beside the agent and sponsor journals, under this object's single-writer queue. */
      oauth: (req: {
        env: BoardCall['env']
        method: string
        path: string
        query: string
        body: Record<string, unknown>
        origin: string
        bearer?: string
      }) =>
        callQueue(async () => {
          const bindings = runtimeEnv as Record<string, unknown>
          const namespace = bindings.Board as { idFromName(name: string): { toString(): string } }
          if (
            namespace.idFromName(SPONSOR_OBJECT_NAME).toString() !== state.id.toString() ||
            req.env.network !== bindings.NETWORK
          )
            throw new Error('management object identity mismatch')
          const sql = fromDurableObjectSql(state.storage.sql.raw, (write) => state.raw.storage.transactionSync(write))
          migrateAgentSchema(sql)
          const desk = new SessionDesk({
            sql: fromD1(bindings.Database as never),
            now: () => Math.floor(Date.now() / 1000),
            verify: async () => false,
          })
          const session = await desk.resolve({ bearer: req.bearer })
          const reply = await oauthRoute({
            sql,
            method: req.method,
            path: req.path,
            query: new URLSearchParams(req.query),
            body: req.body,
            origin: req.origin,
            siteOrigin: req.origin,
            ...(session === undefined ? {} : { owner: session.address }),
            now: Math.floor(Date.now() / 1000),
            revokeSubscriptions: async (principal, grantId, at) => {
              await terminateGrantSubscriptions(fromD1(bindings.Database as never), principal, grantId, at)
            },
          })
          // Consent may bind a waiting setup connection to its agent; revoking ends a connection.
          syncListeners()
          return toJson(reply ?? null)
        }),
      oauthResolve: (req: { resource: string; bearer?: string; activity?: boolean }) =>
        Effect.sync(() => {
          const bindings = runtimeEnv as Record<string, unknown>
          const namespace = bindings.Board as { idFromName(name: string): { toString(): string } }
          if (namespace.idFromName(SPONSOR_OBJECT_NAME).toString() !== state.id.toString())
            throw new Error('management object identity mismatch')
          const sql = fromDurableObjectSql(state.storage.sql.raw, (write) => state.raw.storage.transactionSync(write))
          migrateAgentSchema(sql)
          return sql
        }).pipe(
          Effect.flatMap((sql) =>
            Effect.promise(async () => {
              const now = Math.floor(Date.now() / 1000)
              const grant = await resolveOAuth(sql, req.bearer, req.resource, now)
              if (grant === undefined) return toJson(null)
              // An MCP call: the agent's directory presence and the connection's last use on its agent page.
              if (req.activity === true && grant.setup !== true)
                new AgentStore(sql, () => now).touch(grant.agentIds[0]!)
              if (req.activity === true && grant.grantId !== undefined) touchConnection(sql, grant.grantId, now)
              // A connection that hears tool changes gets the exact list (ADR-0021).
              return toJson({ ...grant, listening: grant.grantId !== undefined && listeners.listening(grant.grantId) })
            }),
          ),
        ),
      /**
       * A 2026 connection's `subscriptions/listen` stream. The bearer is resolved here again, so the stream belongs to the
       * connection that holds the token; it ends when that connection is disconnected, revoked or stopped.
       */
      mcpListen: (req: { resource: string; bearer?: string; listen: ListenRequest }) =>
        Effect.promise(async () => {
          // SAFETY: Alchemy's WorkerEnvironment is this Worker's binding record, and Board is its own namespace.
          const bindings = runtimeEnv as Record<string, unknown>
          // SAFETY: as above; only idFromName is used, to prove this is the management object.
          const namespace = bindings.Board as { idFromName(name: string): { toString(): string } }
          if (namespace.idFromName(SPONSOR_OBJECT_NAME).toString() !== state.id.toString())
            throw new Error('management object identity mismatch')
          const sql = fromDurableObjectSql(state.storage.sql.raw, (write) => state.raw.storage.transactionSync(write))
          migrateAgentSchema(sql)
          const grant = await resolveOAuth(sql, req.bearer, req.resource, Math.floor(Date.now() / 1000))
          const access = grant?.grantId === undefined ? undefined : connectionAccess(sql, grant.grantId)
          if (grant?.grantId === undefined || access === undefined)
            return new Response(null, { status: 401, headers: { 'cache-control': 'no-store' } })
          const response = listeners.open(grant.grantId, req.listen, access)
          // Comments every 25 s keep idle streams under the platform's idle cut; the timer stops with the last stream.
          keepalive ??= setInterval(() => {
            listeners.keepalive()
            if (listeners.active() || keepalive === undefined) return
            clearInterval(keepalive)
            keepalive = undefined
          }, 25_000)
          return response
        }),
      /** Events use the same management authority as listen, and D1 is the shared feed for all producers. */
      mcpEventStream: (req: { resource: string; bearer?: string; request: EventStreamRequest }) =>
        Effect.promise(async () => {
          // SAFETY: Alchemy supplies this Worker's binding record.
          const bindings = runtimeEnv as Record<string, unknown>
          // SAFETY: Board is the namespace bound to this class; only its deterministic identity is needed.
          const namespace = bindings.Board as { idFromName(name: string): { toString(): string } }
          if (namespace.idFromName(SPONSOR_OBJECT_NAME).toString() !== state.id.toString())
            throw new Error('management object identity mismatch')
          const local = fromDurableObjectSql(state.storage.sql.raw, (write) => state.raw.storage.transactionSync(write))
          migrateAgentSchema(local)
          const grant = await resolveOAuth(local, req.bearer, req.resource, Math.floor(Date.now() / 1000))
          // SAFETY: NETWORK is configured by the stage profile and validated by deployment.
          const network = bindings.NETWORK as sdk.Network
          const access =
            grant?.grantId === undefined ? undefined : eventStreamAccess(connectionAccess(local, grant.grantId))
          if (
            grant?.grantId === undefined ||
            !access?.scopes.includes('sidequest:read') ||
            !grant.scopes.includes('sidequest:read') ||
            grant.chainId !== sdk.deployment(network).chainId
          )
            return new Response(null, { status: 401, headers: { 'cache-control': 'no-store' } })
          eventArguments(req.request.name, req.request.arguments)
          eventCursor(req.request.cursor)
          eventMaxAge(req.request.maxAgeMs)
          // SAFETY: Database is the stage's D1 binding, adapted to the shared AsyncSql interface.
          const sql = fromD1(bindings.Database as never)
          const start = await eventStreamStart(
            sql,
            network,
            grant.address,
            { ...req.request },
            Math.floor(Date.now() / 1000),
          )
          const response = streams.open(grant.grantId, req.request, { ...start, principal: grant.address, network })
          // A new stream may start in the backlog even when the global feed head has not moved.
          streamHead = -1
          streamPending = false
          streamGeneration++
          const tick = async () => {
            if (streamBusy) return
            streamBusy = true
            const generation = streamGeneration
            try {
              const [head] = await sql.all<{ seq: number | null }>(
                'SELECT max(seq) AS seq FROM feed_events WHERE chain_id = ?',
                grant.chainId,
              )
              const current = head?.seq ?? 0
              if (current > streamHead || streamPending) {
                const pending = await streams.deliver((stream) =>
                  readEventStreamPage(sql, stream, Math.floor(Date.now() / 1000)),
                )
                streamPending = pending || generation !== streamGeneration
                streamHead = current
              }
            } catch (error) {
              console.error(JSON.stringify({ event: 'mcp-event-stream-tick-failed', ...errorDiagnostics(error) }))
            } finally {
              streamBusy = false
              if (!streams.active() && streamTick !== undefined) {
                clearInterval(streamTick)
                streamTick = undefined
              }
            }
          }
          streamTick ??= setInterval(() => {
            syncListeners()
            streams.expire()
            // Heartbeats do not wait for D1, including when a previous tick is still reading.
            if (Date.now() - lastStreamHeartbeat >= 24_000) {
              streams.heartbeat()
              lastStreamHeartbeat = Date.now()
            }
            if (streams.active()) state.raw.waitUntil(tick())
          }, 3_000)
          return response
        }),
      /** Directory presence: when hosted agents last used their connection. No operator, grant or approval data. */
      managedActivity: (req: { agentIds: string[] }) =>
        Effect.sync(() => {
          const bindings = runtimeEnv as Record<string, unknown>
          const namespace = bindings.Board as { idFromName(name: string): { toString(): string } }
          if (namespace.idFromName(SPONSOR_OBJECT_NAME).toString() !== state.id.toString())
            throw new Error('management object identity mismatch')
          const sql = fromDurableObjectSql(state.storage.sql.raw, (write) => state.raw.storage.transactionSync(write))
          migrateAgentSchema(sql)
          const config = sdk.deployment(bindings.NETWORK as sdk.Network)
          return toJson(
            new AgentStore(sql, () => Math.floor(Date.now() / 1000)).lastActivity(
              config.chainId,
              config.identity,
              req.agentIds,
            ),
          )
        }),
      /**
       * Hosted agents' public profiles, for their registration files (`agentKey`) and `/data/profiles` (every minted
       * agent, or one `agentId`): name, description, tagline and avatar key. No operator, grant or approval data.
       */
      managedProfiles: (req: { agentKey?: string; agentId?: string }) =>
        Effect.promise(async () => {
          // SAFETY: the Worker environment is a plain record of this Worker's bindings and variables.
          const bindings = runtimeEnv as Record<string, unknown>
          // SAFETY: Board is this Worker's own Durable Object namespace binding, declared in worker.ts.
          const namespace = bindings.Board as { idFromName(name: string): { toString(): string } }
          if (namespace.idFromName(SPONSOR_OBJECT_NAME).toString() !== state.id.toString())
            throw new Error('management object identity mismatch')
          const sql = fromDurableObjectSql(state.storage.sql.raw, (write) => state.raw.storage.transactionSync(write))
          migrateAgentSchema(sql)
          const reader = profileReader(
            sql,
            () => Math.floor(Date.now() / 1000),
            // SAFETY: NETWORK is the Worker's configured network name, checked by sdk.deployment.
            sdk.deployment(bindings.NETWORK as sdk.Network),
          )
          return toJson(
            req.agentKey === undefined ? await reader.profiles(req.agentId) : await reader.registration(req.agentKey),
          )
        }),
      /** Public quote-request facts about hosted posters: agent IDs and one grant's headroom. No operator, grant or approval data. */
      hostedCreators: (req: { env: BoardCall['env']; query: HostedCreatorQuery }) =>
        Effect.promise(async () => {
          const bindings = runtimeEnv as Record<string, unknown>
          const namespace = bindings.Board as { idFromName(name: string): { toString(): string } }
          if (
            namespace.idFromName(SPONSOR_OBJECT_NAME).toString() !== state.id.toString() ||
            req.env.network !== bindings.NETWORK
          )
            throw new Error('management object identity mismatch')
          const sql = fromDurableObjectSql(state.storage.sql.raw, (write) => state.raw.storage.transactionSync(write))
          migrateAgentSchema(sql)
          const query = {
            addresses: req.query.addresses.filter((a) => isAddress(a)).slice(0, 90),
            allowances: req.query.allowances.filter((a) => isAddress(a.address) && isAddress(a.token)).slice(0, 50),
          }
          return toJson(
            await hostedCreatorFacts(
              sql,
              sdk.context(req.env.network, 'main', req.env.rpcUrl, { batch: true, trace: traceRpc }),
              query,
              Math.floor(Date.now() / 1000),
            ),
          )
        }),
      /** Private management storage remains in the existing reserved object. */
      management: (req: { kind: 'migrate' | 'retire' }) =>
        Effect.sync(() => {
          const namespace = (runtimeEnv as Record<string, unknown>).Board as
            | { idFromName(name: string): { toString(): string } }
            | undefined
          const objectName = req.kind === 'retire' ? '__sidequest_fleet_v1__' : SPONSOR_OBJECT_NAME
          if (namespace?.idFromName(objectName).toString() !== state.id.toString())
            throw new Error('management object identity mismatch')
          const sql = fromDurableObjectSql(state.storage.sql.raw, (write) => state.raw.storage.transactionSync(write))
          if (req.kind === 'retire') retireFleetSchema(sql)
          else migrateAgentSchema(sql)
          return 'null'
        }),
      /** Internal relay RPC shares the reserved object's queue and durable nonce ledger with sponsorship. */
      relay: (req: { env: BoardCall['env']; request: RelayRequest }) =>
        relayQueue(async (): Promise<string> => {
          try {
            const bindings = runtimeEnv as Record<string, unknown>
            const namespace = bindings.Board as { idFromName(name: string): { toString(): string } } | undefined
            if (
              namespace?.idFromName(SPONSOR_OBJECT_NAME).toString() !== state.id.toString() ||
              req.env.network !== bindings.NETWORK
            )
              throw new BoardError('forbidden', 'relay object identity or network mismatch')
            const request = req.request,
              deployment = sdk.deployment(req.env.network)
            if (deployment.network === 'monad-mainnet')
              throw new BoardError('forbidden', 'relay is disabled on mainnet')
            // No public generic relay: the three internal send paths still carry verifiable signed authority.
            if (request.authorizationList !== undefined) {
              if (
                !isAddress(request.to) ||
                request.data !== '0x' ||
                request.authorizationList.length !== 1 ||
                request.authorizationList[0]!.address.toLowerCase() !== deployment.delegation.delegator.toLowerCase()
              )
                throw new BoardError('forbidden', 'invalid account-upgrade relay request')
            } else if (request.value !== undefined && request.value !== '0') {
              if (
                deployment.network !== 'monad-testnet' ||
                !request.key.startsWith('drip:') ||
                !isAddress(request.to) ||
                request.data !== '0x' ||
                request.value !== '50000000000000000'
              )
                throw new BoardError('forbidden', 'invalid testnet MON drip')
            } else if (
              deployment.network === 'monad-testnet' &&
              deployment.testnetFaucet?.toLowerCase() === request.to.toLowerCase()
            ) {
              const decoded = decodeFunctionData({ abi: sdk.testnetFaucetAbi, data: request.data })
              if (!request.key.startsWith('faucet:') || decoded.functionName !== 'drip')
                throw new BoardError('forbidden', 'invalid testnet faucet relay request')
            } else {
              const pair = Object.values(deployment.stacks).find(
                (s) => s?.evaluator.toLowerCase() === request.to.toLowerCase(),
              )
              if (pair === undefined) throw new BoardError('forbidden', 'relay target is not a configured evaluator')
              const decoded = decodeFunctionData({ abi: sdk.sidequestEvaluatorAbi, data: request.data })
              if (!['attachEvidence', 'ruleWithSignature'].includes(decoded.functionName))
                throw new BoardError('forbidden', 'invalid evaluator relay method')
            }
            return toJson({ ok: true, result: await boardFor(req.env).relayTransaction(request) })
          } catch (e) {
            return toJson(agentFailureReply(e, 'The relay could not send this transaction', undefined, 'chain'))
          }
        }),
      /** Private RPC, reachable only through the existing Board binding's reserved object. */
      admit: (req: AdmissionCall) =>
        Effect.promise(async (): Promise<string> => {
          const bindings = runtimeEnv as Record<string, unknown>
          try {
            const namespace = bindings.Board as AdmissionNamespace | undefined
            if (namespace?.idFromName(ADMISSION_OBJECT_NAME).toString() !== state.id.toString())
              throw new Error('admission object identity mismatch')
            const wallet = await admissionIdentity(bindings, req)
            if (!needsWriteRate(req.tool)) return toJson({ ok: true })
            const ipHash = await admissionIpHash(req.ip)
            limits ??= new AdmissionRateLimits(fromDurableObjectSql(state.storage.sql.raw))
            const result = state.raw.storage.transactionSync(() =>
              limits!.consume(wallet, ipHash, req.tool, Math.floor(Date.now() / 1000)),
            )
            return toJson(result)
          } catch {
            return toJson({
              ok: false,
              code: 'forbidden',
              message: 'hosted write admission requires a valid session, edge IP and runtime policy',
            } satisfies AdmissionReply)
          }
        }),
      /** Runs one tool and returns its JSON reply; tool errors are replies, not failures. */
      call: (req: BoardCall) =>
        callQueue(async (): Promise<string> => {
          const tool = tools[req.tool]
          if (tool === undefined) return toJson({ ok: false, code: 'not-found', message: `no tool ${req.tool}` })
          // Only the hosted executor reopens a request, for an agent whose operator declined the pick.
          if (req.tool === 'release_pick' && req.agentAuth === undefined)
            return toJson({ ok: false, code: 'forbidden', message: 'release_pick is internal' })
          try {
            const bindings = runtimeEnv as Record<string, unknown>
            const network = bindings.NETWORK as sdk.Network
            const stage = bindings.DEPLOY_STAGE
            const admission = parseHostedAdmission(
              typeof bindings.PROD_ADMISSION_DRAIN === 'string' ? bindings.PROD_ADMISSION_DRAIN : '1',
            )
            if (req.env.network !== network || (network === 'monad-mainnet' && stage !== 'prod')) {
              return toJson({
                ok: false,
                code: 'forbidden',
                message: 'Durable Object runtime network/stage mismatch',
              })
            }
            const namespace = bindings.Board as { idFromName: (name: string) => { toString: () => string } } | undefined
            const objectName = objectFor(req.tool, req.env.boardId)
            const production = network === 'monad-mainnet' || stage === 'prod'
            if (
              (objectName !== req.env.boardId || production) &&
              (namespace === undefined || namespace.idFromName(objectName).toString() !== state.id.toString())
            )
              return toJson({ ok: false, code: 'forbidden', message: 'Durable Object board identity mismatch' })
            let directCaller = req.caller !== undefined ? { address: getAddress(req.caller) } : undefined
            if (req.agentAuth !== undefined) {
              const grant = await authenticatedAgent(req)
              directCaller = { address: getAddress(grant.address) }
              const rate = await enforceHostedRate(bindings, {
                network,
                tool: req.tool,
                boardId: req.env.boardId,
                bearer: req.bearer,
                caller: req.caller,
                ip: req.ip,
                agentAuth: req.agentAuth,
              })
              if (!rate.ok) return toJson(rate)
            } else if (production) {
              const desk = new SessionDesk({
                sql: fromD1((runtimeEnv as Record<string, unknown>).Database as never),
                now: () => Math.floor(Date.now() / 1000),
                verify: async () => false,
              })
              const session = await desk.resolve({ bearer: req.bearer, mcpSession: req.mcpSession })
              if (req.caller !== undefined && session?.address.toLowerCase() !== req.caller.toLowerCase())
                return toJson({
                  ok: false,
                  code: 'forbidden',
                  message: 'Durable Object caller is not the authenticated session wallet',
                })
              directCaller = session === undefined ? undefined : { address: session.address }
              const directDenied = admissionFailure(
                admission,
                network,
                req.env.boardId,
                req.tool,
                directCaller?.address,
                String(stage ?? ''),
              )
              if (directDenied !== undefined) return toJson({ ok: false, code: 'forbidden', message: directDenied })
              const rate = await enforceHostedRate(bindings, {
                network,
                tool: req.tool,
                boardId: req.env.boardId,
                bearer: req.bearer,
                mcpSession: req.mcpSession,
                caller: req.caller,
                ip: req.ip,
              })
              if (!rate.ok) return toJson(rate)
            }
            const board = boardFor(req.env)
            const caller = directCaller ?? board.resolveCaller({ bearer: req.bearer, mcpSession: req.mcpSession })
            const denied = admissionFailure(
              admission,
              network,
              req.env.boardId,
              req.tool,
              caller?.address,
              String(stage ?? ''),
            )
            if (denied !== undefined) return toJson({ ok: false, code: 'forbidden', message: denied })
            const ctx: ToolContext = {
              network: req.env.network,
              mcpSession: req.mcpSession,
              ...(commonsToolNames.has(req.tool) ? { commons: commonsHost(req.env) } : {}),
            }
            const toolResult = await tool.run(board, caller, req.args, ctx)
            // Inbox feed and Telegram notices for website, REST and managed calls alike; never fails the tool.
            await recordBoardEvent(fromDurableObjectSql(state.storage.sql.raw), fromD1(bindings.Database as never), {
              tool: req.tool,
              args: req.args,
              result: toolResult,
              network,
              boardId: req.env.boardId,
              now: Math.floor(Date.now() / 1000),
            })
            return toJson({ ok: true, result: toolResult } satisfies BoardReply)
          } catch (e) {
            // The one safe boundary for tenant replies: board refusals keep their code and fields, a decoded revert
            // keeps its error name, and anything else (RPC or provider text) becomes a logged error id.
            return toJson(
              agentFailureReply(
                e,
                'The board could not complete this call',
                undefined,
                'error',
                readOnlyHostedTools.has(req.tool) ? 'read' : 'same-key',
              ) satisfies BoardReply,
            )
          }
        }),
    })
  }),
) {}
