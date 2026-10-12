import { Alert, AlertDescription } from './ui/alert.tsx'
import { LoadingRows } from './kit.tsx'
import * as sdk from '@sidequest/sdk'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { useEffect, useState } from 'react'
import { type Address, encodeFunctionData, erc20Abi, parseSignature } from 'viem'
import { useBalance } from 'wagmi'
import { prompts, useSignTypedDataWithPrompt } from '../wallet-prompt.ts'
import { type ManagedAgent, agentEndpoint } from '../api.ts'
import { DelegationForm, exactFactory } from './DelegationForm.tsx'
import { DELEGATION_RISK, DelegationPositions, factoryValue, walletAgentsKey } from './DelegationPositions.tsx'
import { HoldingControls } from './HoldingControls.tsx'
import { GasWarning } from './GasWarning.tsx'
import { AgentFormSheet, BackingSheets, PositionsUnavailable, useReveal } from './backing/AccountBacking.tsx'
import { BackingOverview } from './backing/BackingOverview.tsx'
import { emptyJournal, txJournalKey, writeTxJournalDurable } from './txJournal.ts'

import { useDelegations, useIndexedBacking } from '../delegation-query.ts'
import { useDirectory } from '../directory-query.ts'
import { type SidequestContracts, sidequest } from '../sidequest.ts'
import { stakeContext } from '../stake-context.ts'
import { factoryAmount } from '../stake.ts'
import { friendlyError } from '../txErrors.ts'
import { positionLabel } from '../position-label.ts'
import { backableAgents } from '../backing-agents.ts'
import { chain, deployment, writesOpen } from '../wallet.ts'
import {
  InterruptedVaultPreparation,
  type VaultIntent as Operation,
  readVaultIntent,
  readVaultIntentDurable,
  withVaultPermitPreparation,
  writeVaultIntent,
  vaultIntentKey,
  withVaultIntentLock,
} from '../vault-lock.ts'
import { VaultPreparationRecovery } from './VaultPreparationRecovery.tsx'
import { ConfirmPosition } from './backing/ConfirmPosition.tsx'

