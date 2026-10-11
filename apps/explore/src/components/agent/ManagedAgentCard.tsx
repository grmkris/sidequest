import { useSigners } from '@privy-io/react-auth'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { agentEndpoint, type ManagedAgent } from '../../api.ts'
import { agentAction, type AgentStatus } from '../../agent-api.ts'
import { localTime, relative } from '../../format.ts'
import { AgentNew } from '../../routes/AgentNew.tsx'
import { Address, TxLink } from '../kit.tsx'
import { Badge } from '../ui/badge.tsx'
import { Button } from '../ui/button.tsx'
import { useAuth } from '../Wallet.tsx'
import { useNow } from '../Time.tsx'
import { AgentStake } from '../AgentStake.tsx'
import { ListingCard } from './ListingCard.tsx'
import {
  AgentOwnedBacking,
  Connection,
  ManageCard,
  WalletEarnings,
  WeeklyBudget,
  useAgentAction,
} from './ManageCards.tsx'

/**
 * One managed agent, for its operator, as the Manage tab: setup while it is unfinished, then its weekly budget, wallet
 * and earnings, agent-owned backing, connection and directory listing, and access with revocation last. The live harness finds it as one
 * <article> carrying the agent's name (the cards inside are sections) and drives it by the exact strings below.
 */
export function ManagedAgentCard({ agent, onBack }: { agent: ManagedAgent; onBack?: () => void }) {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const { removeSigners } = useSigners()
  const status = useQuery({
    queryKey: ['managed-agent-status', agent.id, auth.address],
    queryFn: () =>
      agentEndpoint<AgentStatus & { permissions: ManagedPermission[] }>(`/api/agents/${encodeURIComponent(agent.id)}`),
    refetchInterval: 20000,
  })
  const now = useNow()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [operationKey, setOperationKey] = useState(() => crypto.randomUUID())
  const stopped = agent.state === 'revoked'
  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['managed-agents'] })
    await status.refetch()
  }
  const action = useAgentAction(agent, operationKey, () => {
    setOperationKey(crypto.randomUUID())
    void refresh()
  })
  async function revoke() {
    setBusy(true)
    setError(null)
    const failures: string[] = []
    try {
      await agentAction(agent.id, 'stop-access')
      await refresh()
      if (agent.address !== null) {
        try {
          await removeSigners({ address: agent.address })
          await agentAction(agent.id, 'signer-removed')
        } catch {
          failures.push('Hosted actions have stopped. Privy signer removal is still unconfirmed; retry removal.')
        }
      }
      try {
        await agentAction(agent.id, 'revoke')
      } catch {
        failures.push('On-chain disablement is incomplete. Reconcile again, or renew operator sponsorship if needed.')
      }
      await refresh()
      setError(failures.length === 0 ? null : failures.join(' '))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not stop access; no revocation is claimed')
    } finally {
      setBusy(false)
    }
  }
  const revocation = status.data?.revocation
  return (
    <article aria-label={agent.name} className="grid gap-7">
      <header className="grid gap-1 px-1">
        <h2 className="flex items-center gap-2 text-ui font-medium text-muted-foreground">
          Managing {agent.name}
          <Badge variant={agent.state === 'active' ? 'success' : 'neutral'}>{agent.state}</Badge>
        </h2>
        <p className="text-sm text-muted-foreground">
          <strong className="font-medium text-foreground">Last activity:</strong>{' '}
          {agent.last_activity_at == null
            ? 'Unknown · no observed MCP call'
            : `${relative(agent.last_activity_at, now)}${now - agent.last_activity_at > 86400 ? ' · stale' : ''}`}
          . This is server-observed activity, not a health signal.
        </p>
      </header>

      {!stopped && agent.state !== 'active' && <AgentNew initial={agent} />}
      {agent.state === 'active' && (
        <>
          <WeeklyBudget agent={agent} status={status} onChanged={() => void refresh()} />
          <WalletEarnings agent={agent} action={action} />
          <AgentOwnedBacking agent={agent} action={action} onBack={onBack} />
          {auth.address !== undefined && (
            <ManageCard
              title="Back this agent"
              note="Your SIDE stays owned by your wallet and backs the agent's creator and worker bonds. It shares penalty exposure and withdrawal cooldowns."
            >
              <AgentStake agent={agent} operator={auth.address} />
            </ManageCard>
          )}
        </>
      )}
      <PermissionList
        permissions={status.data?.permissions}
        action={action}
        refresh={async () => {
          await status.refetch()
        }}
      />
      <Connection />
      {agent.agent_id !== null && (
        <section id="manage-listing" aria-label="Directory listing" className="scroll-mt-20">
          <ListingCard agent={agent} />
        </section>
      )}

      <ManageCard
        title="Access"
        tone="danger"
        note="Stopping access ends hosted actions at once, removes the Privy signer and disables the agent's on-chain permissions."
      >
        <div className="grid gap-1 text-sm">
          <p>
            Agent wallet: <Address value={agent.address} />
          </p>
          <p>
            Hosted access:{' '}
            {revocation?.hostedAccessStopped
              ? revocation.signerRemoved
                ? 'Stopped · Privy signer removal confirmed'
                : 'Server stopped · Privy signer removal pending'
              : stopped
                ? 'Server stopped · provider status unknown'
                : 'Enabled'}
          </p>
          <p>
            On-chain permissions:{' '}
            {revocation?.onchainPermissionsDisabled ? 'Disabled · confirmed receipts' : 'Disablement unconfirmed'}
          </p>
          {revocation?.receipts?.map((receipt) => (
            <p key={receipt.tx_hash} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {receipt.status} · <TxLink hash={receipt.tx_hash} />
            </p>
          ))}
        </div>
        <Button variant="destructive" busy={busy} onClick={() => void revoke()} className="justify-self-start">
          {stopped ? 'Reconcile revocation and signer removal' : 'Stop hosted access and revoke'}
        </Button>
        {error !== null && <p className="text-ui text-destructive-text [overflow-wrap:anywhere]">{error}</p>}
      </ManageCard>
    </article>
  )
}

