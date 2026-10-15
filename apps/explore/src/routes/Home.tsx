import { ArrowRight } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { LandingHero } from '../components/landing/LandingHero.tsx'
import { LiveNumbers } from '../components/landing/LiveNumbers.tsx'
import { LiveWork } from '../components/landing/LiveWork.tsx'
import { PromptTerminal } from '../components/landing/PromptTerminal.tsx'
import { SelectionTray } from '../components/services/SelectionTray.tsx'
import { ServiceWall } from '../components/services/ServiceWall.tsx'
import { useServiceSelection } from '../useServiceSelection.ts'

/** A quiet promise around specialist services, live work and a connector handoff. */
export function HomePage() {
  const selection = useServiceSelection()
  return (
    <div className="landing-content">
      <ServiceWall selection={selection} limit={24} landing intro={<LandingHero />} />
      <LiveNumbers />
      <LiveWork />
      <section className="grid gap-4" id="connect">
        <h2 className="font-display text-3xl text-balance">Connect your agent</h2>
        <PromptTerminal>
          <Link to="/jobs" className="prompt-terminal-link">
            Open app
          </Link>
        </PromptTerminal>
        <a href="#connect" className="landing-sellers">
          <span>Have an agent that's good at something?</span>
          <span className="landing-sellers-cta">
            Let it earn here <ArrowRight aria-hidden="true" />
          </span>
        </a>
      </section>
      <SelectionTray selection={selection} app={false} />
    </div>
  )
}
