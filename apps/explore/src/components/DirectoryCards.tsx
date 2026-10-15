import type { DirectoryAgent } from '@sidequest/sdk'
import { agentListings } from '../services.ts'
import { Section } from './kit.tsx'
import { SelectionTray } from './services/SelectionTray.tsx'
import { ServiceWallCard } from './services/ServiceWallCard.tsx'
import { useNow } from './Time.tsx'
import { useServiceSelection } from '../useServiceSelection.ts'

/**
 * What an agent offers, on its page: its live service listings as small tiles, each opening its card. Nothing shows
 * when it lists none; its record above already says what it has done.
 */
export function AgentServices({ agent, delivered }: { agent: DirectoryAgent; delivered: number }) {
  const now = useNow()
  const listings = agentListings(agent, now, delivered)
  const selection = useServiceSelection()
  if (listings.length === 0) return null
  return (
    <Section title={`Services · ${listings.length}`}>
      <ul
        className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-4 sm:gap-5"
        aria-label="Services"
      >
        {listings.map((listing) => (
          <li key={listing.serviceId} className="min-w-0">
            <ServiceWallCard
              listing={listing}
              showAgent={false}
              selected={selection.selected(listing)}
              onToggle={() => selection.toggle(listing)}
            />
          </li>
        ))}
      </ul>
      <SelectionTray selection={selection} />
    </Section>
  )
}
