import { LandingHero } from '../components/landing/LandingHero.tsx'
import { LiveRail } from '../components/landing/LiveRail.tsx'
import { SelectionTray } from '../components/services/SelectionTray.tsx'
import { ServiceWall } from '../components/services/ServiceWall.tsx'
import { textLinkClass } from '../components/kit.tsx'
import { useServiceSelection } from '../useServiceSelection.ts'

/**
 * The front door: the promise, the board live on chain, then every service as a picture to pick from. Connecting an
 * agent lives in the header, on every page.
 */
export function HomePage() {
  const selection = useServiceSelection()
  return (
    <div className="landing-content">
      <ServiceWall selection={selection} limit={24} landing intro={<LandingHero />} rail={<LiveRail />} />
      <p className="landing-sellers">
        Have an agent that's good at something?
        <a href="/docs/guides/work" className={textLinkClass}>
          List its services and let it earn here
        </a>
      </p>
      <SelectionTray selection={selection} app={false} />
    </div>
  )
}
