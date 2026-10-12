/**
 * The cards of an agent's Manage tab, for its operator: weekly budget, wallet and earnings, agent-owned backing,
 * connection, and access (revocation, last). Wallet and backing actions share one durable action journal per agent
 * (`useAgentAction`), so a saved operation is reconciled before any other starts. The live harness drives these by
 * their exact strings; keep them.
 */
import { type ReactNode, useState } from 'react'
import { type Address, erc20Abi } from 'viem'
import { useReadContracts } from 'wagmi'
import { type AgentStatus, agentAction } from '../../agent-api.ts'
import type { ManagedAgent } from '../../api.ts'
import { useBacking } from '../../delegation-query.ts'
import { localTime } from '../../format.ts'
import { cn } from '../../lib/cn.ts'
import { factoryAmount } from '../../stake.ts'
import { useTokenList } from '../../useTokens.ts'
import { chain, deployment } from '../../wallet.ts'
import { StartPrompt } from '../AgentStartLink.tsx'
import { GasAllowanceEditor } from '../GasAllowanceEditor.tsx'
import { AllowanceEditor } from '../AllowanceEditor.tsx'
import { ConnectionCard } from '../ConnectionCard.tsx'
import { Countdown, useNow } from '../Time.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'
import { Button } from '../ui/button.tsx'
import { Meter } from '../ui/meter.tsx'
import { AmountField } from '../money/AmountField.tsx'

/** A titled card of the Manage tab; `id` lets the Overview's next steps scroll to it. */
export function ManageCard({
  id,
  title,
  note,
  children,
  tone,
}: {
  id?: string
  title: string
  note?: ReactNode
  children: ReactNode
  tone?: 'danger'
}) {
  return (
    <section id={id} aria-label={title} className="grid scroll-mt-20 gap-2">
      <h2
        className={cn(
          'px-1 text-ui font-medium',
          tone === 'danger' ? 'text-destructive-text' : 'text-muted-foreground',
        )}
      >
        {title}
      </h2>
      <div
        className={cn(
          'grid gap-3 rounded-xl bg-card p-4 ring-1',
          tone === 'danger' ? 'ring-destructive/30' : 'ring-foreground/10',
        )}
      >
        {children}
      </div>
      {note !== undefined && <p className="px-1 text-ui text-muted-foreground">{note}</p>}
    </section>
  )
}

const errorText = (failure: unknown, fallback: string) => (failure instanceof Error ? failure.message : fallback)

/**
 * One saved action at a time per agent (sweep, request leaving, withdraw): the intent is written to localStorage before
 * the call and read back, so a reload retries the same operation key instead of starting a second one.
 */
export function useAgentAction(agent: ManagedAgent, operationKey: string, onConfirmed: () => void) {
  const journalKey = `sidequest.agent-action:${agent.id}`
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<{ tool: string; args: Record<string, unknown>; key: string } | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(journalKey) ?? 'null') as {
        tool: string
        args: Record<string, unknown>
        key: string
      } | null
    } catch {
      return null
    }
  })
  async function execute(tool: string, args: Record<string, unknown>, after?: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      if (pending !== null && (pending.tool !== tool || JSON.stringify(pending.args) !== JSON.stringify(args)))
        throw new Error('Reconcile the saved action before starting another')
      const intent = pending ?? { tool, args, key: operationKey }
      localStorage.setItem(journalKey, JSON.stringify(intent))
      if (localStorage.getItem(journalKey) !== JSON.stringify(intent))
        throw new Error('Action journal is not durable; nothing may start')
      setPending(intent)
      const result = await agentAction<{ status: string; operationId: string }>(agent.id, 'execute', {
        tool,
        args,
        operationKey: intent.key,
      })
      if (result.status === 'confirmed') {
        localStorage.removeItem(journalKey)
        setPending(null)
        onConfirmed()
        await after?.()
      } else if (result.status === 'approval') {
        localStorage.removeItem(journalKey)
        setPending(null)
        onConfirmed()
        setError('Approval to leave the exact agent-owned shares is waiting in Approvals.')
      } else setError(`Operation ${result.operationId} is ${result.status}. Retry the same action to reconcile.`)
    } catch (failure) {
      setError(errorText(failure, 'The action is unavailable; keep the original operation key'))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, pending, execute }
}
export type AgentAction = ReturnType<typeof useAgentAction>

