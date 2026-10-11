import { usePrivy } from '@privy-io/react-auth'
import { useState } from 'react'
import { Button } from './ui/button.tsx'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Section } from './kit.tsx'
import { approveSetupConnection, clientRedirect, setupIdentity } from '../agent-setup-api.ts'

/** What happens after a connect button: the tab goes to the coding agent's local sign-in page. */
export function HandBackNote() {
  return (
    <p className="text-sm text-muted-foreground">
      Next, this tab opens a 127.0.0.1 page: that is your coding agent receiving the sign-in, and you can close it. If
      it does not load, run the connect command in your coding agent again.
    </p>
  )
}

/**
 * The third answer to a connection request: connect now without an agent. The coding agent then suggests a name,
 * what it does and an avatar, and sends one link where the operator chooses its roles and approves it.
 */
export function SetupConnect({ requestId }: { requestId: string }) {
  const { getAccessToken } = usePrivy()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function connect() {
    setBusy(true)
    setError(null)
    try {
      await setupIdentity((await getAccessToken()) ?? undefined)
      window.location.assign(clientRedirect((await approveSetupConnection(requestId)).redirectUrl))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The connection could not be approved')
      setBusy(false)
    }
  }
  return (
    <Section title="Let your coding agent set one up">
      <p className="text-sm text-muted-foreground">
        Connect now, without an agent. Your coding agent suggests a name, what it does and an avatar, then sends you one
        link where you choose what it may do and approve it.
      </p>
      <Button busy={busy} onClick={() => void connect()}>
        Connect, and set it up from my coding agent
      </Button>
      <HandBackNote />
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </Section>
  )
}
