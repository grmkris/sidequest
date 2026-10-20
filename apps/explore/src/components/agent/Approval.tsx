import { Badge } from '../ui/badge.tsx'
import { Button } from '../ui/button.tsx'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Details, Section } from '../kit.tsx'
import * as sdk from '@sidequest/sdk'
import { useEffect, useState } from 'react'
import { type Address, decodeFunctionData } from 'viem'
import { agentEndpoint, type ManagedAgent } from '../../api.ts'
import type { AgentApproval } from '../../agent-api.ts'
import { reviewAgentGrant, type PreparedGrant } from '../../agent-grant.ts'
import { AgentGrantReview } from '../AgentGrantReview.tsx'
import { PermissionApproval } from './PermissionApproval.tsx'
import { RoleApproval } from './RoleApproval.tsx'
import { ConfirmButton } from '../Sheet.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'

import { useTokenList } from '../../useTokens.ts'
import { typedDataArgs } from '../../typed-data.ts'
import { deployment } from '../../wallet.ts'
import { prompts, useSignTypedDataWithPrompt } from '../../wallet-prompt.ts'
import { tokenAmountText } from '../../permission-review.ts'
import { HireContext } from './HireContext.tsx'
import { approvalResult } from '../../approval-result.ts'

/** One decision a managed agent waits on; a requested permission and a requested role have their own cards. */
export function Approval(props: Parameters<typeof OperationApproval>[0]) {
  if (props.approval.kind === 'permission') return <PermissionApproval {...props} />
  if (props.approval.kind === 'role')
    return (
      <RoleApproval
        approval={props.approval}
        agent={props.agent}
        refresh={async () => {
          await props.refresh()
        }}
      />
    )
  return <OperationApproval {...props} />
}

/** Rejecting asks first. A rejected hire sends and pays nothing, and a rejected pick reopens its quote request. */
function RejectButton({
  kind,
  name,
  busy,
  onReject,
}: {
  kind: AgentApproval['kind']
  name: string
  busy: boolean
  onReject: () => void
}) {
  const unstake = kind === 'unstake'
  return (
    <ConfirmButton
      disabled={busy}
      title={unstake ? 'Keep the position?' : 'Reject this hire?'}
      description={
        unstake
          ? `The shares stay where they are, and ${name} is told you said no.`
          : `Nothing is sent and nothing is paid. If ${name} picked a quote, that quote request opens again so it can pick another.`
      }
      confirm={unstake ? 'Reject leaving' : 'Reject hire'}
      onConfirm={onReject}
    >
      Reject
    </ConfirmButton>
  )
}

function ApprovalProgress({ message }: { message: string }) {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 10_000)
    return () => clearTimeout(timer)
  }, [])
  return (
    <output className="grid gap-1 text-sm text-muted-foreground">
      <span>{message}</span>
      {slow && (
        <span>
          This is taking longer than usual. Refresh approvals checks the saved state without sending another decision.
        </span>
      )}
    </output>
  )
}