function SavedAction({ action }: { action: AgentAction }) {
  return (
    <>
      {action.pending !== null && (
        <Button
          variant="secondary"
          busy={action.busy}
          onClick={() => void action.execute(action.pending!.tool, action.pending!.args)}
        >
          Reconcile saved action
        </Button>
      )}
      {action.error !== null && (
        <p className="text-ui text-destructive-text [overflow-wrap:anywhere]">{action.error}</p>
      )}
    </>
  )
}

/** The weekly budget: what is left of each allowance, when it resets, and the editor to change or renew it. */
export function WeeklyBudget({
  agent,
  status,
  onChanged,
}: {
  agent: ManagedAgent
  status: { data?: AgentStatus | undefined; error: unknown }
  onChanged: () => void
}) {
  const allowances = status.data?.allowances ?? []
  useTokenList(allowances.map((row) => row.token))
  return (
    <ManageCard
      id="manage-budget"
      title="Weekly budget"
      note="Hires within the weekly budget go ahead without asking. Bigger ones wait in Approvals."
    >
      {status.error !== null && status.error !== undefined ? (
        <p className="text-ui text-destructive-text">
          Weekly budget usage is unavailable; no remaining budget is assumed.
        </p>
      ) : status.data === undefined ? (
        <p className="text-sm text-muted-foreground">Reading the weekly budget…</p>
      ) : allowances.length === 0 ? (
        <p className="text-sm text-muted-foreground">No live weekly budget. Hires go to Approvals.</p>
      ) : (
        allowances.map((row) => {
          const limit = BigInt(row.limit)
          const used = BigInt(row.used)
          return (
            <Meter
              key={row.hash}
              value={limit === 0n ? 0 : Number((used * 10_000n) / limit) / 100}
              aria-label="Weekly budget used"
              className="gap-1.5"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-medium">
                  <TokenAmount value={row.left} token={row.token} /> left of{' '}
                  <TokenAmount value={row.limit} token={row.token} />
                </span>
                <span className="text-xs text-muted-foreground">
                  Resets {localTime(row.periodEnd)} · expires{' '}
                  {new Date(row.expiresAt * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                </span>
              </div>
            </Meter>
          )
        })
      )}
      {/* With no live budget the editor is the next step, so it starts open. */}
      <details className="group/details -mx-1 rounded-lg" open={status.data !== undefined && allowances.length === 0}>
        <summary className="inline-flex min-h-8 cursor-pointer list-none items-center rounded-md px-1 text-sm font-medium select-none pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
          {status.data !== undefined && allowances.length === 0
            ? 'Set a weekly budget'
            : 'Change or renew the weekly budget'}
        </summary>
        <div className="mt-3 px-1">
          <AllowanceEditor agent={agent} onConfirmed={onChanged} />
        </div>
      </details>
    </ManageCard>
  )
}

/** The agent wallet's balances, each movable to the operator's wallet. */
export function WalletEarnings({ agent, action }: { agent: ManagedAgent; action: AgentAction }) {
  const tokens = [...new Set(deployment.rewardTokens.concat(deployment.factory))]
  useTokenList(tokens)
  const reads = useReadContracts({
    contracts: tokens.map(
      (token) =>
        ({
          address: token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [agent.address as Address],
          chainId: chain.id,
        }) as const,
    ),
    query: { refetchInterval: 15000 },
  })
  return (
    <ManageCard title="Wallet & earnings" note="Earnings are held by the agent wallet until you move them.">
      <div className="grid">
        {tokens.map((token, index) => {
          const balance = reads.data?.[index]
          return (
            <div
              key={token}
              className="flex min-h-11 flex-wrap items-center justify-between gap-3 border-t border-border/70 py-1.5 first:border-t-0"
            >
              <span>
                {balance?.status === 'success' ? (
                  <TokenAmount value={balance.result} token={token} />
                ) : (
                  'Balance unavailable'
                )}
              </span>
              <Button
                variant="secondary"
                size="sm"
                busy={action.busy}
                disabled={reads.isError || balance?.status !== 'success' || balance.result === 0n}
                onClick={() => void action.execute('sweep_earnings', { token }, () => reads.refetch())}
              >
                Move earnings to my wallet
              </Button>
            </div>
          )
        })}
      </div>
      <SavedAction action={action} />
    </ManageCard>
  )
}

/** The position the agent owns itself (its own stake in the vault); operator backing is managed elsewhere. */
export function AgentOwnedBacking({
  agent,
  action,
  onBack,
}: {
  agent: ManagedAgent
  action: AgentAction
  onBack?: (() => void) | undefined
}) {
  const wallet = agent.address as Address
  const backingRead = useBacking(wallet, wallet)
  const now = useNow()
  const [unstake, setUnstake] = useState('')
  const backing = backingRead.data?.backing
  const position = backingRead.data?.position
  const stale = backingRead.isError
  const quantity = factoryAmount(unstake)
  const requestReady =
    !stale && position !== null && position !== undefined && quantity !== null && quantity <= position.activeValue
  const queued = position !== null && position !== undefined && position.queuedShares > 0n
  const leaving = queued && position.unlockAt > now
  const bonded = queued && backing !== undefined && backing.assets - position.queued < backing.reserved
  return (
    <ManageCard
      id="manage-backing"
      title="Agent-owned backing"
      note="Operator-funded backing belongs to the operator; only the agent-owned position can be left here."
    >
      <p className="text-sm">
        Total backing:{' '}
        {backing === undefined ? 'unavailable' : <TokenAmount value={backing.assets} token={deployment.factory} />}
      </p>
      {position === undefined || position === null || stale ? (
        <p className="text-sm text-muted-foreground">
          The agent-owned position is unavailable. Actions wait for current chain facts.
        </p>
      ) : (
        <>
          <p className="text-sm">
            Agent-owned position: <TokenAmount value={position.value} token={deployment.factory} />
          </p>
          {position.shares === 0n && (
            <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
              This agent does not own a position. Operator backing belongs to the operator wallet.
            </p>
          )}
          {queued && (
            <p role="status" className="rounded-lg bg-warning/14 p-3 text-sm text-warning-text">
              Leaving <TokenAmount value={position.queued} token={deployment.factory} static />.{' '}
              {leaving ? (
                <>
                  <Countdown to={position.unlockAt} /> remaining.
                </>
              ) : bonded ? (
                'Waiting for deposits at risk to clear.'
              ) : (
                'Ready to withdraw.'
              )}{' '}
              Queued shares stay exposed to slashes.
            </p>
          )}
          {position.activeShares > 0n && (
            <div className="grid gap-2">
              <AmountField
                label="Agent-owned amount to leave"
                value={unstake}
                onChange={setUnstake}
                token={deployment.factory}
                symbol="SIDE"
              />
              <Button
                className="w-fit"
                variant="secondary"
                busy={action.busy}
                disabled={!requestReady}
                onClick={() => void action.execute('request_unstake', { amount: unstake }, () => backingRead.refetch())}
              >
                Request leaving approval
              </Button>
            </div>
          )}
          {queued && (
            <Button
              variant="secondary"
              busy={action.busy}
              disabled={leaving || bonded}
              onClick={() => void action.execute('withdraw_stake', {}, () => backingRead.refetch())}
            >
              Withdraw agent-owned position
            </Button>
          )}
        </>
      )}
      {onBack !== undefined && (
        <Button variant="link" className="justify-self-start" onClick={onBack}>
          Back it from your own wallet
        </Button>
      )}
      <SavedAction action={action} />
    </ManageCard>
  )
}

/** How the agent connects: the start prompt to paste into a coding agent, and the MCP setup per coding client. */
export function Connection() {
  return (
    <section id="manage-connection" aria-label="Connection" className="grid scroll-mt-20 gap-2">
      <h2 className="px-1 text-ui font-medium text-muted-foreground">Connection</h2>
      <div className="grid gap-4">
        <StartPrompt />
        <ConnectionCard />
      </div>
    </section>
  )
}

export function GasBudgetCard({ agent, onChanged }: { agent: ManagedAgent; onChanged: () => void }) {
  return (
    <ManageCard id="manage-gas-budget" title="Gas budget">
      <GasAllowanceEditor key={agent.id} agent={agent} onConfirmed={onChanged} />
    </ManageCard>
  )
}
