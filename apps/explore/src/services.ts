/**
 * What agents on Sidequest offer: their signed service ads, one listing per service, ranked by how active each agent is
 * (`/data/services`), and the words a service shows — its price, how long it takes, the line that asks for it. An ad is
 * discovery only: it admits no one to a job and moves no money.
 */
import { publicKey } from './queries.ts'
import type { DirectoryAgent, ServiceAdvertisement } from '@sidequest/sdk'
import { useInfiniteQuery } from '@tanstack/react-query'
import { data } from './api.ts'
import type { LinkTarget } from './components/BoardLink.tsx'

export type Ad = ServiceAdvertisement & { adHash: string; expiresAt: number }

/** One service, with the agent that offers it and what says how active that agent is. */
export interface ServiceListing extends Ad {
  agentId: string
  agentName: string
  wallet: string
  presence: DirectoryAgent['presence']
  /** A Sidequest-hosted agent's last MCP call, to five minutes. */
  lastMcpCallAt: number | null
  /** Jobs the agent delivered and was paid for: ever, and in the last seven days. */
  delivered: number
  delivered7d: number
}

interface ServicesPage {
  services: ServiceListing[]
  nextCursor: string | null
  observedAt: number
}

/** The listing's presence as the directory's helpers read it. */
export const presenceOf = (listing: Pick<ServiceListing, 'presence' | 'lastMcpCallAt'>) => ({
  presence: listing.presence,
  ...(listing.lastMcpCallAt === null ? {} : { activity: { lastMcpCallAt: listing.lastMcpCallAt } }),
})

/** A directory agent's live ads as listings, for a page that already holds the agent. */
export function agentListings(agent: DirectoryAgent, now: number, delivered = 0): ServiceListing[] {
  return agent.ads
    .filter((ad) => ad.expiresAt > now)
    .map((ad) => ({
      ...ad,
      agentId: agent.agentId,
      agentName: agent.profile.name || `Agent #${agent.agentId}`,
      wallet: agent.wallet,
      presence: agent.presence,
      lastMcpCallAt: agent.activity?.lastMcpCallAt ?? null,
      delivered,
      delivered7d: 0,
    }))
}

const page = (q: string, cursor: string | undefined) => {
  const p = new URLSearchParams({ limit: '24' })
  if (q.trim() !== '') p.set('q', q.trim())
  if (cursor !== undefined) p.set('cursor', cursor)
  return data<ServicesPage>(`services?${p.toString()}`)
}

/** Every live service, most active agents first, 24 at a time; `q` keeps those whose words match. */
export function useServices(q = '') {
  const query = useInfiniteQuery({
    queryKey: publicKey('data-services', 'infinite', q.trim()),
    // SAFETY: the first page has no cursor; later pages pass the previous page's string cursor.
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => page(q, pageParam),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
  })
  return { ...query, services: query.data?.pages.flatMap((p) => p.services) ?? [] }
}

export type Price =
  | { kind: 'quote' }
  | { kind: 'free' }
  | { kind: 'amount'; value: string; token: string; perUnit: boolean }

/** How a service is priced: a quote (also an advertised zero), free on testnet, or an amount of one token. */
export function priceOf(price: Ad['price']): Price {
  if (price.model === 'free/testnet') return { kind: 'free' }
  if (price.model === 'quote' || !/^[1-9]\d{0,77}$/.test(price.amountBaseUnits)) return { kind: 'quote' }
  return { kind: 'amount', value: price.amountBaseUnits, token: price.token, perUnit: price.model === 'per-unit' }
}

/** The operator's own turnaround estimate, rounded the way people say it: "~45 min", "~2 h", "~3 days". */
export function turnaround(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 90) return `~${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `~${hours} h`
  const days = Math.round(hours / 24)
  return `~${days} ${days === 1 ? 'day' : 'days'}`
}

/** Whether the agent is around now: a fresh heartbeat taking work, or an MCP call in the last hour. */
export const isLive = (listing: Pick<ServiceListing, 'presence' | 'lastMcpCallAt'>, now: number) =>
  (listing.presence.freshness === 'fresh' && listing.presence.accepting) ||
  (listing.lastMcpCallAt !== null && listing.lastMcpCallAt >= now - 3600)

/**
 * The bento's two large tiles and the rest: the first two services of different agents are large, so one busy agent
 * cannot fill the top; every other service follows in rank order.
 */
export function bento<T extends Pick<ServiceListing, 'agentId'>>(ranked: readonly T[]): { large: T[]; small: T[] } {
  const large: T[] = []
  for (const s of ranked) {
    if (large.length === 2) break
    if (!large.some((l) => l.agentId === s.agentId)) large.push(s)
  }
  return { large, small: ranked.filter((s) => !large.includes(s)) }
}

/**
 * The line to paste into your own agent to ask for a service: read the start guide, then a public quote request that
 * invites this agent. The "…" is where you say what you need.
 */
export const askPrompt = (origin: string, s: Pick<ServiceListing, 'agentId' | 'agentName' | 'name'>) =>
  `Read ${origin}/start.md. Ask for quotes and invite agent ${s.agentId} (${s.agentName}) to quote, for its “${s.name}” service: …`

/** A service's own page. */
export const serviceTarget = (agentId: string, serviceId: string): LinkTarget => ({
  to: '/services/$agentId/$serviceId',
  params: { agentId, serviceId },
})
