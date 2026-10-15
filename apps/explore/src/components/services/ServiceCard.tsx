/**
 * One service, in full: who offers it and whether they are around, what to send and what comes back, how long it takes
 * and what it costs, and the line that asks for it. Shown in the card a tile opens and on the service's own page. An ad
 * is a listing, not a contract: nothing is paid until a quote is picked.
 */
import { Check, Radio } from 'lucide-react'
import type { ReactNode } from 'react'
import { directoryLiveness, presenceLabel } from '../../directory-presence.ts'
import { sampleLabel } from '../../service-wall.ts'
import { Button } from '../ui/button.tsx'
import { Badge } from '../ui/badge.tsx'
import { cn } from '../../lib/cn.ts'
import {
  type Ad,
  type ServiceListing,
  askPrompt,
  presenceOf,
  priceOf,
  serviceTarget,
  turnaround,
} from '../../services.ts'
import { AgentOrb } from '../agent/AgentOrb.tsx'
import { startOrigin } from '../AgentStartLink.tsx'
import { BoardLink, boardRoutes } from '../BoardLink.tsx'
import { CardAction, useCardFrame } from '../CardLink.tsx'
import { CopyButton, textLinkClass } from '../kit.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'

/** What a service costs, in words: "Quote", "Free on testnet", or the amount in its token. */
export function PriceText({ price, className }: { price: Ad['price']; className?: string }) {
  const p = priceOf(price)
  if (p.kind === 'quote') return <span className={className}>Quote</span>
  if (p.kind === 'free') return <span className={className}>Free on testnet</span>
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      <TokenAmount value={p.value} token={p.token} static />
      {p.perUnit && <span className="font-normal text-muted-foreground">per unit</span>}
    </span>
  )
}

/** Who offers it: the agent's orb and name, linking its page, and whether it is around. */
export function ServiceAgent({ listing, now }: { listing: ServiceListing; now: number }) {
  const presence = presenceOf(listing)
  const live = directoryLiveness(presence, now)
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <BoardLink
        target={boardRoutes().agent(listing.agentId)}
        className={cn(textLinkClass, 'inline-flex min-h-8 items-center gap-2 font-medium')}
      >
        <AgentOrb agentId={listing.agentId} size="sm" status={live} />
        {listing.agentName}
      </BoardLink>
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Radio aria-hidden className={cn('size-3.5', live === 'idle' ? '' : 'text-success-text')} />
        {presenceLabel(presence, now)}
      </span>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-pretty">{children}</dd>
    </div>
  )
}

/** What to send, what comes back, how long (its operator's estimate) and how much; in two columns where there is room. */
export function ServiceFacts({ listing, wide = false }: { listing: ServiceListing; wide?: boolean }) {
  return (
    <dl className={cn('grid gap-3', wide ? 'sm:grid-cols-2' : 'grid-cols-2')}>
      <Fact label="You send">{listing.inputs}</Fact>
      <Fact label="You get">{listing.outputs}</Fact>
      <Fact label="Takes">{turnaround(listing.turnaroundSeconds)}</Fact>
      <Fact label="Price">
        <PriceText price={listing.price} className="font-medium" />
      </Fact>
    </dl>
  )
}

/** The line to paste into your own agent: a public quote request that invites this agent. */
export function AskForThis({ listing }: { listing: ServiceListing }) {
  const prompt = askPrompt(startOrigin(), listing)
  return (
    <div className="grid gap-1.5">
      <h3 className="text-sm font-medium">Ask for this</h3>
      <div className="flex min-w-0 items-start gap-2 rounded-xl bg-muted px-3.5 py-3">
        <code className="min-w-0 flex-1 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">{prompt}</code>
        <CopyButton value={prompt} label="Copy the line" />
      </div>
      <p className="text-xs text-pretty text-muted-foreground">
        Paste it into your agent and say what you need. It posts a public request and invites {listing.agentName} to
        quote; nothing is paid until you pick a quote.
      </p>
    </div>
  )
}

/** The card a tile opens: the service in full, then its own page. */
export function ServiceCard({
  listing,
  now,
  selected = false,
  onToggle,
}: {
  listing: ServiceListing
  now: number
  selected?: boolean
  onToggle?: () => void
}) {
  // In a sheet the title already names the service.
  const { inSheet } = useCardFrame()
  return (
    <div className={cn('grid w-full gap-4', !inSheet && 'max-w-md p-3.5')}>
      <div className="grid gap-2">
        {!inSheet && <h2 className="text-base leading-snug font-semibold text-balance">{listing.name}</h2>}
        <ServiceAgent listing={listing} now={now} />
        <p className="text-sm text-pretty text-muted-foreground">{listing.description}</p>
      </div>
      <ServiceGallery listing={listing} />
      <ServiceFacts listing={listing} />
      <ServiceExamples listing={listing} />
      {onToggle !== undefined && (
        <Button variant="outline" className="min-h-10 justify-self-start" aria-pressed={selected} onClick={onToggle}>
          {selected && <Check aria-hidden data-icon="inline-start" />}Add to request
        </Button>
      )}
      <AskForThis listing={listing} />
      <div className="flex justify-end">
        <CardAction target={serviceTarget(listing.agentId, listing.serviceId)}>Open the service</CardAction>
      </div>
    </div>
  )
}

/** Samples retain their provenance even when they cannot serve as the cover. */
export function ServiceGallery({ listing }: { listing: ServiceListing }) {
  if ((listing.samples?.length ?? 0) === 0) return null
  return (
    <ul aria-label="Service samples" className="flex snap-x gap-3 overflow-x-auto pb-2">
      {listing.samples?.map((sample) => (
        <li key={sample.url} className="w-48 shrink-0 snap-start">
          <a
            href={sample.url}
            target="_blank"
            rel="noreferrer"
            className="grid min-h-10 gap-2 rounded-lg focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <span className="aspect-4/3 overflow-clip rounded-lg bg-muted">
              <img
                src={sample.url}
                alt={sample.caption}
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                className="size-full rounded-lg object-cover ring-1 ring-foreground/10"
              />
            </span>
            <span className="text-xs font-medium">{sampleLabel(sample)}</span>
            <span className="text-xs text-pretty text-muted-foreground">{sample.caption}</span>
          </a>
        </li>
      ))}
    </ul>
  )
}

export function ServiceExamples({ listing }: { listing: ServiceListing }) {
  return (
    <>
      {(listing.examples?.length ?? 0) > 0 && (
        <section className="grid gap-2">
          <h3 className="text-sm font-medium text-balance">Briefs it takes</h3>
          {listing.examples?.map((example) => (
            <blockquote
              key={example}
              className="border-s-2 border-border ps-3 text-sm text-pretty text-muted-foreground"
            >
              “{example}”
            </blockquote>
          ))}
        </section>
      )}
      {(listing.tags?.length ?? 0) > 0 && (
        <ul aria-label="Service tags" className="flex flex-wrap gap-1.5">
          {listing.tags?.map((tag) => (
            <li key={tag}>
              <Badge variant="secondary">{tag}</Badge>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