type ManagedPermission = {
  permissionId: string
  status: string
  expiresAt: number
  standing: boolean
  permission: { type: string }
}

function PermissionList({
  permissions,
  action,
  refresh,
}: {
  permissions: ManagedPermission[] | undefined
  action: ReturnType<typeof useAgentAction>
  refresh: () => Promise<void>
}) {
  return (
    <ManageCard
      title="Permissions"
      note="Revoke a permission to disable its onchain authority. Retry an interrupted revocation to reconcile the original send."
    >
      {permissions === undefined ? (
        <p>Permissions are unavailable.</p>
      ) : permissions.length === 0 ? (
        <p>No operator permissions.</p>
      ) : (
        permissions.map((row) => (
          <div key={row.permissionId} className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid gap-1 text-sm">
              <p>{row.permission.type}</p>
              <p>
                {row.status} · until {localTime(row.expiresAt)}
                {row.standing ? ' · standing permission' : ''}
              </p>
            </div>
            {row.status !== 'disabled' && (
              <Button
                variant="destructive"
                busy={action.busy && action.pending?.args.permissionId === row.permissionId}
                disabled={action.busy}
                onClick={() => void action.execute('revoke_permission', { permissionId: row.permissionId }, refresh)}
              >
                Revoke
              </Button>
            )}
          </div>
        ))
      )}
      {action.pending?.tool === 'revoke_permission' && (
        <Button
          variant="secondary"
          busy={action.busy}
          onClick={() => void action.execute(action.pending!.tool, action.pending!.args, refresh)}
        >
          Reconcile permission revocation
        </Button>
      )}
      {action.error !== null && action.pending?.tool === 'revoke_permission' && <p role="alert">{action.error}</p>}
    </ManageCard>
  )
}
