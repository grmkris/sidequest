/**
 * Services as tiles: what it is, in two lines, its price, how long it takes and how much its agent has delivered. A
 * press opens the service's card (a sheet on a phone); a modified click opens its page. On an agent's own page the tiles
 * leave the agent out; in the bento a large tile also says what goes in and what comes out, and who is around.
 */
import { directoryLiveness, presenceLabel } from '../../directory-presence.ts'
import { cn } from '../../lib/cn.ts'
import { type ServiceListing, bento, presenceOf, serviceTarget, turnaround } from '../../services.ts'
import { AgentOrb } from '../agent/AgentOrb.tsx'
import { CardLink } from '../CardLink.tsx'
import { PriceText, ServiceCard } from './ServiceCard.tsx'

const TILE =
  'group flex h-full min-w-0 flex-col gap-2 rounded-xl bg-card p-3 text-left sm:p-4 ring-1 ring-foreground/10 outline-none transition-colors duration-(--dur-fast) [overflow-wrap:anywhere] focus-visible:ring-3 focus-visible:ring-ring/50 [@media(hover:hover)]:hover:bg-muted/60 aria-expanded:bg-muted/60'

function Foot({ listing }: { listing: ServiceListing }) {
  return (
    <span className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-1 text-xs text-muted-foreground tabular-nums">
      <PriceText price={listing.price} className="font-medium text-foreground" />
      <span aria-hidden>·</span>
      <span>{turnaround(listing.turnaroundSeconds)}</span>
      {listing.delivered > 0 && (
        <>
          <span aria-hidden>·</span>
          <span>{listing.delivered} delivered</span>
        </>
      )}
    </span>
  )
}

function ServiceTile({
  listing,
  now,
  size = 'small',
  showAgent = true,
}: {
  listing: ServiceListing
  now: number
  size?: 'small' | 'large'
  showAgent?: boolean
}) {
  const presence = presenceOf(listing)
  const large = size === 'large'
  return (
    <CardLink
      target={serviceTarget(listing.agentId, listing.serviceId)}
      title={listing.name}
      card={<ServiceCard listing={listing} now={now} />}
      label={`${listing.name}${showAgent ? `, by ${listing.agentName}` : ''}`}
      className={cn(TILE, large && 'gap-3 p-4 sm:p-5')}
    >
      {showAgent && (
        <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <AgentOrb agentId={listing.agentId} size={large ? 'md' : 'sm'} status={directoryLiveness(presence, now)} />
          <span className="grid min-w-0">
            <span className="truncate font-medium text-foreground">{listing.agentName}</span>
            {large && <span className="truncate">{presenceLabel(presence, now)}</span>}
          </span>
        </span>
      )}
      <span className={cn('font-semibold text-balance', large ? 'text-lg leading-snug' : 'text-sm leading-snug')}>
        {listing.name}
      </span>
      <span className={cn('text-sm text-pretty text-muted-foreground', large ? 'line-clamp-3' : 'line-clamp-2')}>
        {listing.description}
      </span>
      {large && (
        <span className="grid gap-0.5 text-xs text-pretty">
          <span className="line-clamp-1">
            <span className="text-muted-foreground">You send </span>
            {listing.inputs}
          </span>
          <span className="line-clamp-1">
            <span className="text-muted-foreground">You get </span>
            {listing.outputs}
          </span>
        </span>
      )}
      <Foot listing={listing} />
    </CardLink>
  )
}

/**
 * The bento: the two most active agents' services large (each spanning two columns and two rows on a wide screen),
 * the rest small around them, packed in rank order.
 */
export function ServiceBento({ services, now }: { services: readonly ServiceListing[]; now: number }) {
  const { large, small } = bento(services)
  // The second large tile comes after six small ones, so on four columns the two sit on opposite sides.
  const order = [...large.slice(0, 1), ...small.slice(0, 6), ...large.slice(1), ...small.slice(6)]
  return (
    <ul className="grid grid-flow-row-dense grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4" aria-label="Services">
      {order.map((listing) => {
        const big = large.includes(listing)
        return (
          <li
            key={`${listing.agentId}:${listing.serviceId}`}
            className={cn('min-w-0', big && 'col-span-2 lg:row-span-2')}
          >
            <ServiceTile listing={listing} now={now} size={big ? 'large' : 'small'} />
          </li>
        )
      })}
    </ul>
  )
}

/**
 * An agent's own services on its page: small tiles, without the agent, as many across as the column fits (three on an
 * agent's page, two beside a service, one on a phone).
 */
export function AgentServiceTiles({ services, now }: { services: readonly ServiceListing[]; now: number }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-3" aria-label="Services">
      {services.map((listing) => (
        <li key={listing.serviceId} className="min-w-0">
          <ServiceTile listing={listing} now={now} showAgent={false} />
        </li>
      ))}
    </ul>
  )
}
