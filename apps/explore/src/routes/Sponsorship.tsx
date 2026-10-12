import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { TxRequest } from '../api.ts'
import { PageTitle, Section } from '../components/kit.tsx'
import { TxSteps } from '../components/TxSteps.tsx'
import { useAuth } from '../components/Wallet.tsx'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { sponsorApi, useSponsorStatus } from '../sponsor.ts'
import { friendlyError } from '../txErrors.ts'
import { isMainnet } from '../wallet.ts'

/** Keep old links and revocation available during cutover, without issuing new relay permissions. */
export function SponsorshipPage() {
  const auth = useAuth()
  return (
    <div className="grid gap-5">
      <PageTitle sub="Your wallet pays gas in USDC, or in MON.">Gas payments</PageTitle>
      <Section title="Pay as you act">
        <p className="text-sm">
          Sidequest actions use your USDC for gas, usually a fraction of a cent. You review the maximum before signing.
          If you hold MON instead, your wallet pays gas in MON.
        </p>
        {!isMainnet && (
          <p className="text-sm text-muted-foreground">
            Test-token claims need no MON. For later actions, get USDC from{' '}
            <a href="https://faucet.circle.com" target="_blank" rel="noreferrer" className="underline">
              Circle’s faucet
            </a>{' '}
            (Monad Testnet, 20 USDC every 2 hours).
          </p>
        )}
      </Section>
      {auth.signedIn && auth.address !== undefined && <LegacyPermission wallet={auth.address} />}
    </div>
  )
}

function LegacyPermission({ wallet }: { wallet: string }) {
  const queries = useQueryClient()
  const status = useSponsorStatus(wallet, true)
  const [txs, setTxs] = useState<TxRequest[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function revoke() {
    setBusy(true)
    setError(null)
    try {
      const result = await sponsorApi.revoke(wallet)
      setTxs(result.transactions.length === 0 ? null : result.transactions)
      await queries.invalidateQueries({ queryKey: ['sponsor_status'] })
    } catch (failure) {
      setError(friendlyError(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title="Previous gas permission">
      <p className="text-sm text-muted-foreground">
        Your previous permission is no longer used for new actions. Remove it onchain to end the access it granted.
      </p>
      {status.isError && <p role="alert">The previous permission could not be read.</p>}
      {status.data?.status === 'live' && (
        <Button variant="destructive" busy={busy} onClick={() => void revoke()}>
          Remove previous permission
        </Button>
      )}
      {txs !== null && (
        <TxSteps
          taskId={`sponsor-revoke:${wallet.toLowerCase()}`}
          txs={txs}
          owner={wallet}
          reportToBoard={false}
          onDone={() => {
            setTxs(null)
            void queries.invalidateQueries({ queryKey: ['sponsor_status'] })
          }}
        />
      )}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </Section>
  )
}
