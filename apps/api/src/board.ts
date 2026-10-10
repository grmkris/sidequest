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
  failureFromReply,
  type AgentRetry,
  hostedCreatorFacts,
  type HostedCreatorFacts,
  type HostedCreatorQuery,
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
import { r2MiningSource, type EpochBucket } from './mining.ts'
import { oauthRoute, resolveOAuth } from './oauth.ts'
import { terminateGrantSubscriptions } from './webhooks.ts'
import type { OAuthGrant } from './oauth.ts'
import { permittedTool } from './mcp-policy.ts'
import { resourceBoard } from './oauth-validation.ts'
import { runAgent, type AgentExecuteRequest } from './agent-runtime.ts'
import { agentManagement } from './agent-management.ts'
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
    let callQueue: Promise<unknown> = Promise.resolve()
    // Management execution may await a tenant object. Keep that queue separate from relay sends, which can be
    // requested by the tenant while the management object is waiting.
    let managementQueue: Promise<unknown> = Promise.resolve()
    // Relay sends retain one nonce-serialized queue in the reserved object.
    let relayQueue: Promise<unknown> = Promise.resolve()
    // SAFETY: Alchemy provides this object's SQL state and the API Worker's declared binding record.
    const commonsHost = commonsHostFactory({ state, bindings: runtimeEnv as never })

    const boardFor = (env: BoardCall['env']): BoardService => {
      const key = JSON.stringify(env)
      if (service?.key === key) return service.board
      const contexts: Partial<Record<sdk.StackName, sdk.Ctx>> = {}
      for (const name of ['main'] as const) {
        if (sdk.deployment(env.network).stacks[name] !== undefined)
          contexts[name] = sdk.context(env.network, name, env.rpcUrl, { batch: true })
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
          miningSource: r2MiningSource((runtimeEnv as Record<string, unknown>).Manifests as EpochBucket | undefined),
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
                sdk.context(env.network, 'main', env.rpcUrl),
                query,
                Math.floor(Date.now() / 1000),
              )
            }
            return JSON.parse(await namespace.get(id).hostedCreators({ env, query })) as HostedCreatorFacts
          },
          ...(key32(env.attesterKey) && key32(env.relayKey)
            ? {
                evidence: {
                  attester: privateKeyToAccount(env.attesterKey as `0x${string}`),
                  relay: privateKeyToAccount(env.relayKey as `0x${string}`),
                  rpcUrl: env.rpcUrl,
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
          !['request_unstake', 'withdraw_stake', 'report_transaction', 'report_operation'].includes(req.tool)
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
        !permittedTool(grant, req.tool, true) ||
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
      })

    return Effect.succeed({
      // SAFETY: Alchemy's WorkerEnvironment is the binding record of this Worker.
      ...commonsRpcs({ state, bindings: runtimeEnv as Record<string, unknown>, host: commonsHost }),
      agentExecute: (req: AgentExecuteRequest) =>
        Effect.promise(() => {
          const result = managementQueue.then(async () => {
            try {
              return await executeAgent(req)
            } catch (error) {
              return toJson(agentFailureReply(error, 'Hosted agent execution failed'))
            }
          })
          managementQueue = result.catch(() => undefined)
          return result
        }),
      agentManage: (req: AgentManagementRequest) =>
        Effect.promise(() => {
          const result = managementQueue.then(async () => {
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
              const sql = fromDurableObjectSql(state.storage.sql.raw, (write) =>
                state.raw.storage.transactionSync(write),
              )
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
            }
          })
          managementQueue = result.catch(() => undefined)
          return result
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
        Effect.promise(() => {
          const result = callQueue.then(async () => {
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
            return toJson(
              (await oauthRoute({
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
              })) ?? null,
            )
          })
          callQueue = result.catch(() => undefined)
          return result
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
              const grant = await resolveOAuth(sql, req.bearer, req.resource, Math.floor(Date.now() / 1000))
              if (grant !== undefined && req.activity === true)
                new AgentStore(sql, () => Math.floor(Date.now() / 1000)).touch(grant.agentIds[0]!)
              return toJson(grant ?? null)
            }),
          ),
        ),
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
              sdk.context(req.env.network, 'main', req.env.rpcUrl),
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
        Effect.promise(() => {
          const result = relayQueue.then(async (): Promise<string> => {
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
          })
          relayQueue = result.catch(() => undefined)
          return result
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
        Effect.promise(() => {
          const result = callQueue.then(async (): Promise<string> => {
            const tool = tools[req.tool]
            if (tool === undefined) return toJson({ ok: false, code: 'not-found', message: `no tool ${req.tool}` })
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
              const namespace = bindings.Board as
                | { idFromName: (name: string) => { toString: () => string } }
                | undefined
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
                rpcUrl: req.env.rpcUrl,
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
                agentFailureReply(e, 'The board could not complete this call', undefined, 'error') satisfies BoardReply,
              )
            }
          })
          callQueue = result.catch(() => undefined)
          return result
        }),
    })
  }),
) {}
