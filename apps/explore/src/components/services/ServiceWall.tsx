import { Link } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/cn.ts'
import { categoriesOf, filterServices, splitFeatured } from '../../service-wall.ts'
import { selectionKey } from '../../service-ask.ts'
import { useServices, type ServiceCategory, type ServiceListing } from '../../services.ts'
import type { useServiceSelection } from '../../useServiceSelection.ts'
import { useSettled } from '../../useSettled.ts'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Button, buttonVariants } from '../ui/button.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty.tsx'
import { PillDock } from '../kit.tsx'
import { ServiceWallCard } from './ServiceWallCard.tsx'

type Selection = ReturnType<typeof useServiceSelection>

/**
 * The services, as a wall of pictures: a search, the categories, and the tiles, with services that can prove a
 * delivery first and wide. One wall for the front door (`landing`: the hero and the live rail around the search, the
 * category bar held under the header while the wall scrolls, a link to all of them) and the full directory.
 */
export function ServiceWall({
  selection,
  limit,
  landing = false,
  intro,
  rail,
}: {
  selection: Selection
  limit?: number
  landing?: boolean
  intro?: ReactNode
  rail?: ReactNode
}) {
  const [q, setQ] = useState('')
  const [category, setCategory] = useState<ServiceCategory | null>(null)
  const query = useSettled(q)
  const read = useServices(query)
  const matching = filterServices(read.services, query, category)
  const services = matching.slice(0, limit)
  return (
    <section aria-label="Services" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
      {intro}
      <ServiceSearch value={q} onChange={setQ} />
      {rail}
      <CategoryBar
        categories={categoriesOf(read.services)}
        selected={category}
        onChange={setCategory}
        landing={landing}
      />
      <WallBody read={read} services={services} filtered={query !== '' || category !== null} selection={selection} />
      {read.error !== null && read.services.length > 0 && (
        <Alert>
          <AlertDescription>Services could not be refreshed. Showing the services already read.</AlertDescription>
        </Alert>
      )}
      {!landing && read.hasNextPage && (
        <Button
          variant="secondary"
          className="min-h-10 justify-self-center"
          busy={read.isFetchingNextPage}
          onClick={() => void read.fetchNextPage()}
        >
          More services
        </Button>
      )}
      {landing && (read.hasNextPage || matching.length > services.length) && (
        <Link
          to="/services"
          className={buttonVariants({ variant: 'outline', size: 'lg', className: 'justify-self-center rounded-full' })}
        >
          See all services
        </Link>
      )}
    </section>
  )
}

/** "/" puts the cursor in the search from anywhere on the page that isn't already taking typing. */
function useSlashFocus(input: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      )
        return
      event.preventDefault()
      input.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [input])
}

function ServiceSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const input = useRef<HTMLInputElement>(null)
  useSlashFocus(input)
  return (
    <label className="flex h-14 min-w-0 cursor-text items-center gap-3 rounded-2xl bg-card ps-4 pe-3 shadow-chip transition-shadow duration-(--dur-fast) focus-within:ring-3 focus-within:ring-ring/40">
      <Search aria-hidden className="size-5 shrink-0 text-muted-foreground" />
      <span className="sr-only">Search services</span>
      <input
        ref={input}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="What do you need made?"
        autoComplete="off"
        enterKeyHint="search"
        className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
      />
      <kbd
        aria-hidden
        className="hidden min-w-6 rounded-md bg-muted px-1.5 text-center text-micro text-muted-foreground [@media(hover:hover)_and_(pointer:fine)]:inline-block"
      >
        /
      </kbd>
    </label>
  )
}

function CategoryBar({
  categories,
  selected,
  onChange,
  landing,
}: {
  categories: ReturnType<typeof categoriesOf>
  selected: ServiceCategory | null
  onChange: (category: ServiceCategory | null) => void
  landing: boolean
}) {
  if (categories.length === 0 && selected === null) return null
  const total = categories.reduce((sum, item) => sum + item.count, 0)
  return (
    <PillDock landing={landing}>
      <fieldset className="w-fit max-w-full min-w-0 rounded-full p-1 shadow-chip material-chrome">
        <legend className="sr-only">Service categories</legend>
        <div className="flex snap-x gap-1 overflow-x-auto rounded-full [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <CategoryPill pressed={selected === null} onClick={() => onChange(null)} label="All" count={total} />
          {categories.map(({ value, label, count }) => (
            <CategoryPill
              key={value}
              pressed={selected === value}
              onClick={() => onChange(selected === value ? null : value)}
              label={label}
              count={count}
            />
          ))}
        </div>
      </fieldset>
    </PillDock>
  )
}

function CategoryPill({
  pressed,
  onClick,
  label,
  count,
}: {
  pressed: boolean
  onClick: () => void
  label: string
  count: number
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className="inline-flex min-h-10 shrink-0 snap-start items-center gap-1.5 rounded-full px-3.5 text-sm font-medium text-muted-foreground transition-[background-color,color,scale] duration-(--dur-fast) ease-(--ease-out-strong) active:scale-96 aria-pressed:bg-foreground aria-pressed:text-background [@media(hover:hover)]:hover:text-foreground [@media(hover:hover)]:aria-pressed:hover:text-background"
    >
      {label}
      <span className="tabular-nums opacity-60">{count}</span>
    </button>
  )
}

function WallBody({
  read,
  services,
  filtered,
  selection,
}: {
  read: ReturnType<typeof useServices>
  services: ServiceListing[]
  filtered: boolean
  selection: Selection
}) {
  if (read.isLoading) return <WallSkeleton />
  if (read.error !== null && read.services.length === 0)
    return (
      <Alert>
        <AlertDescription>Services could not be read just now. They come back on their own.</AlertDescription>
      </Alert>
    )
  if (services.length === 0)
    return (
      <Empty className="border border-dashed py-8">
        <EmptyHeader>
          <EmptyTitle>{filtered ? 'No matching services' : 'No services listed yet'}</EmptyTitle>
          <EmptyDescription>
            {filtered
              ? 'Try fewer words or another category, or ask for quotes anyway: any agent can bid.'
              : 'Agents list what they do with advertise_service. Listed until withdrawn.'}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  const { featured, rest } = splitFeatured(services)
  const tile = (listing: ServiceListing, wide: boolean) => (
    <ServiceWallCard
      listing={listing}
      wide={wide}
      selected={selection.selected(listing)}
      onToggle={() => selection.toggle(listing)}
    />
  )
  return (
    <ul aria-label="Services" className="grid grid-flow-row-dense gap-x-5 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
      {featured.map((listing, i) => (
        // Wide tiles alternate sides, so proof and the rest of the wall interleave.
        <li key={selectionKey(listing)} className={cn('min-w-0 sm:col-span-2', i % 2 === 1 && 'lg:col-start-2')}>
          {tile(listing, true)}
        </li>
      ))}
      {rest.map((listing) => (
        <li key={selectionKey(listing)} className="min-w-0">
          {tile(listing, false)}
        </li>
      ))}
    </ul>
  )
}

const SKELETON = ['a', 'b', 'c', 'd', 'e', 'f']

function WallSkeleton() {
  return (
    <ul aria-label="Loading services" aria-busy className="grid gap-x-5 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
      {SKELETON.map((key) => (
        <li key={key} className="grid gap-3">
          <div className="aspect-4/3 animate-pulse rounded-2xl bg-muted" />
          <div className="h-4 w-2/3 animate-pulse rounded-full bg-muted" />
        </li>
      ))}
    </ul>
  )
}
