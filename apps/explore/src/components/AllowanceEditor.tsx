import { Button } from './ui/button.tsx'
import { Input } from './ui/input.tsx'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Select } from './kit.tsx'
import { useState } from 'react'
import { type Address, parseUnits, isAddress } from 'viem'
import { prompts, useSignTypedDataWithPrompt } from '../wallet-prompt.ts'
import type { ManagedAgent } from '../api.ts'
import { agentAction } from '../agent-api.ts'
import { reviewAgentGrant, type PreparedGrant } from '../agent-grant.ts'
import { typedDataArgs } from '../typed-data.ts'
import { deployment, explorer } from '../wallet.ts'
import { useToken } from '../useTokens.ts'
import { rewardTokenList, tokenMeta } from '../format.ts'
import { AgentGrantReview } from './AgentGrantReview.tsx'
import { useAuth } from './Wallet.tsx'

import { OperatorBalances } from './OperatorBalances.tsx'
import { AmountField } from './money/AmountField.tsx'

export function AllowanceEditor({ agent, onConfirmed }: { agent: ManagedAgent; onConfirmed: () => void }) {
  const { address: operator } = useAuth()
  const [amount, setAmount] = useState('25')
  const [token, setToken] = useState<string>(deployment.rewardTokens[0]!)
  const meta = useToken(token)
  const [key, setKey] = useState(() => crypto.randomUUID())
  const [review, setReview] = useState<ReturnType<typeof reviewAgentGrant> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const signTypedDataAsync = useSignTypedDataWithPrompt()
  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Weekly budget is unavailable')
    } finally {
      setBusy(false)
    }
  }
  async function prepare() {
    if (
      operator === undefined ||
      agent.address === null ||
      !isAddress(token) ||
      typeof meta !== 'object' ||
      !/^\d+(?:\.\d+)?$/.test(amount)
    )
      throw new Error('Choose a readable token and a positive amount')
    const units = parseUnits(amount, meta.decimals)
    if (units <= 0n || (amount.split('.')[1]?.length ?? 0) > meta.decimals)
      throw new Error('The amount exceeds this token precision')
    const prepared = await agentAction<PreparedGrant>(agent.id, 'allowance-prepare', {
      key,
      token,
      amount: units.toString(),
    })
    setReview(
      reviewAgentGrant(prepared, {
        kind: 'allowance',
        delegator: operator,
        agent: agent.address as Address,
        token,
        amount: units,
      }),
    )
  }
  async function confirm() {
    if (review === null) return
    const signature = await signTypedDataAsync(
      typedDataArgs(review.typedData),
      prompts.weeklyBudget(agent.name, `${amount} ${tokenMeta(token)?.symbol ?? 'tokens'}`),
    )
    await agentAction(agent.id, 'allowance-confirm', { key, hash: review.hash, signature })
    setReview(null)
    setKey(crypto.randomUUID())
    onConfirmed()
  }
  return (
    <div className="grid gap-3 border-t border-border pt-4">
      <h3 className="font-semibold">Weekly budget</h3>
      <OperatorBalances operator={operator} token={token} />
      <p className="text-sm text-muted-foreground">
        The most your agent may pull from your wallet each week to hire other agents; anything above it becomes an
        Approval for you.
      </p>
      {review === null ? (
        <>
          <div className="grid gap-1 text-sm">
            <label>
              <span className="sr-only">Token jobs are paid in</span>
              <Select
                aria-label="Token jobs are paid in"
                value={token.toLowerCase()}
                onChange={(event) => {
                  setToken(event.target.value)
                  setKey(crypto.randomUUID())
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
                  <option value={token.toLowerCase()}>{typeof meta === 'object' ? meta.symbol : 'Custom token'}</option>
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
                onChange={(event) => {
                  setToken(event.target.value)
                  setKey(crypto.randomUUID())
                }}
              />
            </details>
          </div>

          <AmountField
            label="Weekly budget"
            value={amount}
            onChange={(next) => {
              setAmount(next)
              setKey(crypto.randomUUID())
            }}
            token={isAddress(token) ? token : null}
            {...(typeof meta === 'object'
              ? { symbol: meta.symbol }
              : { symbol: '—', hint: 'Token information unavailable', tone: 'warning' as const })}
          />

          <Button busy={busy} disabled={typeof meta !== 'object'} onClick={() => void run(prepare)}>
            Review budget
          </Button>
        </>
      ) : (
        <>
          <p className="font-semibold">
            {amount} {typeof meta === 'object' ? meta.symbol : ''} per fixed week
          </p>

          <AgentGrantReview description={review.description} />

          <Button busy={busy} onClick={() => void run(confirm)}>
            Sign budget
          </Button>

          <Button
            variant="link"
            disabled={busy}
            onClick={() => {
              setReview(null)
              setKey(crypto.randomUUID())
            }}
          >
            Edit budget
          </Button>
        </>
      )}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
