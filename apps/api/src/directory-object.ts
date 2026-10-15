import { traceRpc, withRpcTracing } from './rpc-observability.ts'
import {
  DirectoryError,
  type DirectoryPort,
  DirectoryService,
  directoryAgentId,
  fromDurableObjectSql,
} from '@sidequest/board'
import { fromD1 } from '@sidequest/indexer'
import * as sdk from '@sidequest/sdk'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import { DirectoryProjectionJournal } from './directory-projection.ts'
import { toJson } from './tools.ts'
import { directoryPolicy } from './directory-admission.ts'

export interface DirectoryCall {
  network: sdk.Network
  rpcUrl: string
  audience: string
  agentId: string
  action: 'prepare' | 'submit' | 'read'
  kind?: sdk.DirectoryKind
  payload?: unknown
  expiresAt?: number
  record?: unknown
  signature?: unknown
}

export function directoryAudience(audience: string): string {
  try {
    const url = new URL(audience)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
  } catch {
    /* Refuse malformed URLs without exposing supplied audience values. */
  }
  throw new DirectoryError('invalid', 'directory audience must be an HTTP(S) origin')
}

function directoryFailure(error: unknown) {
  if (!(error instanceof DirectoryError)) return { ok: false, code: 'error', message: 'directory unavailable' }
  return {
    ok: false,
    code: error.code,
    message: error.message,
    ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
  }
}

export const directoryObjectName = (chainId: number, registry: string, audience: string, agentId: string) =>
  `${chainId}:${registry.toLowerCase()}:${directoryAudience(audience)}:${directoryAgentId(agentId)}`

const DIRECTORY_CODES = new Set(['invalid', 'forbidden', 'conflict', 'chain', 'not-found', 'rate-limited'])

/** An agent's directory object as the management object calls it for the agent's own hosted listing tools. */
export function directoryPort(
  bindings: Record<string, unknown>,
  target: Pick<DirectoryCall, 'network' | 'rpcUrl' | 'audience' | 'agentId'>,
): DirectoryPort {
  const namespace = bindings.DirectoryObject as {
    idFromName(name: string): unknown
    get(id: unknown): { call(request: DirectoryCall): Promise<string> }
  }
  const config = sdk.deployment(target.network)
  const stub = namespace.get(
    namespace.idFromName(directoryObjectName(config.chainId, config.identity, target.audience, target.agentId)),
  )
  const run = async <T>(more: Omit<DirectoryCall, 'network' | 'rpcUrl' | 'audience' | 'agentId'>): Promise<T> => {
    const reply = JSON.parse(await stub.call({ ...target, ...more })) as
      | { ok: true; result: T }
      | { ok: false; code: string; message: string; retryAfter?: number }
    if (reply.ok) return reply.result
    throw new DirectoryError(
      DIRECTORY_CODES.has(reply.code) ? (reply.code as DirectoryError['code']) : 'chain',
      reply.message,
      reply.retryAfter,
    )
  }
  return {
    read: () => run({ action: 'read' }),
    prepare: (kind, payload) => run({ action: 'prepare', kind, payload }),
    submit: async (record, signature) =>
      (await run<{ agent: sdk.DirectoryAgent }>({ action: 'submit', record, signature })).agent,
  }
}

export default class DirectoryObject extends Cloudflare.DurableObject<DirectoryObject>()(
  'DirectoryObject',
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState
    const environment = yield* Cloudflare.Workers.WorkerEnvironment
    return Effect.sync(() => {
      const storage = fromDurableObjectSql(state.storage.sql.raw)
      const journal = new DirectoryProjectionJournal(storage)
      const sql = fromD1(environment.DIRECTORY_DATABASE)
      let queue: Promise<unknown> = Promise.resolve()
      const serialized = <Result>(operation: () => Promise<Result>) => {
        const result = queue.then(operation)
        queue = result.catch(() => undefined)
        return result
      }
      const serviceFor = (request: DirectoryCall) => {
        const config = sdk.deployment(request.network)
        const reads =
          request.rpcUrl === ''
            ? undefined
            : sdk.context(request.network, 'main', request.rpcUrl, { batch: true, trace: traceRpc }).publicClient
        return new DirectoryService({
          sql: storage,
          chainId: config.chainId,
          identityRegistry: config.identity,
          audience: directoryAudience(request.audience),
          agentId: request.agentId,
          now: () => Math.floor(Date.now() / 1000),
          readIdentity: async (id) => {
            if (reads === undefined) throw new Error('identity RPC unavailable')
            const [wallet, agentURI] = await Promise.all([
              reads.readContract({
                address: config.identity,
                abi: sdk.identityAbi,
                functionName: 'getAgentWallet',
                args: [BigInt(id)],
              }),
              reads.readContract({
                address: config.identity,
                abi: sdk.identityAbi,
                functionName: 'tokenURI',
                args: [BigInt(id)],
              }),
            ])
            if (agentURI.length > 16384) throw new Error('identity profile reference is too large')
            return { wallet, agentURI }
          },
          verify: async (address, record, signature) =>
            reads === undefined
              ? false
              : reads.verifyTypedData({ address, ...sdk.directoryTypedData(record), signature }),
        })
      }
      const flushProjection = async (service: DirectoryService) => {
        try {
          await journal.flush(sql, service.publicView())
          await state.raw.storage.deleteAlarm()
        } catch {
          await state.raw.storage.setAlarm(Date.now() + 60_000)
        }
      }
      return {
        call: (request: DirectoryCall) =>
          Effect.promise(() =>
            serialized(async () => {
              let service: DirectoryService | undefined
              let flush = true
              try {
                // Canonicalize host metadata only. Signed records keep their exact audience.
                request = { ...request, audience: directoryAudience(request.audience) }
                const bindings = environment as Record<string, unknown>
                const denied = directoryPolicy(bindings, request)
                if (denied !== undefined) return toJson(denied)
                const config = sdk.deployment(request.network)
                const namespace = bindings.DirectoryObject as
                  | { idFromName(name: string): { toString(): string } }
                  | undefined
                if (
                  namespace
                    ?.idFromName(
                      directoryObjectName(config.chainId, config.identity, request.audience, request.agentId),
                    )
                    .toString() !== state.id.toString()
                )
                  throw new DirectoryError('forbidden', 'directory object identity mismatch')
                journal.prepare({ network: request.network, audience: request.audience, agentId: request.agentId })
                await state.raw.storage.setAlarm(Date.now() + 60_000)
                service = serviceFor(request)
                const result =
                  request.action === 'read'
                    ? await service.read()
                    : request.action === 'prepare'
                      ? await service.prepare(request.kind as sdk.DirectoryKind, request.payload, request.expiresAt)
                      : await service.submit(request.record, request.signature)
                if (request.action === 'submit')
                  flush = (result as { projection: sdk.DirectoryAgent | null }).projection !== null
                return toJson({ ok: true, result })
              } catch (error) {
                return toJson(directoryFailure(error))
              } finally {
                if (service !== undefined && flush) await flushProjection(service)
              }
            }),
          ).pipe(withRpcTracing),
        alarm: () =>
          Effect.promise(() =>
            serialized(async () => {
              const scope = journal.scope()
              if (scope !== null) await flushProjection(serviceFor({ ...scope, rpcUrl: '', action: 'read' }))
            }),
          ).pipe(withRpcTracing),
      }
    })
  }),
) {}
