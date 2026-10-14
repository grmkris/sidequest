import * as sdk from '@sidequest/sdk'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useConnection, useSwitchChain } from 'wagmi'
import { getTransactionReceipt } from 'wagmi/actions'
import { browserAaRpc, browserPaymentMode } from '../aa-request.ts'
import { BrowserUserOp, type UserOpDependencies, type UserOpView } from '../aa-controller.ts'
import { atomicRefusal, ceilingRefusal, paymentRefusal, paymentRoute, userOpCostCopy } from '../aa-mode.ts'
import { boardApi } from '../api.ts'
import { batchGasLimit } from '../gas.ts'
import { sidequest } from '../sidequest.ts'
import { friendlyError } from '../txErrors.ts'
import { chain, deployment, wagmiConfig, writesOpen } from '../wallet.ts'
import { useSignTypedDataWithPrompt } from '../wallet-prompt.ts'
import { useDelegatorAuthorization } from './Privy.tsx'
import { MonTxSteps, type TxStepsProps } from './TxSteps.tsx'
import { LaunchNotice } from './LaunchGate.tsx'
import { TxLink } from './kit.tsx'
import {
  emptyJournal,
  readTxJournal,
  readTxJournalDurable,
  txJournalKey,
  writeTxJournal,
  writeTxJournalDurable,
} from './txJournal.ts'
import { withWalletAccountLock, withWalletStepLock } from './txOperation.ts'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Button } from './ui/button.tsx'

const rpc = browserAaRpc(chain.rpcUrls.default.http[0]!)

function savedJournal(key: string) {
  try {
    return { record: readTxJournal(localStorage, key), error: null }
  } catch (failure) {
    return { record: emptyJournal(), error: friendlyError(failure) }
  }
}
function hasLegacySend(record: ReturnType<typeof readTxJournal>): boolean {
  return (
    record !== null &&
    (record.pending !== null || record.hashes.some((hash) => hash !== null) || record.sponsor != null)
  )
}
export function BrowserTxSteps(props: TxStepsProps) {
  const { address } = useConnection()
  const authorize = useDelegatorAuthorization(address)
  const key = txJournalKey(props.taskId, props.txs)
  const [saved] = useState(() => savedJournal(key))
  const legacy = hasLegacySend(saved.record)
  const mode = useQuery({
    queryKey: ['gas-payment-mode', chain.id, address, key, authorize !== null],
    queryFn: () =>
      browserPaymentMode(rpc, deployment, address!, props.txs, {
        canAuthorize: authorize !== null,
        sponsor: props.sponsor === 'faucet',
      }),
    enabled: writesOpen && address !== undefined && !legacy && saved.record?.aa == null && saved.error === null,
    staleTime: 0,
    retry: false,
  })
  if (!writesOpen) return <LaunchNotice />
  if (saved.error !== null)
    return (
      <Alert variant="destructive">
        <AlertDescription>{saved.error}</AlertDescription>
      </Alert>
    )
  if (address === undefined) return <p>Connect a wallet to send this action.</p>
  return (
    <SelectedPayment
      props={props}
      address={address}
      savedAa={saved.record?.aa != null}
      legacy={legacy}
      mode={mode.data}
      pending={mode.isPending}
      error={mode.error}
    />
  )
}

function SelectedPayment({
  props,
  address,
  savedAa,
  legacy,
  mode,
  pending,
  error,
}: {
  props: TxStepsProps
  address: string
  savedAa: boolean
  legacy: boolean
  mode: import('../aa-mode.ts').PaymentMode | undefined
  pending: boolean
  error: Error | null
}) {
  const route = paymentRoute({ savedAa, legacy, mode, requireAtomic: props.requireAtomic === true })
  // A saved operation keeps the lane in its record; `payment` only opens a new one.
  if (route === 'userop' || route === 'userop-native')
    return (
      <UserOpSteps
        key={`${txJournalKey(props.taskId, props.txs)}:${address}`}
        {...props}
        payment={route === 'userop-native' ? 'native' : 'token'}
      />
    )
  if (route === 'atomic-refused') return <p role="alert">{atomicRefusal(deployment.aa)}</p>
  if (route === 'mon')
    return <MonTxSteps {...props} allowBatch={props.allowBatch !== false && (legacy || mode === 'mon-batch')} />
  if (pending) return <p className="text-sm text-muted-foreground">Reading USDC and MON for gas…</p>
  return <PaymentUnavailable error={error} mode={mode ?? 'unfunded'} />
}

function PaymentUnavailable({ error, mode }: { error: Error | null; mode: import('../aa-mode.ts').PaymentMode }) {
  return (
    <Alert variant="destructive">
      <AlertDescription>
        {error === null ? paymentRefusal(mode) : friendlyError(error)}
        {chain.id === 10143 && (
          <a href="https://faucet.circle.com" target="_blank" rel="noreferrer" className="ml-1 underline">
            Get USDC from Circle's faucet (Monad Testnet).
          </a>
        )}
      </AlertDescription>
    </Alert>
  )
}

/** A user operation's props: the lane a new action opens in (`native` pays gas in MON, with no paymaster). */
type OpProps = TxStepsProps & { payment?: 'token' | 'native' }

function useWalletForOp(props: OpProps) {
  const { address, chainId } = useConnection()
  const authorize = useDelegatorAuthorization(address)
  const sign = useSignTypedDataWithPrompt()
  return { address, chainId, authorize, sign, props }
}

type OpWallet = ReturnType<typeof useWalletForOp>

