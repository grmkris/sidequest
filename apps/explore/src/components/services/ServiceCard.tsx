/**
 * One service, in full: its pictures, who offers it and whether they are around, what to send and what comes back,
 * how long it takes and what it costs, and the prompt that asks for it. Shown in the sheet a tile opens and on the
 * service's own page. An ad is a listing, not a contract: nothing is paid until a quote is picked.
 */
import { Check, Copy, Plus, Radio } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { directoryLiveness, presenceLabel } from '../../directory-presence.ts'
import { cn } from '../../lib/cn.ts'
import { combinedAskPrompt } from '../../service-ask.ts'
import { type Ad, type ServiceListing, presenceOf, priceOf, serviceTarget, turnaround } from '../../services.ts'
import { AgentOrb } from '../agent/AgentOrb.tsx'
import { startOrigin, useCopy } from '../AgentStartLink.tsx'
import { BoardLink, boardRoutes } from '../BoardLink.tsx'
import { followsLink, useCardFrame } from '../CardLink.tsx'
import { textLinkClass } from '../kit.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'
import { Badge } from '../ui/badge.tsx'
import { Button } from '../ui/button.tsx'
import { Textarea } from '../ui/textarea.tsx'
import { ServiceGallery } from './ServiceGallery.tsx'

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
    <dl className={cn('grid gap-x-5 gap-y-3', wide ? 'sm:grid-cols-2' : 'grid-cols-2')}>
      <Fact label="You send">{listing.inputs}</Fact>
      <Fact label="You get">{listing.outputs}</Fact>
      <Fact label="Usually takes">{turnaround(listing.turnaroundSeconds)}</Fact>
      <Fact label="Price">
        <PriceText price={listing.price} className="font-medium" />
      </Fact>
    </dl>
  )
}

export function ServiceTags({ listing }: { listing: ServiceListing }) {
  if ((listing.tags?.length ?? 0) === 0) return null
  return (
    <ul aria-label="Service tags" className="flex flex-wrap gap-1.5">
      {listing.tags?.map((tag) => (
        <li key={tag}>
          <Badge variant="secondary">{tag}</Badge>
        </li>
      ))}
    </ul>
  )
}

/**
 * Asking for it: a brief (a tap on one of the briefs it takes fills it in), then the prompt for your own agent, which
 * posts a public quote request that invites this agent, and a way to add it to a request with other services.
 * `sticky` keeps the actions at the foot of a sheet while the rest scrolls.
 */
export function ServiceAsk({
  listing,
  selected = false,
  onToggle,
  sticky = false,
}: {
  listing: ServiceListing
  selected?: boolean
  onToggle?: (() => void) | undefined
  sticky?: boolean
}) {
  const [brief, setBrief] = useState('')
  return (
    <>
      <BriefField examples={listing.examples ?? []} brief={brief} onBrief={setBrief} />
      <p className="text-xs text-pretty text-muted-foreground">
        Your agent posts a public request and invites {listing.agentName} to quote. Nothing is paid until you pick a
        quote.
      </p>
      <AskBar
        listing={listing}
        prompt={combinedAskPrompt(startOrigin(), [listing], brief)}
        selected={selected}
        onToggle={onToggle}
        sticky={sticky}
      />
    </>
  )
}

