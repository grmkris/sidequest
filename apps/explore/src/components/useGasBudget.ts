import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { isAddress } from 'viem'
import { agentAction, agentStatus } from '../agent-api.ts'
import type { ManagedAgent } from '../api.ts'
import {
  gasBudgetAmount,
  parseGasBudgetIntent,
  gasBudgetDisables,
  readGasBudgetIntent,
  readPreparedGasBudget,
  readRevokedGasBudget,
  reviewGasBudget,
  writeGasBudgetIntent,
  type GasBudgetIntent,
  type PreparedGasBudget,
} from '../gas-allowance.ts'
import { friendlyError } from '../txErrors.ts'
import { deployment } from '../wallet.ts'
import { prompts, useSignTypedDataWithPrompt } from '../wallet-prompt.ts'
import { typedDataArgs } from '../typed-data.ts'
import { useDelegatorUpgrade } from './Privy.tsx'
import { useAuth } from './Wallet.tsx'
import { withWalletStepLock, type WalletStep } from './txOperation.ts'

function initialIntent(key: string) {
  try {
    return { intent: readGasBudgetIntent(localStorage, key), error: null }
  } catch {
    return {
      intent: null,
      error: 'The saved gas-budget action is unreadable. Restore browser storage before continuing.',
    }
  }
}
function useGasBudgetState(agent: ManagedAgent, onConfirmed: () => void) {
  const { address: operator, signedIn } = useAuth()
  const storageKey = `sidequest.gas-budget:${deployment.chainId}:${operator}:${agent.id}`
  const [initial] = useState(() => initialIntent(storageKey))
  const [intent, setIntent] = useState(initial.intent)
  const [amount, setAmount] = useState(initial.intent?.kind === 'grant' ? initial.intent.amount : '5')
  const [review, setReview] = useState<ReturnType<typeof reviewGasBudget> | null>(null)
  const [transactions, setTransactions] = useState<WalletStep[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(initial.error)
  const status = useQuery({
    queryKey: ['gas-budget-status', operator, agent.id],
    queryFn: () => agentStatus(agent.id),
    enabled: signedIn,
    retry: false,
    refetchInterval: 15_000,
  })
  const save = (next: GasBudgetIntent | null) => {
    writeGasBudgetIntent(localStorage, storageKey, next)
    setIntent(next)
  }
  async function finish() {
    save(null)
    setReview(null)
    setTransactions([])
    await status.refetch()
    onConfirmed()
  }
  return {
    agent,
    operator,
    storageKey,
    initial,
    intent,
    amount,
    setAmount,
    review,
    setReview,
    transactions,
    setTransactions,
    busy,
    setBusy,
    error,
    setError,
    status,
    save,
    finish,
  }
}
type BudgetState = ReturnType<typeof useGasBudgetState>

async function resolveIntent(state: BudgetState, intent: GasBudgetIntent) {
  const { agent, operator } = state
  if (operator === undefined || agent.address === null || !isAddress(agent.address))
    throw new Error('Use the operator wallet of an active agent.')
  if (intent.kind === 'revoke') {
    const result = readRevokedGasBudget(await agentAction(agent.id, 'gas-allowance-revoke', { hash: intent.hash }))
    if (result.hash !== intent.hash) throw new Error('The revoked gas budget differs from the request.')
    if (result.status === 'disabled' && result.transactions.length === 0) return state.finish()
    const txs = gasBudgetDisables(deployment, operator, [intent.hash], result.transactions)
    state.setTransactions(txs)
    return
  }
  const prepared = readPreparedGasBudget(
    await agentAction<PreparedGasBudget>(agent.id, 'gas-allowance-edit', {
      key: intent.key,
      amount: gasBudgetAmount(intent.amount).toString(),
      periodSeconds: 604800,
    }),
  )
  const review = reviewGasBudget({
    deployment,
    prepared,
    operator,
    agent: agent.address,
    amount: gasBudgetAmount(intent.amount),
  })
  const transactions = gasBudgetDisables(deployment, operator, prepared.previous, prepared.transactions)
  state.setReview(review)
  state.setTransactions(transactions)
}

function useGasBudgetActions(state: BudgetState) {
  const sign = useSignTypedDataWithPrompt()
  const upgrade = useDelegatorUpgrade(state.operator)
  const run = async (action: () => Promise<void>) => {
    if (state.initial.error !== null) return
    state.setBusy(true)
    state.setError(null)
    try {
      await withWalletStepLock(navigator.locks, state.storageKey, action)
    } catch (failure) {
      state.setError(friendlyError(failure))
    } finally {
      state.setBusy(false)
    }
  }
  const begin = (intent: GasBudgetIntent) =>
    run(async () => {
      const saved = readGasBudgetIntent(localStorage, state.storageKey)
      if (saved !== null && JSON.stringify(saved) !== JSON.stringify(intent))
        throw new Error('Reconcile the saved gas-budget action before starting another.')
      if (intent.kind === 'grant') gasBudgetAmount(intent.amount)
      state.save(intent)
      await resolveIntent(state, intent)
    })
  const prepare = () => begin(state.intent ?? { kind: 'grant', key: crypto.randomUUID(), amount: state.amount })
  const revoke = (hash: string) => {
    return run(async () => {
      const intent = parseGasBudgetIntent({ kind: 'revoke', hash })
      const saved = readGasBudgetIntent(localStorage, state.storageKey)
      if (saved !== null) throw new Error('Reconcile the saved gas-budget action before revoking another.')
      state.save(intent)
      await resolveIntent(state, intent)
    })
  }
  const confirm = () =>
    run(async () => {
      const { intent, review } = state
      if (intent?.kind !== 'grant' || review === null || state.transactions.length !== 0) return
      const saved = readGasBudgetIntent(localStorage, state.storageKey)
      if (JSON.stringify(saved) !== JSON.stringify(intent))
        throw new Error('The gas-budget journal changed. Reload to reconcile it.')
      await upgrade?.()
      const signature = await sign(typedDataArgs(review.typedData), prompts.gasBudget(state.agent.name, intent.amount))
      await agentAction(state.agent.id, 'gas-allowance-confirm', { key: intent.key, hash: review.hash, signature })
      await state.finish()
    })
  const disablesDone = () =>
    run(async () => {
      state.setTransactions([])
      if (state.intent?.kind === 'revoke') await resolveIntent(state, state.intent)
    })
  return { prepare, revoke, confirm, disablesDone }
}

export function useGasBudget(agent: ManagedAgent, onConfirmed: () => void) {
  const state = useGasBudgetState(agent, onConfirmed)
  return { ...state, ...useGasBudgetActions(state) }
}