/** An exact hire budget or agent-owned position leaving the vault, with explicit progress and readback. */
function OperationApproval({
  approval,
  agent,
  operator,
  refresh,
  onResult,
}: {
  approval: AgentApproval
  agent: ManagedAgent
  operator: Address
  refresh: () => Promise<unknown>
  onResult?: (message: string) => void
}) {
  const request = JSON.parse(approval.request_json) as {
    token?: Address
    amount: string
    shares?: string
    publish?: `0x${string}`
    call?: { to: string; data: `0x${string}` }
  }
  useTokenList(request.token === undefined ? [] : [request.token])
  const signTypedDataAsync = useSignTypedDataWithPrompt()
  const [review, setReview] = useState<ReturnType<typeof reviewAgentGrant> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (failure) {
      const message =
        failure instanceof Error
          ? failure.message
          : 'The decision response is unavailable. Refresh this request to check its state.'
      setError(message)
      onResult?.(message)
    } finally {
      // Even a lost response may have saved the decision. Read it back without sending another action.
      try {
        await refresh()
      } catch {
        onResult?.('The approval records could not refresh. Check this same request before trying again.')
      }
      setBusy(false)
      setProgress(null)
    }
  }
  async function prepare() {
    setProgress('Reading the exact one-off budget…')
    if (approval.context?.hire == null) throw new Error('The exact hire brief is unavailable; reload before signing')
    if (request.publish === undefined || request.token === undefined || agent.address === null)
      throw new Error('The exact hire request is incomplete')
    const decoded = decodeFunctionData({ abi: sdk.sidequestHoldingAbi, data: request.publish })
    if (decoded.functionName !== 'publish') throw new Error('This decision does not name a publish')
    const params = decoded.args[0]
    if (params.token.toLowerCase() !== request.token.toLowerCase() || params.reward !== BigInt(request.amount))
      throw new Error('The reward differs from the frozen publish')
    const prepared = await agentEndpoint<PreparedGrant>(`/api/approvals/${approval.id}/prepare`, 'POST')
    setReview(
      reviewAgentGrant(prepared, {
        kind: 'allowance-once',
        delegator: operator,
        agent: agent.address as Address,
        token: request.token,
        amount: BigInt(request.amount),
      }),
    )
  }
  async function decide(approved: boolean) {
    if (approved && approval.kind === 'unstake') {
      if (request.call === undefined || request.call.to.toLowerCase() !== deployment.sidequest.vault.toLowerCase())
        throw new Error('The leaving target is not the vault')
      const decoded = decodeFunctionData({ abi: sdk.stakeVaultAbi, data: request.call.data })
      if (
        decoded.functionName !== 'requestUndelegate' ||
        decoded.args[0].toLowerCase() !== agent.address?.toLowerCase() ||
        decoded.args[1] !== BigInt(request.shares!)
      )
        throw new Error('The leaving call differs from the displayed account or shares')
    }
    let signature: string | undefined
    if (approved && approval.kind === 'hire-over-limit') {
      if (review === null) throw new Error('Review the exact one-off budget first')
      setProgress('Waiting for your wallet signature…')
      signature = await signTypedDataAsync(
        typedDataArgs(review.typedData),
        prompts.hire(agent.name, tokenAmountText(request.amount, request.token!)),
      )
    }
    setProgress(approved ? 'Saving approval and waiting for execution…' : 'Saving your rejection…')
    const result = await agentEndpoint(`/api/approvals/${approval.id}/decide`, 'POST', {
      approved,
      ...(signature === undefined ? {} : { signature }),
    })
    onResult?.(approvalResult(result))
    setReview(null)
  }
  return (
    <Section title={`${agent.name} · ${approval.kind === 'unstake' ? 'Leave agent-owned position' : 'Hire approval'}`}>
      <HireContext approval={approval} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xl font-semibold">
          {request.token === undefined ? (
            <>
              <TokenAmount value={request.amount} token={deployment.factory} /> position value
            </>
          ) : (
            <TokenAmount value={request.amount} token={request.token} />
          )}
        </p>
        <Badge variant={approval.status === 'pending' ? 'warning' : 'neutral'}>{approval.status}</Badge>
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {approval.kind === 'unstake'
          ? 'Approval permits this exact share count once. The vault values those shares at execution time; the cooldown comes from the active network and a slash can change the asset value while they leave.'
          : 'Approve this exact hire budget. The agent can use only this token and amount for this hire; approval and publication happen together.'}
      </p>
      {approval.kind === 'unstake' && (
        <p className="break-all text-xs text-muted-foreground">
          Agent-owned shares: {request.shares}. Manage your own backing from Back an agent.
        </p>
      )}
      <Details summary="Technical details">
        <p className="break-all font-mono text-micro text-muted-foreground">Operation {approval.operation_id}</p>
      </Details>
      {review !== null && <AgentGrantReview description={review.description} />}
      {progress !== null && <ApprovalProgress key={progress} message={progress} />}
      {approval.status === 'pending' && (
        <div className="flex flex-wrap gap-2">
          <Button
            busy={busy}
            disabled={approval.kind === 'hire-over-limit' && approval.context?.hire == null}
            onClick={() =>
              void run(approval.kind === 'hire-over-limit' && review === null ? prepare : () => decide(true))
            }
          >
            {approval.kind === 'hire-over-limit'
              ? review === null
                ? 'Review exact budget'
                : 'Sign and approve hire'
              : 'Approve exact shares'}
          </Button>
          <RejectButton
            kind={approval.kind}
            name={agent.name}
            busy={busy}
            onReject={() => void run(() => decide(false))}
          />
        </div>
      )}
      {approval.status === 'approved' && (
        <Button
          busy={busy}
          onClick={() =>
            void run(async () => {
              setProgress('Reconciling the original approved operation…')
              const result = await agentEndpoint(`/api/approvals/${approval.id}/retry`, 'POST')
              onResult?.(approvalResult(result))
            })
          }
        >
          Reconcile and continue approved operation
        </Button>
      )}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </Section>
  )
}
