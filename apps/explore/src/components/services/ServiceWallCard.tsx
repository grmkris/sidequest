import { Check, Plus } from 'lucide-react'
import { directoryLiveness } from '../../directory-presence.ts'
import { cn } from '../../lib/cn.ts'
import { provenDelivery, tileCoverOf } from '../../service-wall.ts'
import { presenceOf, priceOf, serviceTarget, turnaround, type ServiceListing } from '../../services.ts'
import { AgentOrb } from '../agent/AgentOrb.tsx'
import { BoardLink, boardRoutes } from '../BoardLink.tsx'
import { CardLink } from '../CardLink.tsx'
import { useNow } from '../Time.tsx'
import { PriceText, ServiceCard } from './ServiceCard.tsx'
import { ServiceCover } from './ServiceCover.tsx'

/**
 * A service on the wall, as an offer in a catalogue: its picture first (the agent's illustration, in full colour), a
 * print on the desk with the light's edge and cast, then its name in the display face, how long it takes, who offers
 * it, the job that proves it and, when fixed, its price. No box around it. The whole tile opens the service's card;
 * the circle on the picture adds it to a request. In the bento (`fill`) the picture takes whatever height its cell
 * leaves, and a lead tile (`lead`) sets its name larger.
 */
export function ServiceWallCard({
  listing,
  showAgent = true,
  wide = false,
  fill = false,
  lead = false,
  selected,
  onToggle,
}: {
  listing: ServiceListing
  showAgent?: boolean
  /** Two columns wide on a wide screen, at the same picture height as its row. */
  wide?: boolean
  /** In the wall's bento: the picture fills the cell's height above the words, from a two-column wall up. */
  fill?: boolean
  /** The bento's large tile. */
  lead?: boolean
  selected: boolean
  onToggle: () => void
}) {
  const now = useNow()
  return (
    <article className="group/tile relative flex h-full min-w-0 flex-col gap-3 transition-transform duration-(--dur-fast) ease-(--ease-out-strong) has-[.service-tile-open:active]:translate-y-px">
      <div
        className={cn(
          'relative grid rounded-2xl shadow-stock transition-[box-shadow,translate] duration-(--dur-base) ease-(--ease-out-strong)',
          '[@media(hover:hover)]:group-hover/tile:-translate-y-px [@media(hover:hover)]:group-hover/tile:shadow-stock-lift',
          'group-has-[.service-tile-open:focus-visible]/tile:outline-3 group-has-[.service-tile-open:focus-visible]/tile:outline-offset-2 group-has-[.service-tile-open:focus-visible]/tile:outline-ring',
          // No transform here: it would lift the picture's own links under the tile's.
          selected && 'outline-3 outline-offset-2 outline-foreground',
          fill
            ? 'aspect-4/3 @md/wall:aspect-auto @md/wall:min-h-0 @md/wall:flex-1'
            : wide
              ? 'aspect-4/3 sm:aspect-2/1 lg:aspect-auto lg:min-h-48 lg:flex-1'
              : 'aspect-4/3',
        )}
      >
        <ServiceCover listing={listing} sample={tileCoverOf(listing)} className="col-start-1 row-start-1" />
        <SelectCircle name={listing.name} selected={selected} onToggle={onToggle} />
      </div>
      <div className="grid gap-1 px-0.5">
        <div className="flex min-w-0 items-baseline justify-between gap-3">
          <h3
            className={cn(
              'min-w-0 truncate font-display leading-snug font-normal tracking-tight',
              lead ? 'text-2xl' : 'text-xl',
            )}
          >
            <CardLink
              mode="sheet"
              target={serviceTarget(listing.agentId, listing.serviceId)}
              title={<span className="font-display text-2xl font-normal text-balance">{listing.name}</span>}
              sheetClassName="gap-5 sm:w-[40rem]"
              card={<ServiceCard listing={listing} now={now} selected={selected} onToggle={onToggle} />}
              className="service-tile-open block truncate outline-none after:absolute after:inset-0 after:rounded-2xl"
            >
              {listing.name}
            </CardLink>
          </h3>
          <span className="shrink-0 text-ui text-muted-foreground tabular-nums">
            {turnaround(listing.turnaroundSeconds)}
          </span>
        </div>
        <TileFacts listing={listing} showAgent={showAgent} now={now} />
      </div>
    </article>
  )
}

/** Who offers the service, the job that proves it and, when fixed, its price: the line under the tile's name. */
function TileFacts({ listing, showAgent, now }: { listing: ServiceListing; showAgent: boolean; now: number }) {
  const delivery = provenDelivery(listing)
  const priced = priceOf(listing.price).kind === 'amount'
  if (!showAgent && !priced && delivery?.jobId === undefined) return null
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 text-ui text-muted-foreground">
      {showAgent ? (
        <span className="inline-flex min-w-0 items-center gap-2">
          <AgentOrb agentId={listing.agentId} size="sm" status={directoryLiveness(presenceOf(listing), now)} />
          <span className="truncate">{listing.agentName}</span>
        </span>
      ) : (
        <span />
      )}
      <span className="inline-flex shrink-0 items-center gap-3">
        {delivery?.jobId !== undefined && <DeliveredLink jobId={delivery.jobId} />}
        {priced && <PriceText price={listing.price} className="font-medium text-foreground" />}
      </span>
    </div>
  )
}

/** The job that proves the service, in the tile's words rather than over its picture: a link of its own, above the tile's. */
function DeliveredLink({ jobId }: { jobId: string }) {
  return (
    <BoardLink
      target={boardRoutes().job(jobId)}
      className="relative z-1 inline-flex min-h-8 items-center gap-1 font-medium text-foreground tabular-nums underline-offset-4 pointer-coarse:min-h-10 [@media(hover:hover)]:hover:underline"
    >
      <Check aria-hidden className="size-3.5 text-paid" strokeWidth={2.5} />
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
          'grid size-8 place-items-center rounded-full shadow-stock transition-[translate,background-color,color] duration-(--dur-fast) ease-(--ease-out-strong) group-active/pick:translate-y-px group-focus-visible/pick:outline-2 group-focus-visible/pick:outline-offset-2 group-focus-visible/pick:outline-ring',
          selected ? 'bg-foreground text-background' : 'bg-card text-foreground',
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
