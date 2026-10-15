import { Link } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { categoriesOf, filterServices } from '../../service-wall.ts'
import { selectionKey } from '../../service-ask.ts'
import { useServices, type ServiceCategory, type ServiceListing } from '../../services.ts'
import type { useServiceSelection } from '../../useServiceSelection.ts'
import { useSettled } from '../../useSettled.ts'
import { SearchBox } from '../JobFilters.tsx'
import { LoadingRows } from '../kit.tsx'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Button, buttonVariants } from '../ui/button.tsx'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '../ui/empty.tsx'
import { ServiceWallCard } from './ServiceWallCard.tsx'

/** One wall for the front door and the full service directory. */
export function ServiceWall({
  selection,
  limit,
  seeAll = false,
  intro,
}: {
  selection: ReturnType<typeof useServiceSelection>
  limit?: number
  seeAll?: boolean
  intro?: ReactNode
}) {
  const [q, setQ] = useState('')
  const [category, setCategory] = useState<ServiceCategory | null>(null)
  const query = useSettled(q)
  const read = useServices(query)
  const services = filterServices(read.services, query, category).slice(0, limit)
  return (
    <section aria-label="Services" className="grid min-w-0 gap-5">
      <div className="grid min-w-0 gap-5">
        {intro}
        <div className="min-h-11 [&>label]:min-h-11">
          <SearchBox value={q} onChange={setQ} label="What do you need made?" />
        </div>
        <CategoryChips categories={categoriesOf(read.services)} selected={category} onChange={setCategory} />
      </div>
      <WallBody read={read} services={services} query={query} category={category} selection={selection} />
      {read.error !== null && read.services.length > 0 && (
        <Alert>
          <AlertDescription>Services could not be refreshed. Showing the services already read.</AlertDescription>
        </Alert>
      )}
      {!seeAll && read.hasNextPage && (
        <Button
          variant="secondary"
          className="min-h-10 justify-self-center"
          busy={read.isFetchingNextPage}
          onClick={() => void read.fetchNextPage()}
        >
          More services
        </Button>
      )}
      {seeAll && (
        <Link
          to="/services"
          className={buttonVariants({ variant: 'outline', className: 'min-h-10 justify-self-start' })}
        >
          See all services
        </Link>
      )}
    </section>
  )
}

function CategoryChips({
  categories,
  selected,
  onChange,
}: {
  categories: ReturnType<typeof categoriesOf>
  selected: ServiceCategory | null
  onChange: (category: ServiceCategory | null) => void
}) {
  if (categories.length === 0 && selected === null) return null
  return (
    <fieldset className="flex min-w-0 flex-wrap gap-2">
      <legend className="sr-only">Service categories</legend>
      <Button
        variant={selected === null ? 'secondary' : 'ghost'}
        className="min-h-10 rounded-full"
        aria-pressed={selected === null}
        onClick={() => onChange(null)}
      >
        All services
      </Button>
      {categories.map(({ value, label, count }) => (
        <Button
          key={value}
          variant={selected === value ? 'secondary' : 'ghost'}
          className="min-h-10 gap-2 rounded-full"
          aria-pressed={selected === value}
          onClick={() => onChange(selected === value ? null : value)}
        >
          {label}
          <span className="text-muted-foreground tabular-nums">{count}</span>
        </Button>
      ))}
    </fieldset>
  )
}

function WallBody({
  read,
  services,
  query,
  category,
  selection,
}: {
  read: ReturnType<typeof useServices>
  services: ServiceListing[]
  query: string
  category: ServiceCategory | null
  selection: ReturnType<typeof useServiceSelection>
}) {
  if (read.isLoading) return <LoadingRows rows={3} />
  if (read.error !== null && read.services.length === 0)
    return (
      <Alert>
        <AlertDescription>Services could not be read just now. They come back on their own.</AlertDescription>
      </Alert>
    )
  if (services.length > 0)
    return (
      <ul
        aria-label="Services"
        className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-4 sm:gap-5"
      >
        {services.map((listing) => (
          <li key={selectionKey(listing)} className="min-w-0">
            <ServiceWallCard
              listing={listing}
              selected={selection.selected(listing)}
              onToggle={() => selection.toggle(listing)}
            />
          </li>
        ))}
      </ul>
    )
  const filtered = query !== '' || category !== null
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
}
