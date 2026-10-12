import { Button } from './ui/button.tsx'
import { Input } from './ui/input.tsx'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Select } from './kit.tsx'
import { isAddress } from 'viem'
import type { ManagedAgent } from '../api.ts'
import { explorer } from '../wallet.ts'
import { rewardTokenList } from '../format.ts'
import { AgentGrantReview } from './AgentGrantReview.tsx'
import { useAuth } from './Wallet.tsx'
import { TxSteps } from './TxSteps.tsx'
import { useRewardBudget } from './useRewardBudget.ts'

import { OperatorBalances } from './OperatorBalances.tsx'
import { AmountField } from './money/AmountField.tsx'

export function AllowanceEditor({ agent, onConfirmed }: { agent: ManagedAgent; onConfirmed: () => void }) {
  const { address } = useAuth()
  return <RewardBudgetForm key={`${agent.id}:${address}`} agent={agent} onConfirmed={onConfirmed} />
}

function RewardBudgetForm({ agent, onConfirmed }: { agent: ManagedAgent; onConfirmed: () => void }) {
  const budget = useRewardBudget(agent, onConfirmed)
  const { review, operator, token, error } = budget
  return (
    <div className="grid gap-3 border-t border-border pt-4">
      <h3 className="font-semibold">Weekly budget</h3>
      <OperatorBalances operator={operator} token={token} />
      <p className="text-sm text-muted-foreground">
        The most your agent may pull from your wallet each week to hire other agents; anything above it becomes an
        Approval for you.
      </p>
      {review === null ? <BudgetInputs budget={budget} /> : <BudgetReview budget={budget} agent={agent} />}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}

type RewardBudget = ReturnType<typeof useRewardBudget>

function BudgetInputs({ budget }: { budget: RewardBudget }) {
  const { amount, setAmount, token, setToken, meta, intent, busy } = budget
  const readable = meta !== 'none' && meta !== 'reading'
  const symbol = readable ? meta.symbol : 'token information unavailable'
  return (
    <>
      <div className="grid gap-1 text-sm">
        <label>
          <span className="sr-only">Token jobs are paid in</span>
          <Select
            aria-label="Token jobs are paid in"
            value={token.toLowerCase()}
            disabled={intent !== null || busy}
            onChange={(event) => {
              setToken(event.target.value)
            }}
          >
            {rewardTokenList().map(([address, info]) => (
              <option key={address} value={address}>
                {info.symbol} ·{' '}
                {info.name === 'Mock USD (testnet)'
                  ? 'test dollars jobs are paid in'
                  : (info.name ?? 'jobs are paid in this token')}
              </option>
            ))}
            {isAddress(token) && !rewardTokenList().some(([address]) => address === token.toLowerCase()) && (
              <option value={token.toLowerCase()}>{symbol}</option>
            )}
          </Select>
        </label>
        {isAddress(token) && (
          <a
            className="text-xs text-muted-foreground underline"
            href={explorer('address', token)}
            target="_blank"
            rel="noreferrer"
          >
            View token contract
          </a>
        )}
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Use another token</summary>
          <Input
            aria-label="Other budget token address"
            value={token}
            disabled={intent !== null || busy}
            onChange={(event) => {
              setToken(event.target.value)
            }}
          />
        </details>
      </div>

      <AmountField
        label="Weekly budget"
        value={amount}
        disabled={intent !== null || busy}
        onChange={setAmount}
        token={isAddress(token) ? token : null}
        {...(readable
          ? { symbol: meta.symbol }
          : { symbol: '—', hint: 'Token information unavailable', tone: 'warning' as const })}
      />

      <Button busy={busy} disabled={!readable || budget.initial.error !== null} onClick={() => void budget.prepare()}>
        {intent === null ? 'Review budget' : 'Reconcile weekly budget'}
      </Button>
    </>
  )
}

function BudgetReview({ budget, agent }: { budget: RewardBudget; agent: ManagedAgent }) {
  const { amount, meta, review, operator, intent, busy } = budget
  if (review === null) return null
  const symbol = meta === 'none' || meta === 'reading' ? 'tokens' : meta.symbol
  return (
    <>
      <p className="font-semibold">
        {amount} {symbol} per fixed week
      </p>

      <AgentGrantReview description={review.description} />

      {intent?.phase === 'send' && (
        <>
          <p className="text-sm text-muted-foreground">
            Disable the previous weekly budget from your wallet before activating this replacement.
          </p>
          <TxSteps
            taskId={`allowance-disable:${agent.id}:${intent.key}`}
            txs={[...intent.transactions]}
            owner={operator}
            reportToBoard={false}
            onDone={() => void budget.sent()}
          />
        </>
      )}

      <Button busy={busy} disabled={intent?.phase !== 'readback'} onClick={() => void budget.confirm()}>
        Sign budget
      </Button>

      <Button variant="link" disabled={busy || intent?.phase === 'send'} onClick={() => void budget.edit()}>
        Edit budget
      </Button>
    </>
  )
}
