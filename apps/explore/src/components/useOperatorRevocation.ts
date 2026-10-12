import { useSigners } from '@privy-io/react-auth'
import { useRef, useState } from 'react'
import { isAddress } from 'viem'
import { agentAction } from '../agent-api.ts'
import type { ManagedAgent } from '../api.ts'
import {
  afterOperatorSend,
  operatorRequest,
  readDisableJournal,
  requirePermissionReadback,
  reviewOperatorDisables,
  writeDisableJournal,
  type DisableJournal,
  type OperatorRequest,
} from '../operator-disables.ts'
import { friendlyError } from '../txErrors.ts'
import { deployment } from '../wallet.ts'
import { useAuth } from './Wallet.tsx'
import { withWalletStepLock } from './txOperation.ts'

function savedAction(key: string) {
  try {
    return { intent: readDisableJournal(localStorage, key), error: null }
  } catch {
    return { intent: null, error: 'The saved permission action is unreadable. Restore storage before continuing.' }
  }
}

/** Stop provider access separately; it never proves on-chain revocation. */
async function removeAgentSigner(agent: ManagedAgent, remove: ReturnType<typeof useSigners>['removeSigners']) {
  await agentAction(agent.id, 'stop-access')
  if (agent.address === null) return null
  try {
    await remove({ address: agent.address })
    await agentAction(agent.id, 'signer-removed')
    return null
  } catch {
    return 'Hosted actions have stopped. Privy signer removal is unconfirmed; retry removal.'
  }
}

export function useOperatorRevocation(agent: ManagedAgent, onChanged: () => Promise<void>) {
  const { address: operator } = useAuth()
  const { removeSigners } = useSigners()
  const key = `sidequest.operator-revoke:${deployment.chainId}:${operator}:${agent.id}`
  const [initial] = useState(() => ({ ...savedAction(key), key }))
  const [intent, setIntent] = useState(initial.intent)
  const [error, setError] = useState<string | null>(initial.error)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const save = (next: DisableJournal | null) => {
    writeDisableJournal(localStorage, key, next)
    setIntent(next)
  }
  async function resolve(current: DisableJournal) {
    if (operator === undefined || agent.address === null || !isAddress(agent.address))
      throw new Error('Reconnect the operator wallet of this agent.')
    if (current.phase === 'send') return
    const signerError = current.request.kind === 'agent' ? await removeAgentSigner(agent, removeSigners) : null
    const request = operatorRequest(current.request, current.key)
    const response = await agentAction<unknown>(agent.id, request.action, request.body)
    const transactions = reviewOperatorDisables({
      deployment,
      operator,
      agent: agent.address,
      response,
      ...(current.request.kind === 'permission' ? { hashes: [current.request.permissionId] } : {}),
    })
    if (current.phase === 'readback' && transactions.length > 0)
      throw new Error('On-chain disablement is unconfirmed. Retry readback; the original send is retained.')
    if (transactions.length === 0 && current.request.kind === 'permission')
      requirePermissionReadback(response, current.request.permissionId)
    save(transactions.length === 0 ? null : { ...current, phase: 'send', transactions })
    setError(signerError)
    await onChanged()
  }
  async function run(action: () => Promise<void>) {
    if (initial.error !== null || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      if (key !== initial.key) throw new Error('The operator wallet changed. Reload before reconciling permissions.')
      await withWalletStepLock(navigator.locks, key, action)
    } catch (failure) {
      setError(friendlyError(failure))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  const begin = (request: OperatorRequest) =>
    run(async () => {
      const saved = readDisableJournal(localStorage, key)
      if (saved !== null && JSON.stringify(saved.request) !== JSON.stringify(request))
        throw new Error('Reconcile the saved revocation before starting another.')
      const current = saved ?? { key: crypto.randomUUID(), request, phase: 'prepare' as const, transactions: [] }
      save(current)
      await resolve(current)
    })
  const reconcile = () =>
    run(async () => {
      const saved = readDisableJournal(localStorage, key)
      if (saved === null) throw new Error('No saved revocation remains.')
      save(saved)
      await resolve(saved)
    })
  const sent = () =>
    run(async () => {
      const saved = readDisableJournal(localStorage, key)
      if (saved === null) throw new Error('The original permission journal is missing.')
      if (saved.key !== intent?.key || JSON.stringify(saved.transactions) !== JSON.stringify(intent.transactions))
        throw new Error('The permission journal changed. Reconcile its original send before readback.')
      const next = afterOperatorSend(saved)
      save(next)
      await resolve(next)
    })
  return { intent, error, busy, operator, begin, reconcile, sent }
}