/** An agent's backing form in a sheet the page opens: the page keeps only the confirm step once a form is sent. */
export interface BackingSheet {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function BackingManager({
  owner,
  scope = { kind: 'account' },
  sheet,
  initialAmount,
}: {
  owner: Address
  scope?: { kind: 'account' } | { kind: 'agent'; account: Address; agentId?: string }
  /** Agent scope only: the form opens in this sheet instead of inline. */
  sheet?: BackingSheet
  /** SIDE to fill the amount with, e.g. an agent's shortfall from a `?back=` link. */
  initialAmount?: string | undefined
}) {
  return (
    <Stake
      key={`${owner}:${scope.kind === 'agent' ? scope.account : 'account'}`}
      contracts={sidequest}
      owner={owner}
      initialAccount={scope.kind === 'agent' ? scope.account : undefined}
      scope={scope}
      sheet={scope.kind === 'agent' ? sheet : undefined}
      initialAmount={initialAmount}
    />
  )
}

function Stake({
  contracts,
  owner,
  initialAccount,
  scope,
  sheet: agentSheet,
  initialAmount,
}: {
  contracts: SidequestContracts
  owner: Address
  initialAccount: Address | undefined
  scope: { kind: 'account' } | { kind: 'agent'; account: Address; agentId?: string }
  sheet: BackingSheet | undefined
  initialAmount: string | undefined
}) {
  const queryClient = useQueryClient()
  const reads = useDelegations(contracts, owner)
  const mon = useBalance({ address: owner, chainId: chain.id, query: { refetchInterval: 15_000 } })
  const directory = useDirectory()
  const managed = useQuery({
    queryKey: ['managed-agents', owner.toLowerCase()],
    queryFn: () => agentEndpoint<{ agents: ManagedAgent[] }>('/api/agents'),
    refetchInterval: 30_000,
  })
  const [account, setAccount] = useState<Address>(initialAccount ?? owner)
  const selected = useIndexedBacking(account, owner)
  const [mode, setMode] = useState<'add' | 'leave'>('add')
  // On Account the form and the agent picker open in a sheet; on an agent's page the form stays inline.
  const [sheet, setSheet] = useState<'form' | 'pick' | null>(null)
  const openForm = (target: Address, next: 'add' | 'leave' = 'add') => {
    setAccount(target)
    setMode(next)
    setSheet('form')
  }
  const [text, setText] = useState(initialAmount ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [interrupted, setInterrupted] = useState<InterruptedVaultPreparation | null>(null)
  const key = vaultIntentKey(chain.id, contracts.vault, owner)
  const [initial] = useState(() => {
    try {
      return { operation: readVaultIntent(localStorage, key), error: null }
    } catch {
      return {
        operation: null,
        error: 'Your saved operation is unavailable. Restore browser storage before preparing another transaction.',
      }
    }
  })
  const [operation, setOperation] = useState<Operation | null>(initial.operation)
  const [safeToDismiss, setSafeToDismiss] = useState(initial.operation === null)
  useEffect(() => {
    let active = true
    void withVaultIntentLock(navigator.locks, key, async () => {
      const saved = await readVaultIntentDurable(localStorage, key)
      if (active) {
        setOperation(saved)
        setSafeToDismiss(saved === null)
      }
    }).catch((failure) => {
      if (!active) return
      if (failure instanceof InterruptedVaultPreparation) setInterrupted(failure)
      setError(friendlyError(failure))
    })
    return () => {
      active = false
    }
  }, [key])
  // "Back an agent" lists every listed agent: while its picker is open, read the directory's remaining pages.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = directory
  useEffect(() => {
    if (sheet === 'pick' && hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [sheet, hasNextPage, isFetchingNextPage, fetchNextPage])
  const signTypedDataAsync = useSignTypedDataWithPrompt()
  useEffect(() => {
    setError(null)
    setText('')
  }, [account, mode])
  const agents = directory.data?.agents ?? []
  const labelSources = { owner, managed: managed.data?.agents, directory: agents }
  const nameOf = (target: Address) => {
    const walletAgents = queryClient.getQueryData<{ agents: string[] }>(walletAgentsKey(target))?.agents
    return positionLabel(target, { ...labelSources, walletAgents }).name
  }
  const mine = new Set(
    (managed.data?.agents ?? []).flatMap((agent) => (agent.address === null ? [] : [agent.address.toLowerCase()])),
  )
  const rank = (wallet: string) => (mine.has(wallet) ? 0 : wallet === owner.toLowerCase() ? 1 : 2)
  const scopedPositions =
    scope.kind === 'agent'
      ? selected.data?.position === null ||
        selected.data?.position === undefined ||
        selected.data?.backing === undefined
        ? []
        : [{ position: selected.data.position, backing: selected.data.backing }]
      : (reads.data?.positions ?? [])
  const positions = scopedPositions.toSorted((left, right) => {
    const a = left.position.account.toLowerCase()
    const b = right.position.account.toLowerCase()
    return rank(a) - rank(b) || a.localeCompare(b)
  })
  const unavailable =
    reads.isError ||
    selected.isError ||
    reads.data === undefined ||
    selected.data === undefined ||
    initial.error !== null
  const disabled = unavailable || busy || operation !== null || reads.data?.open !== true || !writesOpen

  function reportFailure(failure: unknown) {
    if (failure instanceof InterruptedVaultPreparation) setInterrupted(failure)
    setError(friendlyError(failure))
  }

  async function saveOperation(kind: Operation['kind'], target: Address, txs: Operation['txs']) {
    const next: Operation = {
      id: crypto.randomUUID(),
      kind,
      account: target,
      txs,
    }
    await writeTxJournalDurable(localStorage, txJournalKey(`delegation:${next.id}`, next.txs), emptyJournal())
    await writeVaultIntent(localStorage, key, next)
    setOperation(next)
    setSafeToDismiss(false)
    setText('')
  }

  async function savePrepared(kind: Operation['kind'], target: Address, description: string, data: `0x${string}`) {
    await saveOperation(kind, target, [{ description, chainId: chain.id, to: contracts.vault, value: '0', data }])
  }

  async function prepare(kind: Operation['kind'], target: Address, description: string, data: `0x${string}`) {
    await withVaultIntentLock(navigator.locks, key, async () => {
      if ((await readVaultIntentDurable(localStorage, key)) !== null)
        throw new Error('Another tab has an unfinished position action. Reconcile it before starting another.')
      await savePrepared(kind, target, description, data)
    })
  }

  async function submit() {
    const amount = factoryAmount(text)
    if (disabled || amount === null) return
    setBusy(true)
    setError(null)
    try {
      await withVaultIntentLock(navigator.locks, key, async () => {
        if ((await readVaultIntentDurable(localStorage, key)) !== null)
          throw new Error('Another tab has an unfinished position action. Reconcile it before starting another.')
        const ctx = stakeContext(contracts)
        if (mode === 'leave') {
          const shares = await sdk.undelegationShares(ctx, account, owner, amount)
          await savePrepared(
            'leave',
            account,
            `Leave ${factoryValue(amount)} behind ${nameOf(account)}`,
            encodeFunctionData({
              abi: sdk.stakeVaultAbi,
              functionName: 'requestUndelegate',
              args: [account, shares],
            }),
          )
          return
        }
        const balance = await ctx.publicClient.readContract({
          address: contracts.factory,
          abi: sdk.sideTokenAbi,
          functionName: 'balanceOf',
          args: [owner],
        })
        if (amount > balance) throw new Error('That is more SIDE than your wallet holds.')
        const agent = agents.find((entry) => entry.wallet.toLowerCase() === account.toLowerCase())
        const agentId = scope.kind === 'agent' ? scope.agentId : agent?.agentId
        if (agentId !== undefined) {
          const wallet = await ctx.publicClient.readContract({
            address: ctx.deployment.identity,
            abi: sdk.identityAbi,
            functionName: 'getAgentWallet',
            args: [BigInt(agentId)],
          })
          if (wallet.toLowerCase() !== account.toLowerCase())
            throw new Error('This agent changed its wallet. Refresh the directory before backing.')
        }
        const delegatedTo = await sdk.delegationOf(ctx.publicClient, owner)
        if (delegatedTo?.toLowerCase() === deployment.delegation.delegator.toLowerCase()) {
          await saveOperation('delegate', account, [
            {
              chainId: chain.id,
              description: `Back with ${exactFactory(amount)} SIDE to ${nameOf(account)}`,
              to: owner,
              value: '0',
              data: sdk.batchCalldata([
                {
                  chainId: chain.id,
                  description: 'Approve SIDE for the vault',
                  to: contracts.factory,
                  value: '0',
                  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [contracts.vault, amount] }),
                },
                {
                  chainId: chain.id,
                  description: 'Back this wallet',
                  to: contracts.vault,
                  value: '0',
                  data: encodeFunctionData({
                    abi: sdk.stakeVaultAbi,
                    functionName: 'delegate',
                    args: [account, amount],
                  }),
                },
              ]),
            },
          ])
          return
        }
        const permit = await sdk.delegatePermit(ctx, owner, amount, BigInt(Math.floor(Date.now() / 1000) + 3600))
        await withVaultPermitPreparation(
          key,
          () => signTypedDataAsync(permit, prompts.backingPermit(nameOf(account), exactFactory(amount))),
          async (signature) => {
            const { r, s, v, yParity } = parseSignature(signature)
            await savePrepared(
              'delegate',
              account,
              `Back with ${exactFactory(amount)} SIDE to ${nameOf(account)}`,
              encodeFunctionData({
                abi: sdk.stakeVaultAbi,
                functionName: 'delegateWithPermit',
                args: [account, amount, permit.message.deadline, Number(v ?? BigInt(yParity + 27)), r, s],
              }),
            )
          },
        )
      })
    } catch (failure) {
      reportFailure(failure)
    } finally {
      setBusy(false)
    }
  }

  function direct(kind: 'cancel' | 'withdraw', target: Address) {
    if (disabled) return
    void prepare(
      kind,
      target,
      kind === 'cancel' ? `Cancel leaving ${nameOf(target)}` : `Withdraw your position from ${nameOf(target)}`,
      kind === 'cancel'
        ? encodeFunctionData({
            abi: sdk.stakeVaultAbi,
            functionName: 'cancelUndelegate',
            args: [target],
          })
        : encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'withdraw', args: [target] }),
    ).catch(reportFailure)
  }

