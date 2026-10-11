/**
 * The confirm step of a saved position action (back, leave, cancel leaving, withdraw, Holding permission): its wallet
 * steps, then the saved intent cleared and the backing reads refreshed. "Not now" drops an action no wallet step has
 * started. Moved out of `BackingManager` unchanged; the transactions and their locks are its.
 */
import { useQueryClient } from '@tanstack/react-query'
import type { Address } from 'viem'
import type { SidequestContracts } from '../../sidequest.ts'
import { refreshAfterPosition } from '../../position-refresh.ts'
import { stakeContext } from '../../stake-context.ts'
import { friendlyError } from '../../txErrors.ts'
import { type VaultIntent, clearOwnedIntentDurable, withVaultIntentLock } from '../../vault-lock.ts'
import { vaultOperationGuards } from '../../vault-proof.ts'
import { Section } from '../kit.tsx'
import { useToast } from '../Sheet.tsx'
import { TxSteps } from '../TxSteps.tsx'
import { readTxJournalDurable, txJournalKey } from '../txJournal.ts'
import { withWalletStepLock } from '../txOperation.ts'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Button } from '../ui/button.tsx'

const DONE: Record<VaultIntent['kind'], string> = {
  delegate: 'Backed. You own the position.',
  leave: 'Leaving started. Your position stays at risk.',
  cancel: 'Leaving cancelled. Your backing is active again.',
  withdraw: 'Withdrawn to your wallet.',
  veto: 'Holding permission updated.',
}

/** "Not now": drop a saved action no wallet step has started, here or in another tab. */
async function dropUnstarted(operation: VaultIntent, key: string, onCleared: () => void) {
  const journalKey = txJournalKey(`delegation:${operation.id}`, operation.txs)
  await withWalletStepLock(navigator.locks, journalKey, async () => {
    const journal = (await readTxJournalDurable(localStorage, journalKey, true))!
    if (journal.pending !== null || journal.hashes.some((hash) => hash !== null) || journal.sponsor != null)
      throw new Error('This action started in another tab. Reconcile it before preparing another.')
    await withVaultIntentLock(navigator.locks, key, async () => {
      if (!(await clearOwnedIntentDurable(localStorage, key, operation.id)))
        throw new Error('A newer position action is saved in another tab; keep it for reconciliation.')
      onCleared()
    })
  })
}

export function ConfirmPosition({
  operation,
  name,
  owner,
  contracts,
  intentKey: key,
  error,
  safeToDismiss,
  onSafeToDismissChange,
  onCleared,
  onError,
}: {
  operation: VaultIntent
  /** The backed account's name. */
  name: string
  owner: Address
  contracts: SidequestContracts
  intentKey: string
  error: string | null
  safeToDismiss: boolean
  onSafeToDismissChange: (safe: boolean) => void
  onCleared: () => void
  onError: (message: string) => void
}) {
  const queryClient = useQueryClient()
  const toast = useToast()
  return (
    <Section id="backing-confirm" title="Confirm your position action">
      <p className="px-4 text-sm text-muted-foreground">
        Backing wallet: {name}. Withdrawals return to your signed-in wallet.
      </p>
      <TxSteps
        key={operation.id}
        taskId={`delegation:${operation.id}`}
        txs={operation.txs}
        owner={owner}
        reportToBoard={false}
        requireJournal
        retainRecord
        verifyReceipt
        allowSponsorship={false}
        onSafeToRestartChange={onSafeToDismissChange}
        {...vaultOperationGuards(stakeContext(contracts), localStorage, key, operation, owner)}
        onDone={() => {
          void withVaultIntentLock(navigator.locks, key, async () => {
            if (!(await clearOwnedIntentDurable(localStorage, key, operation.id)))
              throw new Error('A newer position action is saved in another tab; keep it for reconciliation.')
            onCleared()
            toast(DONE[operation.kind])
            const head = await stakeContext(contracts).publicClient.getBlockNumber({ cacheTime: 0 })
            void refreshAfterPosition(queryClient, head)
          }).catch((failure) => onError(friendlyError(failure)))
        }}
      />
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {safeToDismiss && (
        <Button
          variant="link"
          onClick={() => {
            void dropUnstarted(operation, key, onCleared).catch((failure) => onError(friendlyError(failure)))
          }}
        >
          Not now
        </Button>
      )}
    </Section>
  )
}
