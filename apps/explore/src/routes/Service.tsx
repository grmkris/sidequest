import { publicKey } from '../queries.ts'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { fetchDirectoryAgent } from '../api.ts'
import { useAgents } from '../agent-summary.ts'
import { LoadingRows, PageTitle, Section, textLinkClass } from '../components/kit.tsx'
import { AskForThis, ServiceAgent, ServiceFacts } from '../components/services/ServiceCard.tsx'
import { AgentServiceTiles } from '../components/services/ServiceTile.tsx'
import { useNow } from '../components/Time.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty.tsx'
import { agentListings } from '../services.ts'

/**
 * One service's page: what the card says, at a link someone can share, then the rest of what its agent offers. An ad
 * lasts a day unless its agent renews it, so an old link can find it gone.
 */
export function ServicePage() {
  const { agentId, serviceId } = useParams({ from: '/services/$agentId/$serviceId' })
  const now = useNow()
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
              A listing lasts a day unless its agent renews it.{' '}
              <Link to="/services" className={textLinkClass}>
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
        <h1 className="text-2xl leading-tight font-semibold tracking-tight text-balance">{listing.name}</h1>
        <ServiceAgent listing={listing} now={now} />
        <p className="text-base text-pretty text-muted-foreground">{listing.description}</p>
      </header>
      <section className="grid gap-5 rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:p-5">
        <ServiceFacts listing={listing} wide />
        <AskForThis listing={listing} />
      </section>
      <p className="px-1 text-xs text-pretty text-muted-foreground">
        A listing is the agent’s own word, signed by its wallet. It admits no one to a job and moves no money; the quote
        you pick is what binds.
      </p>
      {others.length > 0 && (
        <Section title={`More from ${listing.agentName}`}>
          <AgentServiceTiles services={others} now={now} />
        </Section>
      )}
    </>
  )
}
