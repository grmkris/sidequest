import { Address, Directory } from '@sidequest/commons'
import { SPONSOR_OBJECT_NAME, unwrapReply } from '@sidequest/board'
import type { AsyncSql } from '@sidequest/indexer'
import * as sdk from '@sidequest/sdk'
import { Effect, Layer, Option, Schema } from 'effect'
import { zeroAddress } from 'viem'

export interface DirectoryNamespace {
  getByName(name: string): { managedProfiles(req: Record<string, never>): Promise<string> }
}
const Profiles = Schema.Array(
  Schema.Struct({ agentId: Schema.NullOr(Schema.String), profile: Schema.Struct({ name: Schema.String }) }),
)
const DirectoryProfile = Schema.Struct({ agentId: Schema.String, profile: Schema.Struct({ name: Schema.String }) })
const AgentId = Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,77}$/u))
const agentIdOf = (token: string): string | null => Option.getOrNull(Schema.decodeUnknownOption(AgentId)(token))

async function names(sql: AsyncSql, namespace: DirectoryNamespace, ctx: sdk.Ctx, audience: string) {
  const hosted = Schema.decodeUnknownSync(Profiles)(
    unwrapReply(await namespace.getByName(SPONSOR_OBJECT_NAME).managedProfiles({})).result,
  )
  const rows = await sql.all<{ json: string }>(
    'SELECT json FROM directory_agents WHERE chain_id=? AND registry=? AND audience=? AND enrolled=1',
    ctx.deployment.chainId,
    ctx.deployment.identity.toLowerCase(),
    audience,
  )
  return [...hosted, ...rows.map((row) => Schema.decodeUnknownSync(Schema.fromJsonString(DirectoryProfile))(row.json))]
}

export function directoryLive(
  sql: AsyncSql,
  namespace: DirectoryNamespace,
  ctx: sdk.Ctx,
  audience: string,
): Directory['Service'] {
  const cache = new Map<string, { address: string | null; until: number }>()
  return {
    resolve: (tokens) =>
      Effect.promise(async () => {
        const now = Date.now()
        const pending = tokens.filter((token) => (cache.get(token.toLowerCase())?.until ?? 0) <= now)
        if (pending.length > 0) {
          try {
            const named = pending.some((token) => agentIdOf(token) === null)
              ? await names(sql, namespace, ctx, audience)
              : []
            const candidates = candidatesOf(pending, named)
            const wallets = await walletsOf(ctx, candidates)
            for (const candidate of candidates) {
              const address = candidate.id === null ? null : (wallets.get(candidate.id) ?? null)
              cache.set(candidate.token.toLowerCase(), { address, until: now + 600_000 })
            }
          } catch {
            /* Directory failures never confer an unresolved mention recipient. */
          }
        }
        return tokens.map((token) => {
          const entry = cache.get(token.toLowerCase())
          return { token, address: entry !== undefined && entry.until > now ? entry.address : null }
        })
      }),
  }
}

function candidatesOf(
  tokens: readonly string[],
  named: readonly { agentId: string | null; profile: { name: string } }[],
) {
  return tokens.map((token) => {
    const direct = agentIdOf(token)
    const ids =
      direct === null
        ? [
            ...new Set(
              named
                .filter((profile) => profile.profile.name.toLowerCase() === token.toLowerCase())
                .flatMap((profile) => (profile.agentId === null ? [] : [profile.agentId])),
            ),
          ]
        : [direct]
    return { token, id: ids.length === 1 ? ids[0]! : null }
  })
}

async function walletsOf(ctx: sdk.Ctx, candidates: readonly { id: string | null }[]) {
  const ids = [...new Set(candidates.flatMap((candidate) => (candidate.id === null ? [] : [candidate.id])))]
  const values =
    ids.length === 0
      ? []
      : await ctx.publicClient.multicall({
          allowFailure: true,
          contracts: ids.map((id) => ({
            address: ctx.deployment.identity,
            abi: sdk.identityAbi,
            functionName: 'getAgentWallet',
            args: [BigInt(Schema.decodeUnknownSync(AgentId)(id))],
          })),
        })
  return new Map(
    ids.map((id, index) => {
      const value = values[index]
      const address =
        value?.status === 'success' ? Option.getOrNull(Schema.decodeUnknownOption(Address)(value.result)) : null
      return [id, address === zeroAddress ? null : address]
    }),
  )
}

export const directoryLayer = (sql: AsyncSql, namespace: DirectoryNamespace, ctx: sdk.Ctx, audience: string) =>
  Layer.succeed(Directory, directoryLive(sql, namespace, ctx, audience))
