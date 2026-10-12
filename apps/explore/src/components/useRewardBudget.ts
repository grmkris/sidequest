import { useRef, useState } from 'react'
import { isAddress, parseUnits } from 'viem'
import { agentAction } from '../agent-api.ts'
import { reviewAgentGrant } from '../agent-grant.ts'
import type { ManagedAgent } from '../api.ts'
import { browserAaRpc } from '../aa-request.ts'
import { prepareGasBudgetWallet, readPreparedGasBudget } from '../gas-allowance.ts'
import {
  afterOperatorSend,
  operatorRequest,
  readDisableJournal,
  reviewOperatorDisables,
  writeDisableJournal,
  type DisableJournal,
} from '../operator-disables.ts'
import { friendlyError } from '../txErrors.ts'
import { typedDataArgs } from '../typed-data.ts'
import { useToken } from '../useTokens.ts'
import { chain, deployment } from '../wallet.ts'
import { prompts, useSignTypedDataWithPrompt } from '../wallet-prompt.ts'
import { useDelegatorUpgrade } from './Privy.tsx'
import { useAuth } from './Wallet.tsx'
import { withWalletStepLock } from './txOperation.ts'

function savedBudget(key: string) {
  try {
    const intent = readDisableJournal(localStorage, key)
    if (intent !== null && intent.request.kind !== 'reward') throw new Error('Another action is saved.')
    return { intent, error: null }
  } catch {
    return { intent: null, error: 'The saved weekly-budget action is unreadable. Restore storage before continuing.' }
  }
}
function useRewardState(agent: ManagedAgent) {
  const { address: operator } = useAuth()
  const storageKey = `sidequest.reward-budget:${deployment.chainId}:${operator}:${agent.id}`
  const [initial] = useState(() => ({ ...savedBudget(storageKey), key: storageKey }))
  const saved = initial.intent?.request
  const [token, setToken] = useState<string>(saved?.kind === 'reward' ? saved.token : deployment.rewardTokens[0]!)
  const [amount, setAmount] = useState(saved?.kind === 'reward' ? saved.displayAmount : '25')
  const [intent, setIntent] = useState(initial.intent)
  const [review, setReview] = useState<ReturnType<typeof reviewAgentGrant> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(initial.error)
  const meta = useToken(token)
  const save = (next: DisableJournal | null) => {
    writeDisableJournal(localStorage, storageKey, next)
    setIntent(next)
  }
  return {
    agent,
    operator,
    storageKey,
    initial,
    token,
    setToken,
    amount,
    setAmount,
    intent,
    review,
    setReview,
    busy,
    setBusy,
    error,
    setError,
    meta,
    save,
  }
}
type RewardState = ReturnType<typeof useRewardState>

async function prepareReward(state: RewardState) {
  const { agent, operator, token, amount, meta } = state
  if (
    operator === undefined ||
    agent.address === null ||
    !isAddress(agent.address) ||
    !isAddress(token) ||
    meta === 'none' ||
    meta === 'reading'
  )
    throw new Error('Choose a readable token and use the operator wallet.')
  if (!/^\d+(?:\.\d+)?$/.test(amount) || (amount.split('.')[1]?.length ?? 0) > meta.decimals)
    throw new Error('Enter a positive amount within this token precision.')
  const units = parseUnits(amount, meta.decimals)
  if (units <= 0n || units >= 1n << 256n)
    throw new Error('Enter a positive weekly budget within the token amount range.')
  const current = readDisableJournal(localStorage, state.storageKey) ?? {
    key: crypto.randomUUID(),
    request: { kind: 'reward' as const, token, amount: units.toString(), displayAmount: amount },
    phase: 'prepare' as const,
    transactions: [],
  }
  if (
    current.request.kind !== 'reward' ||
    current.request.token.toLowerCase() !== token.toLowerCase() ||
    current.request.amount !== units.toString()
  )
    throw new Error('Reconcile the saved weekly budget before changing it.')
  state.save(current)
  const request = operatorRequest(current.request, current.key)
  const prepared = readPreparedGasBudget(await agentAction<unknown>(agent.id, request.action, request.body))
  const review = reviewAgentGrant(prepared, {
    kind: 'allowance',
    delegator: operator,
    agent: agent.address,
    token,
    amount: units,
  })
  const transactions = reviewOperatorDisables({
    deployment,
    operator,
    agent: agent.address,
    response: current.phase === 'send' ? current : prepared,
    hashes: prepared.previous,
  })
  state.save(
    current.phase === 'readback'
      ? current
      : { ...current, phase: transactions.length === 0 ? 'readback' : 'send', transactions },
  )
  state.setReview(review)
}

export function useRewardBudget(agent: ManagedAgent, onConfirmed: () => void) {
  const state = useRewardState(agent)
  const sign = useSignTypedDataWithPrompt()
  const upgrade = useDelegatorUpgrade(state.operator)
  const running = useRef(false)
  const run = async (action: () => Promise<void>) => {
    if (state.initial.error !== null || running.current) return
    running.current = true
    state.setBusy(true)
    state.setError(null)
    try {
      if (state.storageKey !== state.initial.key) throw new Error('The operator wallet changed. Reload to reconcile.')
      await withWalletStepLock(navigator.locks, state.storageKey, action)
    } catch (failure) {
      state.setError(friendlyError(failure))
    } finally {
      running.current = false
      state.setBusy(false)
    }
  }
  const sent = () =>
    run(async () => {
      const current = readDisableJournal(localStorage, state.storageKey)
      if (current === null) throw new Error('The weekly-budget journal is missing.')
      if (
        current.key !== state.intent?.key ||
        JSON.stringify(current.transactions) !== JSON.stringify(state.intent.transactions)
      )
        throw new Error('The weekly-budget journal changed. Reload to reconcile its original disables.')
      state.save(afterOperatorSend(current))
    })
  const confirm = () =>
    run(async () => {
      const current = readDisableJournal(localStorage, state.storageKey)
      if (
        current?.request.kind !== 'reward' ||
        current.phase !== 'readback' ||
        state.review === null ||
        state.operator === undefined
      )
        throw new Error('Finish the previous allowance disables before signing this budget.')
      if (current.key !== state.intent?.key) throw new Error('The budget journal changed. Reload to reconcile it.')
      await prepareGasBudgetWallet({
        deployment,
        operator: state.operator,
        node: browserAaRpc(chain.rpcUrls.default.http[0]!).node,
        upgrade,
      })
      const signature = await sign(
        typedDataArgs(state.review.typedData),
        prompts.weeklyBudget(
          agent.name,
          `${state.amount} ${state.meta === 'none' || state.meta === 'reading' ? 'tokens' : state.meta.symbol}`,
        ),
      )
      await agentAction(agent.id, 'allowance-confirm', { key: current.key, hash: state.review.hash, signature })
      state.save(null)
      state.setReview(null)
      onConfirmed()
    })
  const edit = () =>
    run(async () => {
      const current = readDisableJournal(localStorage, state.storageKey)
      if (current !== null && current.key !== state.intent?.key)
        throw new Error('The weekly-budget journal changed. Reload before editing.')
      if (current?.phase === 'send') throw new Error('Reconcile the original disable send before editing.')
      state.save(null)
      state.setReview(null)
    })
  return { ...state, prepare: () => run(() => prepareReward(state)), sent, confirm, edit }
}
