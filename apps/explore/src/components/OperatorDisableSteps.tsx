import { TxSteps } from './TxSteps.tsx'
import { Button } from './ui/button.tsx'
import type { useOperatorRevocation } from './useOperatorRevocation.ts'

export function OperatorDisableSteps({
  action,
  agentId,
}: {
  action: ReturnType<typeof useOperatorRevocation>
  agentId: string
}) {
  const intent = action.intent
  if (intent === null) return null
  if (intent.phase !== 'send')
    return (
      <Button busy={action.busy} onClick={() => void action.reconcile()}>
        {intent.phase === 'readback' ? 'Check on-chain disablement' : 'Reconcile saved revocation'}
      </Button>
    )
  return (
    <div className="grid gap-2">
      <p className="text-sm">
        Hosted use has stopped. Send the on-chain disables from your wallet, paying USDC or MON gas.
      </p>
      <TxSteps
        taskId={`operator-disable:${agentId}:${intent.key}`}
        txs={[...intent.transactions]}
        owner={action.operator}
        reportToBoard={false}
        onDone={() => void action.sent()}
      />
    </div>
  )
}