  // A form sheet closes into the confirm step (and a saved one is restored on load): bring it into view.
  const sheeted = scope.kind === 'account' || agentSheet !== undefined
  useReveal('backing-confirm', sheeted ? operation?.id : undefined)
  const closeAgentSheet = agentSheet?.onOpenChange
  useEffect(() => {
    if (operation !== null) closeAgentSheet?.(false)
  }, [operation, closeAgentSheet])

  // The backing form with its gas warning: inline on an agent's page, in a sheet on Account.
  const formBlock = (
    <>
      {mode === 'add' && <GasWarning mon={mon.data?.value} />}
      <DelegationForm
        account={account}
        owner={owner}
        mode={mode}
        text={text}
        wallet={reads.data?.wallet}
        active={selected.data?.position?.activeValue}
        reserved={selected.data?.backing?.reserved}
        cooldown={reads.data?.cooldown}
        disabled={disabled}
        busy={busy}
        error={error}
        onMode={setMode}
        onText={setText}
        onSubmit={() => void submit()}
        framed={scope.kind === 'agent' && agentSheet === undefined}
      />
    </>
  )

  return (
    <>
      {scope.kind === 'account'
        ? reads.data !== undefined && (
            <BackingOverview
              positions={reads.data.positions}
              wallet={reads.data.wallet}
              owner={owner}
              disabled={disabled}
              onBackAgent={() => setSheet('pick')}
            />
          )
        : agentSheet === undefined && (
            <p className="rounded-xl bg-warning/14 p-4 text-sm leading-relaxed text-warning-text">{DELEGATION_RISK}</p>
          )}

      {initial.error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{initial.error}</AlertDescription>
        </Alert>
      )}

