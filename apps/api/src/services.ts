import { DirectoryError } from '@sidequest/board'
import { completedByAgent, type AsyncSql } from '@sidequest/indexer'
import { publicOrigin } from '@sidequest/indexer/telegram'
import { type DirectoryAgent, type Network, deployment, type ServiceAdvertisement } from '@sidequest/sdk'
import { Schema } from 'effect'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { withActivity } from './directory.ts'
import { jsonResponse } from './json.ts'
import { workerFailure } from './worker-failure.ts'

export interface ServiceListing {
  agentId: string
  agentName: string
  agentImage: string | null
  wallet: string
  serviceId: string
  name: string
  description: string
  inputs: string
  outputs: string
  turnaroundSeconds: number
  price: ServiceAdvertisement['price']
  category?: ServiceAdvertisement['category']
  tags?: string[]
  examples?: string[]
  samples?: Array<NonNullable<ServiceAdvertisement['samples']>[number] & { verified?: boolean }>
  adHash: string
  publishedAt: number
  expiresAt: number | null
  presence: DirectoryAgent['presence']
  lastMcpCallAt: number | null
  delivered: number
  delivered7d: number
  serviceUrl: string
  invite: { tool: 'request_quotes'; args: { invite: { agentId: string } } }
}

export interface ServicesPage {
  services: ServiceListing[]
  nextCursor: string | null
  observedAt: number
  chainId: number
  identityRegistry: string
}

export interface ServicesDeps {
  sql: AsyncSql
  network: Network
  audience: string
  exploreOrigin?: string
  activity?: (agentIds: string[]) => Promise<Array<{ agent_id: string; address: string; last_activity_at: number }>>
}

const ImageProfile = Schema.Struct({
  image: Schema.optionalKey(Schema.NullOr(Schema.String)),
  avatar: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

const profileImage = (agent: DirectoryAgent): string | null => {
  try {
    const profile = Schema.decodeUnknownSync(ImageProfile)(agent.profile)
    return profile.image ?? profile.avatar ?? null
  } catch {
    return null
  }
}

const ServicesInput = Schema.Struct({
  q: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  agentId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d{1,78}$/u))),
  limit: Schema.optionalKey(Schema.Number),
  cursor: Schema.optionalKey(Schema.String),
})
type ServicesInput = typeof ServicesInput.Type

export function parseServicesInput(input: unknown, maxLimit = 100): ServicesInput {
  try {
    const parsed = Schema.decodeUnknownSync(ServicesInput, { onExcessProperty: 'error' })(input)
    if (parsed.limit !== undefined && parseLimit(parsed.limit) > maxLimit) throw new Error('limit too large')
    return parsed
  } catch {
    throw new DirectoryError(
      'invalid',
      `expected q (up to 200 characters), agentId digits, limit 1-${maxLimit} and cursor`,
    )
  }
}

const searchable = (listing: ServiceListing): string =>
  [
    listing.name,
    listing.description,
    listing.inputs,
    listing.outputs,
    listing.agentName,
    listing.category,
    ...(listing.tags ?? []),
  ]
    .join(' ')
    .toLowerCase()

function matches(listing: ServiceListing, query: string | undefined): boolean {
  if (query === undefined || query.trim() === '') return true
  const text = searchable(listing)
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .every((term) => text.includes(term))
}

/** Stable service ordering: activity, delivery, freshness, then identifiers. */
const liveService = (listing: ServiceListing, now: number) =>
  (listing.presence.freshness === 'fresh' && listing.presence.accepting) ||
  (listing.lastMcpCallAt !== null && listing.lastMcpCallAt >= now - 3600)

export function rankServices(listings: readonly ServiceListing[], now: number): ServiceListing[] {
  return listings.toSorted((a, b) => {
    const liveDiff = Number(liveService(b, now)) - Number(liveService(a, now))
    if (liveDiff !== 0) return liveDiff
    if (b.delivered7d !== a.delivered7d) return b.delivered7d - a.delivered7d
    if (b.delivered !== a.delivered) return b.delivered - a.delivered
    if (b.publishedAt !== a.publishedAt) return b.publishedAt - a.publishedAt
    const agentDiff = BigInt(a.agentId) < BigInt(b.agentId) ? -1 : BigInt(a.agentId) > BigInt(b.agentId) ? 1 : 0
    if (agentDiff !== 0) return agentDiff
    return a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0
  })
}

function parseLimit(value: number | undefined): number {
  const limit = value ?? 24
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new DirectoryError('invalid', 'limit must be an integer from 1 to 100')
  return limit
}

function parseCursor(value: string | undefined): number {
  if (value === undefined) return 0
  try {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(value)) throw new Error('invalid cursor')
    const decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/'))
    if (!/^services:(0|[1-9]\d*)$/u.test(decoded)) throw new Error('invalid cursor')
    const offset = Number(decoded.slice('services:'.length))
    if (!Number.isSafeInteger(offset)) throw new Error('invalid cursor')
    return offset
  } catch {
    throw new DirectoryError('invalid', 'cursor must be a service page cursor')
  }
}

const cursorFor = (offset: number): string => btoa(`services:${offset}`).replace(/=+$/u, '')

