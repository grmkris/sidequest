import { Check } from 'lucide-react'
import { directoryLiveness } from '../../directory-presence.ts'
import { coverOf, sampleLabel } from '../../service-wall.ts'
import { presenceOf, serviceTarget, turnaround, type ServiceListing } from '../../services.ts'
import { AgentOrb } from '../agent/AgentOrb.tsx'
import { CardLink } from '../CardLink.tsx'
import { useNow } from '../Time.tsx'
import { Button } from '../ui/button.tsx'
import { PriceText, ServiceCard } from './ServiceCard.tsx'
import { ServiceCover } from './ServiceCover.tsx'

export function ServiceWallCard({
  listing,
  showAgent = true,
  selected,
  onToggle,
}: {
  listing: ServiceListing
  showAgent?: boolean
  selected: boolean
  onToggle: () => void
}) {
  const now = useNow()
  const sample = coverOf(listing)
  const label = sample === null ? '' : sampleLabel(sample)
  return (
    <article className="relative flex h-full min-w-0 flex-col gap-3 rounded-xl bg-card p-2 ring-1 ring-foreground/10 has-[.agent-card-open:focus-visible]:ring-3 has-[.agent-card-open:focus-visible]:ring-ring/50">
      <div className="grid">
        <div className="col-start-1 row-start-1">
          <ServiceCover listing={listing} />
        </div>
        {label.startsWith('Delivered #') && (
          <span className="pointer-events-none z-1 col-start-1 row-start-1 m-2 self-end justify-self-start rounded-md bg-card px-2 py-1 text-xs font-medium tabular-nums">
            {label}
          </span>
        )}
      </div>
      <h3 className="px-2 text-base leading-snug font-semibold text-balance [overflow-wrap:anywhere]">
        <CardLink
          mode="sheet"
          target={serviceTarget(listing.agentId, listing.serviceId)}
          title={listing.name}
          card={<ServiceCard listing={listing} now={now} selected={selected} onToggle={onToggle} />}
          className="agent-card-open after:absolute after:inset-0 after:rounded-xl focus-visible:outline-2 focus-visible:outline-transparent"
        >
          {listing.name}
        </CardLink>
      </h3>
      {showAgent && (
        <div className="pointer-events-none flex min-w-0 items-center gap-2 px-2 text-xs text-muted-foreground">
          <AgentOrb agentId={listing.agentId} size="sm" status={directoryLiveness(presenceOf(listing), now)} />
          <span className="truncate">{listing.agentName}</span>
        </div>
      )}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 px-2 pb-1">
        <div className="grid gap-0.5 text-xs text-muted-foreground tabular-nums">
          <PriceText price={listing.price} className="text-sm font-medium text-foreground" />
          <span>{turnaround(listing.turnaroundSeconds)}</span>
        </div>
        <Button
          variant={selected ? 'secondary' : 'outline'}
          aria-pressed={selected}
          onClick={onToggle}
          className="relative z-1 min-h-10 min-w-10"
        >
          {selected && <Check aria-hidden data-icon="inline-start" />}Select
        </Button>
      </div>
    </article>
  )
}