function BriefField({
  examples,
  brief,
  onBrief,
}: {
  examples: readonly string[]
  brief: string
  onBrief: (brief: string) => void
}) {
  const id = useId()
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        Your brief
      </label>
      <Textarea
        id={id}
        value={brief}
        onChange={(event) => onBrief(event.target.value)}
        placeholder="What should it make? A sentence or two is enough."
        className="text-base"
        rows={3}
      />
      {examples.length > 0 && (
        <div className="grid gap-1.5">
          <p id={`${id}-briefs`} className="text-xs text-muted-foreground">
            Briefs it takes. Tap one to start from it.
          </p>
          <ul aria-labelledby={`${id}-briefs`} className="flex flex-wrap gap-2">
            {examples.map((example) => (
              <li key={example} className="min-w-0">
                <button
                  type="button"
                  aria-pressed={brief === example}
                  onClick={() => onBrief(example)}
                  className="min-h-10 rounded-xl bg-muted px-3 py-2 text-left text-sm text-pretty transition-[background-color,color,scale] duration-(--dur-fast) ease-(--ease-out-strong) active:scale-96 aria-pressed:bg-foreground aria-pressed:text-background [@media(hover:hover)]:hover:bg-accent [@media(hover:hover)]:aria-pressed:hover:bg-foreground"
                >
                  {example}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function AskBar({
  listing,
  prompt,
  selected,
  onToggle,
  sticky,
}: {
  listing: ServiceListing
  prompt: string
  selected: boolean
  onToggle: (() => void) | undefined
  sticky: boolean
}) {
  const [copied, copy] = useCopy()
  const [shown, setShown] = useState(false)
  const promptId = useId()
  const { inSheet, close } = useCardFrame()
  return (
    <div
      className={cn(
        'grid gap-2.5',
        sticky &&
          // Nearly solid: the ask has to read over whatever scrolls under it.
          'sticky -bottom-[calc(1.25rem+var(--safe-bottom))] z-1 -mx-5 -mb-[calc(1.25rem+var(--safe-bottom))] border-t bg-popover/92 px-5 pt-3 pb-[calc(1.25rem+var(--safe-bottom))] backdrop-blur-xl sm:-bottom-5 sm:-mb-5 sm:pb-5 [@media(prefers-reduced-transparency:reduce)]:bg-popover',
      )}
    >
      {shown && (
        <code
          id={promptId}
          className="max-h-32 overflow-y-auto rounded-xl bg-muted px-3.5 py-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]"
        >
          {prompt}
        </code>
      )}
      <div className="flex gap-2">
        <Button size="lg" className="flex-1" onClick={() => copy(prompt)}>
          {copied ? <Check aria-hidden data-icon="inline-start" /> : <Copy aria-hidden data-icon="inline-start" />}
          {copied ? 'Copied' : <CopyLabel />}
        </Button>
        {onToggle !== undefined && (
          <Button size="lg" variant="outline" aria-pressed={selected} onClick={onToggle}>
            {selected ? <Check aria-hidden data-icon="inline-start" /> : <Plus aria-hidden data-icon="inline-start" />}
            Add to request
          </Button>
        )}
      </div>
      <div className="flex items-center gap-4 text-xs">
        <button
          type="button"
          aria-expanded={shown}
          aria-controls={shown ? promptId : undefined}
          onClick={() => setShown(!shown)}
          className={cn(textLinkClass, 'min-h-8 font-medium')}
        >
          {shown ? 'Hide prompt' : 'Show prompt'}
        </button>
        {inSheet && (
          <BoardLink
            target={serviceTarget(listing.agentId, listing.serviceId)}
            onClick={(e) => {
              if (!followsLink(e)) close()
            }}
            className={cn(textLinkClass, 'inline-flex min-h-8 items-center font-medium')}
          >
            Service page
          </BoardLink>
        )}
      </div>
    </div>
  )
}

const CopyLabel = () => (
  <span>
    Copy prompt<span className="hidden sm:inline"> for your agent</span>
  </span>
)

/** The card a tile opens, in a sheet: the pictures across it, the service in full, and the ask at its foot. */
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
  const { inSheet } = useCardFrame()
  return (
    <div className="grid w-full gap-5">
      <ServiceGallery listing={listing} bleed={inSheet} />
      <div className="grid gap-2">
        <ServiceAgent listing={listing} now={now} />
        <p className="text-sm text-pretty text-muted-foreground">{listing.description}</p>
        <ServiceTags listing={listing} />
      </div>
      <ServiceFacts listing={listing} />
      <ServiceAsk listing={listing} selected={selected} onToggle={onToggle} sticky={inSheet} />
    </div>
  )
}