async function walletGuard(wallet: OpWallet, sender: string) {
  if (
    !writesOpen ||
    wallet.props.canSend === false ||
    wallet.chainId !== chain.id ||
    wallet.address?.toLowerCase() !== sender.toLowerCase()
  )
    throw new Error('The selected wallet or network changed. Nothing was sent.')
  if (wallet.props.owner !== undefined && wallet.props.owner.toLowerCase() !== sender.toLowerCase())
    throw new Error('Use the wallet that owns this action.')
  const reason = await wallet.props.sendGuard?.()
  if (reason) throw new Error(reason)
}

function opDependencies(
  wallet: OpWallet,
  latest: () => OpWallet,
  changed: (view: UserOpView) => void,
): UserOpDependencies {
  const { props, address } = wallet
  if (address === undefined) throw new Error('Connect the action wallet first.')
  const key = txJournalKey(props.taskId, props.txs)
  return {
    rpc,
    deployment,
    sender: address,
    txs: props.txs,
    sponsor: props.sponsor,
    payment: props.payment,
    minCallGas: batchGasLimit(props.txs, sidequest),
    read: () =>
      props.durableJournal
        ? readTxJournalDurable(localStorage, key, props.requireJournal)
        : Promise.resolve(readTxJournal(localStorage, key, props.requireJournal)),
    write: async (next) => {
      if (props.durableJournal) await writeTxJournalDurable(localStorage, key, next)
      else writeTxJournal(localStorage, key, next)
    },
    guard: () => walletGuard(latest(), address),
    authorize: async () => latest().authorize?.(),
    sign: (typedData, description) =>
      latest().sign(typedData, { title: 'Send this action', description, buttonText: 'Send' }),
    report: async (hash) => {
      if (props.reportToBoard !== false)
        await boardApi(props.boardId).tool('report_transaction', { taskId: props.taskId, txHash: hash })
    },
    verify: async (hash) => {
      const receipt = await getTransactionReceipt(wagmiConfig, { hash, chainId: chain.id })
      const reason = latest().props.receiptGuard?.(receipt, props.txs)
      if (reason) throw new Error(reason)
    },
    done: (hash) => latest().props.onDone([hash]),
    changed,
  }
}

function useUserOp(props: OpProps) {
  const wallet = useWalletForOp(props)
  const current = useRef(wallet)
  current.current = wallet
  const key = txJournalKey(props.taskId, props.txs)
  const [view, setView] = useState<UserOpView>({ record: null, built: null, pending: false, ready: false })
  const [controller] = useState(() => new BrowserUserOp(opDependencies(wallet, () => current.current, setView)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const run = async (action: () => Promise<string | void>) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await withWalletStepLock(navigator.locks, key, action)
    } catch (failure) {
      setError(
        failure instanceof sdk.AaError && failure.code === 'ceiling'
          ? ceilingRefusal(controller.payment === 'native', deployment.aa)
          : friendlyError(failure),
      )
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  useEffect(() => {
    void run(async () => {
      await controller.load()
      if (props.autoStart && current.current.chainId === chain.id) await controller.prepare()
    })
  }, [])
  useEffect(() => {
    props.onBusyChange?.(busy || view.pending)
    props.onSafeToRestartChange?.(!view.pending && view.record?.aa?.built === undefined)
  }, [busy, view.pending, view.record?.aa?.built])
  // A reverted operation is over, as a reverted transaction is in MonTxSteps: tell the caller, which may start afresh.
  const reverted = view.record?.aa?.receipt?.status === 'reverted' ? view.record.aa.receipt.txHash : null
  useEffect(() => {
    if (reverted !== null) props.onFailure?.('The user operation reverted. Gas was charged; none of these steps ran.')
  }, [reverted])
  const submit = async () => {
    await withWalletAccountLock(navigator.locks, chain.id, wallet.address!, async () => {
      if (view.built === null) await controller.prepare()
      else if (view.pending) await controller.reconcile()
      else await controller.send()
    })
  }
  return { view, busy, error, run, submit, wallet }
}

function UserOpSteps(props: OpProps) {
  const { view, busy, error, run, submit, wallet } = useUserOp(props)
  const { mutateAsync: switchChain } = useSwitchChain()
  if (!writesOpen) return <LaunchNotice />
  if (wallet.chainId !== chain.id)
    return (
      <Button
        onClick={() =>
          void run(async () => {
            await switchChain({ chainId: chain.id })
          })
        }
      >
        Switch your wallet to {chain.name}
      </Button>
    )
  const label = view.pending
    ? 'Check the saved action'
    : view.built === null
      ? 'Review gas cost'
      : 'Confirm in your wallet'
  return (
    <div className="grid gap-3">
      {props.presentation !== 'inline' && (
        <ol className="grid gap-2">
          {props.txs.map((tx, index) => (
            <li key={`${index}:${tx.to}:${tx.data}`}>{tx.description}</li>
          ))}
        </ol>
      )}
      {view.built !== null && (
        <p className="text-sm text-muted-foreground">
          {props.sponsor === 'faucet' ? 'No MON needed. Faucet gas is covered on testnet.' : userOpCostCopy(view.built)}
        </p>
      )}
      {view.record?.aa?.receipt !== undefined && <TxLink hash={view.record.aa.receipt.txHash} />}
      {view.record?.recorded[0] !== true && (
        <Button busy={busy} disabled={!view.ready || props.canSend === false} onClick={() => void run(submit)}>
          {label}
        </Button>
      )}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