function serviceListing(
  agent: DirectoryAgent,
  ad: DirectoryAgent['ads'][number],
  counts: { delivered: number; delivered7d: number } | undefined,
  origin: string,
): ServiceListing {
  return {
    agentId: agent.agentId,
    agentName: agent.profile.name,
    agentImage: profileImage(agent),
    wallet: agent.wallet,
    serviceId: ad.serviceId,
    name: ad.name,
    description: ad.description,
    inputs: ad.inputs,
    outputs: ad.outputs,
    turnaroundSeconds: ad.turnaroundSeconds,
    price: ad.price,
    ...(ad.category === undefined ? {} : { category: ad.category }),
    ...(ad.tags === undefined ? {} : { tags: ad.tags }),
    ...(ad.examples === undefined ? {} : { examples: ad.examples }),
    ...(ad.samples === undefined ? {} : { samples: ad.samples }),
    adHash: ad.adHash,
    // D1 projections written before durable listings have only the one-day expiry.
    publishedAt: ad.publishedAt ?? (ad.expiresAt ?? agent.observedAt) - 86400,
    expiresAt: ad.expiresAt,
    presence: agent.presence,
    lastMcpCallAt: agent.activity?.lastMcpCallAt ?? null,
    delivered: counts?.delivered ?? 0,
    delivered7d: counts?.delivered7d ?? 0,
    serviceUrl: `${origin}/services/${agent.agentId}/${ad.serviceId}`,
    invite: { tool: 'request_quotes', args: { invite: { agentId: agent.agentId } } },
  }
}

export async function servicesPage(deps: ServicesDeps, input: ServicesInput, now: number): Promise<ServicesPage> {
  input = parseServicesInput(input)
  const limit = parseLimit(input.limit)
  const offset = parseCursor(input.cursor)
  const config = deployment(deps.network)
  const rows = await deps.sql.all<{ json: string }>(
    'SELECT json FROM directory_agents WHERE chain_id = ? AND registry = ? AND audience = ? AND enrolled = 1',
    config.chainId,
    config.identity.toLowerCase(),
    deps.audience,
  )
  const projections = rows
    .map(readProjection)
    .filter(
      (agent) =>
        agent.ownership === 'verified' &&
        agent.profile.name.trim() !== '' &&
        (input.agentId === undefined || agent.agentId === input.agentId),
    )
  const agents = await withActivity(deps, projections)
  const counts = await completedByAgent(deps.sql, config.chainId, now - 7 * 24 * 60 * 60)
  const listings = agents.flatMap((agent) =>
    agent.ads
      .filter((ad) => ad.expiresAt === null || ad.expiresAt > now)
      .map((ad) => serviceListing(agent, ad, counts.get(agent.agentId), deps.exploreOrigin ?? publicOrigin())),
  )
  const ranked = rankServices(
    listings.filter((listing) => matches(listing, input.q)),
    now,
  )
  const page = ranked.slice(offset, offset + limit)
  await verifyDeliveries(deps.sql, config.chainId, page)
  return {
    services: page,
    nextCursor: offset + limit < ranked.length ? cursorFor(offset + limit) : null,
    observedAt: now,
    chainId: config.chainId,
    identityRegistry: config.identity,
  }
}

/** One bounded query for this page's delivery claims, matched to the listing's worker agent. */
async function verifyDeliveries(sql: AsyncSql, chainId: number, page: ServiceListing[]): Promise<void> {
  const ids = [
    ...new Set(
      page.flatMap(
        (listing) =>
          listing.samples?.flatMap((sample) =>
            sample.kind === 'delivery' && sample.jobId !== undefined ? [sample.jobId] : [],
          ) ?? [],
      ),
    ),
  ]
  if (ids.length === 0) return
  const rows = await sql.all<{ job_id: string; agent_id: string }>(
    `SELECT job_id, agent_id FROM jobs WHERE chain_id = ? AND kind = 'sidequest-v1'
      AND (status = 'completed' OR outcome = 'Accepted')
      AND job_id IN (SELECT value FROM json_each(?))`,
    chainId,
    JSON.stringify(ids),
  )
  const workers = new Map(rows.map((row) => [row.job_id, row.agent_id]))
  for (const listing of page) {
    if (listing.samples === undefined) continue
    listing.samples = listing.samples.map((sample) =>
      sample.kind === 'delivery'
        ? { ...sample, verified: sample.jobId !== undefined && workers.get(sample.jobId) === listing.agentId }
        : sample,
    )
  }
}

function readProjection(row: { json: string }): DirectoryAgent {
  // SAFETY: projectDirectory serializes DirectoryAgent; these rows come only from its private projection table.
  return JSON.parse(row.json) as DirectoryAgent
}

/** Public data route, shared by unprefixed and tenant-prefixed Worker paths. */
export async function servicesRoute(
  deps: ServicesDeps,
  url: URL,
  now: number,
  cors: Record<string, string>,
): Promise<HttpServerResponse.HttpServerResponse> {
  try {
    const input = {
      ...(url.searchParams.has('q') ? { q: url.searchParams.get('q') ?? '' } : {}),
      ...(url.searchParams.has('agentId') ? { agentId: url.searchParams.get('agentId') ?? '' } : {}),
      ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
      ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') ?? '' } : {}),
    }
    return jsonResponse(
      { ok: true, ...(await servicesPage(deps, input, now)) },
      { headers: { ...cors, 'cache-control': 'public, max-age=30' } },
    )
  } catch (error) {
    const reply = workerFailure(error)
    return jsonResponse(reply, {
      status: reply.code === 'invalid' ? 400 : 503,
      headers: { ...cors, 'cache-control': 'no-store' },
    })
  }
}
