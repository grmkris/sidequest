import { Check, Plus } from 'lucide-react'
import { directoryLiveness } from '../../directory-presence.ts'
import { cn } from '../../lib/cn.ts'
import { provenDelivery } from '../../service-wall.ts'
import { presenceOf, priceOf, serviceTarget, turnaround, type ServiceListing } from '../../services.ts'
import { AgentOrb } from '../agent/AgentOrb.tsx'
import { BoardLink, boardRoutes } from '../BoardLink.tsx'
import { CardLink } from '../CardLink.tsx'
import { useNow } from '../Time.tsx'
import { PriceText, ServiceCard } from './ServiceCard.tsx'
import { ServiceCover } from './ServiceCover.tsx'

/**
 * A service on the wall: its picture first, then its name, how long it takes, and who offers it, with no box around
 * it. The whole tile opens the service's card; the circle on the picture adds it to a request. A service with a
 * delivery proven on this chain can take a wide tile, and its picture links that job.
 */
export function ServiceWallCard({
  listing,
  showAgent = true,
  wide = false,
  selected,
  onToggle,
}: {
  listing: ServiceListing
  showAgent?: boolean
  /** Two columns wide on a wide screen, at the same picture height as its row. */
  wide?: boolean
  selected: boolean
  onToggle: () => void
}) {
  const now = useNow()
  const delivery = provenDelivery(listing)
  const priced = priceOf(listing.price).kind === 'amount'
  return (
    <article className="group/tile relative flex h-full min-w-0 flex-col gap-3 transition-transform duration-(--dur-fast) ease-(--ease-out-strong) has-[.service-tile-open:active]:scale-98">
      <div
        className={cn(
          'relative grid rounded-2xl transition-shadow duration-(--dur-slow) ease-(--ease-out-strong)',
          '[@media(hover:hover)]:group-hover/tile:shadow-popover',
          'group-has-[.service-tile-open:focus-visible]/tile:outline-3 group-has-[.service-tile-open:focus-visible]/tile:outline-offset-2 group-has-[.service-tile-open:focus-visible]/tile:outline-ring',
          // No transform here: it would lift the picture's own links under the tile's.
          selected && 'outline-3 outline-offset-2 outline-foreground',
          wide ? 'aspect-4/3 sm:aspect-2/1 lg:aspect-auto lg:min-h-48 lg:flex-1' : 'aspect-4/3',
        )}
      >
        <ServiceCover
          listing={listing}
          className="col-start-1 row-start-1"
          imageClassName="transition-transform duration-500 ease-(--ease-out-strong) [@media(hover:hover)]:group-hover/tile:scale-103"
        />
        {delivery?.jobId !== undefined && <DeliveredBadge jobId={delivery.jobId} />}
        <SelectCircle name={listing.name} selected={selected} onToggle={onToggle} />
      </div>
      <div className="grid gap-1 px-0.5">
        <div className="flex min-w-0 items-baseline justify-between gap-3">
          <h3 className="min-w-0 truncate text-[0.9375rem] leading-snug font-semibold">
            <CardLink
              mode="sheet"
              target={serviceTarget(listing.agentId, listing.serviceId)}
              title={<span className="font-display text-2xl font-normal text-balance">{listing.name}</span>}
              sheetClassName="gap-5 sm:w-[40rem]"
              card={<ServiceCard listing={listing} now={now} selected={selected} onToggle={onToggle} />}
              className="service-tile-open outline-none after:absolute after:inset-0 after:rounded-2xl"
            >
              {listing.name}
            </CardLink>
          </h3>
          <span className="shrink-0 text-ui text-muted-foreground tabular-nums">
            {turnaround(listing.turnaroundSeconds)}
          </span>
        </div>
        {(showAgent || priced) && (
          <div className="flex min-w-0 items-center justify-between gap-3 text-ui text-muted-foreground">
            {showAgent ? (
              <span className="inline-flex min-w-0 items-center gap-2">
                <AgentOrb agentId={listing.agentId} size="sm" status={directoryLiveness(presenceOf(listing), now)} />
                <span className="truncate">{listing.agentName}</span>
              </span>
            ) : (
              <span />
            )}
            {priced && <PriceText price={listing.price} className="shrink-0 font-medium text-foreground" />}
          </div>
        )}
      </div>
    </article>
  )
}

/** The job that proves the service, over its picture: a link of its own, above the tile's. */
function DeliveredBadge({ jobId }: { jobId: string }) {
  return (
    <BoardLink
      target={boardRoutes().job(jobId)}
      className="relative z-1 col-start-1 row-start-1 m-2.5 inline-flex min-h-8 items-center gap-1 self-end justify-self-start rounded-full px-2.5 text-ui font-medium tabular-nums shadow-chip material-chrome pointer-coarse:min-h-10 [@media(hover:hover)]:hover:underline"
    >
      <Check aria-hidden className="size-3.5 text-success-text" strokeWidth={2.5} />
      Delivered #{jobId}
    </BoardLink>
  )
}

/**
 * Adds the service to a request: a glass circle on the picture, filled with ink and a check once picked. With a mouse
 * it shows on hover or focus; on touch it is always there, a little quieter.
 */
function SelectCircle({ name, selected, onToggle }: { name: string; selected: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`Add ${name} to request`}
      onClick={onToggle}
      className={cn(
        'group/pick relative z-1 col-start-1 row-start-1 m-1 grid size-11 place-items-center self-start justify-self-end rounded-full outline-none transition-opacity duration-(--dur-fast)',
        selected
          ? 'opacity-100'
          : 'opacity-80 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/tile:opacity-100 [@media(hover:hover)]:group-has-[:focus-visible]/tile:opacity-100',
      )}
    >
      <span
        className={cn(
          'grid size-8 place-items-center rounded-full shadow-chip transition-[scale,background-color,color] duration-(--dur-fast) ease-(--ease-out-strong) group-active/pick:scale-96 group-focus-visible/pick:ring-3 group-focus-visible/pick:ring-ring',
          selected ? 'bg-foreground text-background' : 'text-foreground material-chrome',
        )}
      >
        {selected ? (
          <Check aria-hidden className="size-4" strokeWidth={2.5} />
        ) : (
          <Plus aria-hidden className="size-4" strokeWidth={2} />
        )}
      </span>
    </button>
  )
}
