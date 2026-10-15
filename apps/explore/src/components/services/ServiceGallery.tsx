import { ArrowUpRight } from 'lucide-react'
import { useRef, useState } from 'react'
import { cn } from '../../lib/cn.ts'
import { sampleLabel } from '../../service-wall.ts'
import type { ServiceListing, ServiceSample } from '../../services.ts'
import { chain } from '../../wallet.ts'
import { BoardLink, boardRoutes } from '../BoardLink.tsx'
import { ServiceCover } from './ServiceCover.tsx'

/**
 * A service's pictures, one at a time across the card: swipe or scroll between them, the dots say where you are.
 * Each says what it is under it: a delivery proven on this chain links its job, an illustration or an outside example
 * says so. `bleed` runs the pictures to a sheet's edges.
 */
export function ServiceGallery({
  listing,
  bleed = false,
}: {
  listing: Pick<ServiceListing, 'samples' | 'category'>
  bleed?: boolean
}) {
  const strip = useRef<HTMLUListElement>(null)
  const [index, setIndex] = useState(0)
  const samples = listing.samples ?? []
  if (samples.length === 0) return null
  const show = (i: number) => {
    const node = strip.current
    if (node === null) return
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    node.scrollTo({ left: i * node.clientWidth, behavior: still ? 'auto' : 'smooth' })
  }
  return (
    <div className={cn('grid gap-2', bleed && '-mx-5')}>
      <ul
        ref={strip}
        aria-label="Service samples"
        onScroll={(e) => setIndex(Math.round(e.currentTarget.scrollLeft / Math.max(1, e.currentTarget.clientWidth)))}
        className="flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {samples.map((sample) => (
          <li key={sample.url} className="w-full shrink-0 snap-center">
            <Slide listing={listing} sample={sample} bleed={bleed} />
          </li>
        ))}
      </ul>
      {samples.length > 1 && <Dots keys={samples.map((sample) => sample.url)} index={index} onPick={show} />}
    </div>
  )
}

function Slide({
  listing,
  sample,
  bleed,
}: {
  listing: Pick<ServiceListing, 'category'>
  sample: ServiceSample
  bleed: boolean
}) {
  const proven = sample.kind === 'delivery' && sample.verified === true && sample.jobId !== undefined
  return (
    <figure className="grid gap-2">
      <a
        href={sample.url}
        target="_blank"
        rel="noreferrer"
        className="rounded-2xl focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ServiceCover
          listing={{ ...listing, samples: [sample] }}
          sample={sample}
          className={cn('aspect-16/10', bleed && 'rounded-none')}
        />
      </a>
      <figcaption className={cn('text-xs text-pretty text-muted-foreground', bleed && 'px-5')}>
        {proven ? (
          <BoardLink
            target={boardRoutes().job(sample.jobId!)}
            className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-4 hover:underline"
          >
            {sampleLabel(sample)} on {chain.name}
            <ArrowUpRight aria-hidden className="size-3.5" />
          </BoardLink>
        ) : (
          <span className="font-medium text-foreground">{sampleLabel(sample)}</span>
        )}{' '}
        {sample.caption}
      </figcaption>
    </figure>
  )
}

/** Where the strip is, and a way to any picture without swiping. */
function Dots({ keys, index, onPick }: { keys: string[]; index: number; onPick: (i: number) => void }) {
  return (
    <div className="flex justify-center">
      {keys.map((key, i) => (
        <button
          key={key}
          type="button"
          aria-label={`Picture ${i + 1} of ${keys.length}`}
          aria-current={i === index ? 'true' : undefined}
          onClick={() => onPick(i)}
          className="group/dot grid size-6 place-items-center"
        >
          <span
            className={cn(
              'size-1.5 rounded-full transition-[background-color,scale] duration-(--dur-fast)',
              i === index ? 'scale-125 bg-foreground' : 'bg-foreground/25 group-hover/dot:bg-foreground/50',
            )}
          />
        </button>
      ))}
    </div>
  )
}
