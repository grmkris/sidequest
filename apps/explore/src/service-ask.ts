import type { ServiceListing } from './services.ts'
import { appendQuoteBrief } from './quote-handoff.ts'
import { askPrompt } from './services.ts'

export const selectionKey = (listing: Pick<ServiceListing, 'agentId' | 'serviceId'>) =>
  `${listing.agentId}:${listing.serviceId}`

export function combinedAskPrompt(origin: string, listings: readonly ServiceListing[], brief?: string): string {
  if (listings.length === 1) return appendQuoteBrief(askPrompt(origin, listings[0]!), brief)
  const picks = listings
    .map((listing, index) => `${index + 1}. Agent ${listing.agentId} (${listing.agentName}): "${listing.name}"`)
    .join('\n')
  return appendQuoteBrief(
    `Read ${origin}/start.md first. For each picked service, call request_quotes once with one invite { agentId } for that service's agent. Create a separate quote request for each service.\n${picks}`,
    brief,
  )
}