      <VaultPreparationRecovery
        preparation={interrupted}
        intentKey={key}
        onCleared={() => {
          setInterrupted(null)
          setError(null)
        }}
        onError={setError}
      />

      {(reads.isError || selected.isError) && (
        <PositionsUnavailable
          lastKnown={reads.data !== undefined}
          onRetry={() => void Promise.all([reads.refetch(), selected.refetch()])}
        />
      )}

      {scope.kind === 'account' && reads.isPending ? (
        <LoadingRows rows={3} />
      ) : (
        reads.data !== undefined &&
        agentSheet === undefined && (
          <>
            {scope.kind === 'agent' && (
              <p className="px-4 text-sm text-muted-foreground">
                In your wallet:{' '}
                <span className="tabular-nums font-semibold text-foreground">{factoryValue(reads.data.wallet)}</span>
              </p>
            )}

            <DelegationPositions
              positions={positions}
              sources={labelSources}
              disabled={disabled}
              onEdit={openForm}
              onCancel={(target) => direct('cancel', target)}
              onWithdraw={(target) => direct('withdraw', target)}
            />
          </>
        )
      )}

      {scope.kind === 'account' && directory.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            The directory is unavailable. You can still manage existing positions once their chain reads answer.
          </AlertDescription>
        </Alert>
      )}

      {operation !== null ? (
        <ConfirmPosition
          operation={operation}
          name={nameOf(operation.account)}
          owner={owner}
          contracts={contracts}
          intentKey={key}
          error={error}
          safeToDismiss={safeToDismiss}
          onSafeToDismissChange={setSafeToDismiss}
          onCleared={() => setOperation(null)}
          onError={setError}
        />
      ) : (
        scope.kind === 'agent' && agentSheet === undefined && formBlock
      )}

      {agentSheet !== undefined && (
        <AgentFormSheet
          open={agentSheet.open && operation === null}
          onClose={() => agentSheet.onOpenChange(false)}
          title={mode === 'leave' ? `Leave ${nameOf(account)}` : `Back ${nameOf(account)}`}
          busy={busy}
          wallet={reads.data?.wallet}
          form={formBlock}
        />
      )}

      {scope.kind === 'account' && (
        <BackingSheets
          open={operation === null ? sheet : null}
          onClose={() => setSheet(null)}
          mode={mode}
          own={account.toLowerCase() === owner.toLowerCase()}
          name={nameOf(account)}
          form={formBlock}
          busy={busy}
          agents={backableAgents(owner, managed.data?.agents ?? [], agents)}
          onPick={openForm}
        />
      )}

      {reads.data?.open === false && (
        <p role="status" className="rounded-xl bg-primary/10 p-4 text-sm">
          Backing opens at launch, once the first Holding is authorized. Your SIDE stays in your wallet until then.
        </p>
      )}

      {scope.kind === 'account' && (
        <HoldingControls
          contracts={contracts}
          account={owner}
          disabled={disabled}
          onVeto={(holding, denied) => {
            void prepare(
              'veto',
              owner,
              denied ? 'Refuse the Holding for my wallet' : 'Allow the Holding for my wallet',
              encodeFunctionData({
                abi: sdk.stakeVaultAbi,
                functionName: 'setHoldingDenied',
                args: [holding, denied],
              }),
            ).catch(reportFailure)
          }}
        />
      )}
    </>
  )
}
