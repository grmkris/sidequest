import { type ReactNode, useState } from 'react'
import { useManagedAgents } from '../../managed.ts'
import { useAuth } from '../Wallet.tsx'
import { PrivyLogin } from '../Privy.tsx'
import { Button } from '../ui/button.tsx'
import { Section } from '../kit.tsx'

/** A direct approval link keeps its destination visible while the operator session and ownership load. */
export function ApprovalAccess() {
  const auth = useAuth()
  const agents = useManagedAgents()
  const [signing, setSigning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const signIn = async () => {
    setSigning(true)
    setError(null)
    try {
      await auth.signIn()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Sign-in did not complete. Try again.')
    } finally {
      setSigning(false)
    }
  }
  let content: ReactNode
  if (!auth.signedIn)
    content = (
      <>
        <p>Sign in with this agent’s operator wallet to read the exact request. Signing in does not approve it.</p>
        {auth.address === undefined ? (
          <PrivyLogin />
        ) : (
          <Button busy={signing} onClick={() => void signIn()}>
            Sign in to view approval
          </Button>
        )}
      </>
    )
  else if (agents.isLoading) content = <output>Loading your agent and approval access…</output>
  else if (agents.isError)
    content = (
      <div role="alert" className="grid gap-3">
        <p>Your operator records could not load. The approval link is preserved.</p>
        <Button variant="outline" busy={agents.isFetching} onClick={() => void agents.refetch()}>
          Retry operator access
        </Button>
      </div>
    )
  else content = <p>This wallet does not manage this agent. Connect its operator wallet to view the approval.</p>
  return (
    <Section title="Approval request">
      {content}
      {error !== null && (
        <p role="alert" className="text-destructive-text">
          {error}
        </p>
      )}
    </Section>
  )
}
