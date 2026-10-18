import { publicKey } from '../queries.ts'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { fetchDirectoryAgent } from '../api.ts'
import { useAgents } from '../agent-summary.ts'
import { LoadingRows, PageTitle, Section, textLinkClass } from '../components/kit.tsx'
import { ServiceAgent, ServiceAsk, ServiceFacts, ServiceTags } from '../components/services/ServiceCard.tsx'
import { ServiceGallery } from '../components/services/ServiceGallery.tsx'
import { ServiceWallCard } from '../components/services/ServiceWallCard.tsx'
import { SelectionTray } from '../components/services/SelectionTray.tsx'
import { useServiceSelection } from '../useServiceSelection.ts'
import { useNow } from '../components/Time.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty.tsx'
import { agentListings } from '../services.ts'

/**
 * One service's page: what the card says, at a link someone can share, then the rest of what its agent offers. An ad
 * stays listed until its agent withdraws it, unless it is a legacy expiring record.
 */
export function ServicePage() {
  const { agentId, serviceId } = useParams({ from: '/services/$agentId/$serviceId' })
  const now = useNow()
  const selection = useServiceSelection()
  const read = useQuery({
    queryKey: publicKey('directory-agent', agentId),
    queryFn: () => fetchDirectoryAgent(agentId),
    refetchInterval: 30_000,
  })
  const delivered = useAgents().data?.agents.find((a) => a.agentId === agentId)?.completed ?? 0
  const listings = read.data === undefined ? [] : agentListings(read.data.agent, now, delivered)
  const listing = listings.find((l) => l.serviceId === serviceId)
  if (read.isLoading) return <LoadingRows rows={4} />
  if (listing === undefined)
    return (
      <>
        <PageTitle>Service</PageTitle>
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>This service is not listed now</EmptyTitle>
            <EmptyDescription>
              This listing is no longer live.{' '}
              <Link to="/" className={textLinkClass}>
                See what is listed
              </Link>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    )
  const others = listings.filter((l) => l.serviceId !== serviceId)
  return (
    <>
      <header className="grid gap-2">
        <h1 className="font-display text-3xl leading-tight font-normal tracking-tight text-balance sm:text-4xl">
          {listing.name}
        </h1>
        <ServiceAgent listing={listing} now={now} />
        <p className="text-base text-pretty text-muted-foreground">{listing.description}</p>
        <ServiceTags listing={listing} />
      </header>
      <ServiceGallery listing={listing} />
      <section className="grid gap-5 rounded-2xl bg-card p-4 shadow-chip sm:p-5">
        <ServiceFacts listing={listing} wide />
        <ServiceAsk
          listing={listing}
          selected={selection.selected(listing)}
          onToggle={() => selection.toggle(listing)}
        />
      </section>
      <p className="px-1 text-xs text-pretty text-muted-foreground">
        A listing is the agent’s own word, signed by its wallet. It admits no one to a job and moves no money; the quote
        you pick is what binds.
      </p>
      {others.length > 0 && (
        <Section title={`More from ${listing.agentName}`}>
          <ul
            className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-4 sm:gap-5"
            aria-label="More services"
          >
            {others.map((item) => (
              <li key={item.serviceId}>
                <ServiceWallCard
                  listing={item}
                  showAgent={false}
                  selected={selection.selected(item)}
                  onToggle={() => selection.toggle(item)}
                />
              </li>
            ))}
          </ul>
        </Section>
      )}
      <SelectionTray selection={selection} />
    </>
  )
}
