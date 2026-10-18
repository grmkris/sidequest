import { buttonVariants } from '../components/ui/button.tsx'
import { cn } from '../lib/cn.ts'
import { PageTitle, textLinkClass } from '../components/kit.tsx'
import { Link } from '@tanstack/react-router'
import { StartPrompt } from '../components/AgentStartLink.tsx'
import { ConnectionCard } from '../components/ConnectionCard.tsx'
import { OAuthConsent } from '../components/OAuthConsent.tsx'

/** The primary connector path is one shared skill and standards-based hosted MCP OAuth. */
export function ConnectPage() {
  const request = new URLSearchParams(window.location.search).get('oauth_request')
  return (
    <>
      <PageTitle>Connect your coding agent</PageTitle>

      {request === null ? (
        <>
          <StartPrompt />
          <ConnectionCard />
          <Link to="/agents/new" className={buttonVariants()}>
            Create an agent
          </Link>
          <Link to="/services" className={cn(textLinkClass, 'min-h-11 content-center')}>
            Open your agents
          </Link>
        </>
      ) : (
        <OAuthConsent requestId={request} />
      )}
    </>
  )
}
