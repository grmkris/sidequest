import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { OidcPolicy } from '@sidequest/sdk/oidc-policy'
import { agentEndpoint, boardPrefix, type ManagedAgent } from '../../api.ts'
import { managedKey } from '../../queries.ts'
import { useAuth } from '../Wallet.tsx'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { ConfirmButton } from '../Sheet.tsx'
import { ManageCard } from './ManageCards.tsx'
import { WorkloadPolicyForm } from './WorkloadPolicyForm.tsx'

interface SavedPolicy {
  id: string
  policy: OidcPolicy
  enabled: boolean
  resource: string
  scopes: string[]
}
interface PolicyList {
  enabled: boolean
  policies: SavedPolicy[]
}

/** The existing owner Manage tab, with operator-authenticated saves; the API controls feature availability. */
export function WorkloadPolicies({ agent }: { agent: ManagedAgent }) {
  const auth = useAuth()
  const list = useQuery({
    queryKey: managedKey('workload-policies', auth.address, auth.signedIn, agent.id),
    queryFn: () => agentEndpoint<PolicyList>(`/api/agents/${agent.id}/workload-policies`),
    enabled: auth.signedIn,
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function change(id: string, decision: 'disable' | 'delete') {
    setBusy(true)
    setError(null)
    try {
      await agentEndpoint(`/api/agents/${agent.id}/workload-policy-change`, 'POST', { id, decision })
      await list.refetch()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The policy could not be changed')
    } finally {
      setBusy(false)
    }
  }
  if (list.data?.enabled !== true) return null
  return (
    <ManageCard
      title="Trusted workloads"
      note="Each assertion can be exchanged once. Access lasts five minutes, with no refresh token. Disabling a policy stops its connections."
    >
      {list.data.policies.map((saved) => (
        <div key={saved.id} className="grid min-w-0 gap-2 text-sm [overflow-wrap:anywhere]">
          <p>
            {saved.policy.label || saved.policy.issuer} · {saved.enabled ? 'Enabled' : 'Disabled'}
          </p>
          <p className="text-muted-foreground">Client ID: {saved.id}</p>
          <p className="text-muted-foreground">
            Resource: {saved.resource} · {saved.scopes.join(', ')}
          </p>
          <div className="flex flex-wrap gap-2">
            {(['disable', 'delete'] as const).map((decision) => (
              <ConfirmButton
                key={decision}
                disabled={busy || (decision === 'disable' && !saved.enabled)}
                title={decision === 'disable' ? 'Disable this workload?' : 'Delete this trust policy?'}
                description="Its current access tokens and future assertion exchanges will stop."
                confirm={decision === 'disable' ? 'Disable' : 'Delete'}
                onConfirm={() => void change(saved.id, decision)}
              >
                {decision === 'disable' ? 'Disable' : 'Delete'}
              </ConfirmButton>
            ))}
          </div>
        </div>
      ))}
      <WorkloadPolicyForm
        resource={`${window.location.origin}${boardPrefix()}/mcp`}
        onSave={async (payload) => {
          await agentEndpoint(`/api/agents/${agent.id}/workload-policy-add`, 'POST', payload)
          await list.refetch()
        }}
      />
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </ManageCard>
  )
}
