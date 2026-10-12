import { useId } from 'react'
import type { ManagedAgent } from '../api.ts'
import { formatNumber, localTime } from '../format.ts'
import { TxSteps } from './TxSteps.tsx'
import { useAuth } from './Wallet.tsx'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Button } from './ui/button.tsx'
import { Input } from './ui/input.tsx'
import { useGasBudget } from './useGasBudget.ts'

type Budget = ReturnType<typeof useGasBudget>

/** Gas is a separate operator allowance; it never changes the agent's job-reward budget. */
export function GasAllowanceEditor(props: { agent: ManagedAgent; onConfirmed: () => void }) {
  const { address } = useAuth()
  return <GasBudgetForm key={`${props.agent.id}:${address}`} {...props} />
}
function GasBudgetForm({ agent, onConfirmed }: { agent: ManagedAgent; onConfirmed: () => void }) {
  const budget = useGasBudget(agent, onConfirmed)
  const inputId = useId()
  const hasLive = (budget.status.data?.gasAllowances ?? []).some(
    (row) => row.status === 'live' && row.expiresAt > Date.now() / 1000,
  )
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        USDC your agent may pull from your wallet for gas, separate from job rewards. The chain enforces the weekly cap.
        You can change or revoke it.
      </p>
      <GasBudgetStatus budget={budget} hasLive={hasLive} />
      <label htmlFor={inputId} className="grid gap-1 text-sm">
        <span>Gas budget · USDC per week</span>
        <Input
          id={inputId}
          aria-label="Gas budget in USDC per week"
          inputMode="decimal"
          value={budget.amount}
          disabled={budget.intent !== null || budget.busy}
          onChange={(event) => budget.setAmount(event.target.value)}
        />
      </label>
      <GasBudgetAction budget={budget} hasLive={hasLive} />
      {budget.error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{budget.error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
function GasBudgetStatus({ budget, hasLive }: { budget: Budget; hasLive: boolean }) {
  if (budget.status.isError) return <p role="alert">Gas budget usage is unavailable.</p>
  if (budget.status.isPending) return <p>Reading the gas budget…</p>
  return (
    <>
      {!hasLive && <p>Add a gas budget so this agent can act.</p>}
      {(budget.status.data?.gasAllowances ?? []).map((row) => (
        <div key={row.hash} className="grid gap-1 text-sm">
          <p>
            {formatNumber(BigInt(row.left), 6)} USDC left of {formatNumber(BigInt(row.limit), 6)} · {row.status}
          </p>
          <p className="text-xs text-muted-foreground">
            Resets {localTime(row.periodEnd)} · expires {localTime(row.expiresAt)}
          </p>
          {row.status !== 'disabled' && row.expiresAt > Date.now() / 1000 && (
            <Button
              variant="destructive"
              disabled={budget.intent !== null}
              busy={budget.busy}
              onClick={() => void budget.revoke(row.hash)}
            >
              Revoke gas budget
            </Button>
          )}
        </div>
      ))}
    </>
  )
}
function GasBudgetAction({ budget, hasLive }: { budget: Budget; hasLive: boolean }) {
  if (budget.transactions.length > 0)
    return (
      <>
        <p className="text-sm">Send the permission disable from your wallet. You pay its gas in USDC, or MON.</p>
        <TxSteps
          taskId={`gas-budget-disable:${budget.agent.id}:${budget.intent?.kind === 'grant' ? budget.intent.key : budget.intent?.hash}`}
          txs={budget.transactions}
          owner={budget.operator}
          reportToBoard={false}
          onDone={() => void budget.disablesDone()}
        />
      </>
    )
  if (budget.review !== null)
    return (
      <>
        <p className="font-medium">
          Up to {budget.amount} USDC per fixed week, for {budget.agent.name}'s gas only.
        </p>
        <Button busy={budget.busy} onClick={() => void budget.confirm()}>
          Sign gas budget
        </Button>
      </>
    )
  return (
    <Button
      busy={budget.busy}
      disabled={budget.status.isPending || budget.status.isError || budget.initial.error !== null}
      onClick={() => void budget.prepare()}
    >
      {budget.intent !== null ? 'Reconcile gas budget' : hasLive ? 'Change gas budget' : 'Add a gas budget'}
    </Button>
  )
}
