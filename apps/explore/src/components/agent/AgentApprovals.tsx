import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Address } from 'viem'
import type { ManagedAgent } from '../../api.ts'
import { splitApprovals } from '../../approval-view.ts'
import { useManagedApprovals } from '../../managed.ts'
import { approvalAnchor } from '../../owner-route.ts'
import type { RecordJob } from '../../routes/Agent.tsx'
import { deployment } from '../../wallet.ts'
import { useAuth } from '../Wallet.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty.tsx'
import { Button } from '../ui/button.tsx'
import { Approval } from './Approval.tsx'
import { PastApprovals } from './PastApprovals.tsx'

function useApprovalFocus(focus: string | null, loaded: boolean) {
  const shown = useRef<string | null>(null)
  useEffect(() => {
    if (focus === null || !loaded || shown.current === focus) return
    const target = document.getElementById(approvalAnchor(focus))
    if (target === null) return
    shown.current = focus
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' })
  }, [focus, loaded])
}

function ApprovalReadStatus({ query }: { query: ReturnType<typeof useManagedApprovals> }) {
  if (query.isLoading) return <output className="text-muted-foreground">Loading this agent’s approval requests…</output>
  if (!query.isError) return null
  return (
    <div role="alert" className="grid gap-3 text-sm text-destructive-text">
      <p>
        Approval records could not load. If you just signed, your decision may already be saved. Refresh this request to
        check.
      </p>
      <Button variant="outline" busy={query.isFetching} onClick={() => void query.refetch()}>
        Retry reading approvals
      </Button>
    </div>
  )
}

/**
 * This agent's decisions: approved operations that did not finish and the waiting ones as full cards, oldest first,
 * then the decided ones as one-line rows. The one
 * a link points at is scrolled into view once the list has loaded, ringed if it waits and unfolded if it is past.
 */
export function AgentApprovals({
  managed,
  posted,
  focus,
}: {
  managed: ManagedAgent
  posted: readonly RecordJob[] | undefined
  focus: string | null
}) {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const approvals = useManagedApprovals()
  const mine = (approvals.data?.approvals ?? []).filter((a) => a.agent_id === managed.id)
  const { waiting, recovering, past } = splitApprovals(mine)
  const refresh = () =>
    queryClient.invalidateQueries(
      { queryKey: ['managed-approvals', auth.address?.toLowerCase()] },
      { throwOnError: true },
    )
  const [receipt, setReceipt] = useState<{ key: string; message: string } | null>(null)
  useApprovalFocus(focus, approvals.data !== undefined)
  const card = (approval: (typeof mine)[number]) => (
    <div
      key={approval.id}
      id={approvalAnchor(approval.id)}
      data-focus={approval.id === focus || undefined}
      className="scroll-mt-24 rounded-xl data-focus:-m-3 data-focus:bg-card data-focus:p-3 data-focus:shadow-sm data-focus:ring-2 data-focus:ring-ring/50"
    >
      <Approval
        approval={approval}
        agent={managed}
        // SAFETY: this panel is rendered only for an agent owned by the signed-in wallet.
        operator={auth.address as Address}
        refresh={refresh}
        onResult={(message) => setReceipt({ key: approval.context?.operationKey ?? approval.id, message })}
      />
    </div>
  )
  return (
    <>
      {receipt !== null && (
        <output className="rounded-xl bg-muted p-4 text-sm">
          <span className="break-all font-mono">{receipt.key}</span>: {receipt.message}
        </output>
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {waiting.length} waiting · {recovering.length} approved, not finished
        </p>
        <Button variant="outline" busy={approvals.isFetching} onClick={() => void approvals.refetch()}>
          Refresh approvals
        </Button>
      </div>
      <ApprovalReadStatus query={approvals} />
      {approvals.isSuccess && focus !== null && !mine.some((a) => a.id === focus) && (
        <p role="alert" className="text-sm text-destructive-text">
          The linked approval was not found for this agent and operator. Check the link and connected wallet.
        </p>
      )}
      {/* Keep each active card mounted as polling moves it from pending to approved. */}
      <fieldset disabled={!approvals.isSuccess} className="grid min-w-0 gap-7">
        {[...recovering, ...waiting].map(card)}
      </fieldset>
      {approvals.isSuccess && waiting.length === 0 && recovering.length === 0 && (
        <Empty className="border border-dashed py-8">
          <EmptyHeader>
            <EmptyTitle>Nothing waiting for you</EmptyTitle>
            <EmptyDescription>Completed decisions are shown below.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <PastApprovals approvals={past} factory={deployment.factory} posted={posted} focus={focus} />
    </>
  )
}
