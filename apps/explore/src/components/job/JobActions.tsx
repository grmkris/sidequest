import { boardKey } from '../../queries.ts'
import { refreshJob } from '../../query-refresh.ts'
import { Badge } from '../ui/badge.tsx'
import { Button } from '../ui/button.tsx'
import { Field, FieldLabel } from '../ui/field.tsx'
import { Textarea } from '../ui/textarea.tsx'
import { cn } from '../../lib/cn.ts'
import { Item, ItemGroup, ItemContent, ItemMedia, ItemDescription } from '../ui/item.tsx'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '../ui/empty.tsx'
import { Section, Segmented } from '../kit.tsx'
/**
 * What the viewer can do on a job, and only what the contracts accept now (the lifecycle model's `actions`). Every
 * action that moves money or cannot be undone says what will happen in a confirmation sheet first, then goes out
 * through the transaction sheet; selecting an applicant is a signature, not a transaction.
 */
import type { JobAction, Phase } from '@sidequest/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { useAccount } from 'wagmi'
import { prompts, useSignTypedDataWithPrompt } from '../../wallet-prompt.ts'
import { type TxRequest, boardApi } from '../../api.ts'
import { amount, bond, span } from '../../format.ts'
import { percent } from '../../stake.ts'
import { friendlyError } from '../../txErrors.ts'
import { typedDataArgs } from '../../typed-data.ts'
import { earnedLine, useAgents } from '../../agent-summary.ts'
import { useJobs } from '../../routes/Jobs.tsx'
import { BoardLink, boardRoutes } from '../BoardLink.tsx'
import { SignIn } from '../SignIn.tsx'
import { ConfirmSheet, useToast } from '../Sheet.tsx'
import { TxSteps } from '../TxSteps.tsx'

import type { useSignedIn } from '../Wallet.tsx'
import { AgentOrb } from '../agent/AgentOrb.tsx'
import { AgentLabel } from '../agent/AgentChip.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'
import { paidJob } from './HireAgain.tsx'

export type JobEvent = 'approved' | 'rejected' | 'cancelled' | 'disputed' | 'settled'

export interface ActionJob {
  jobId?: string
  taskId: string
  boardId: string
  reward: string | null
  token: string | null
  creatorBond: string | null
  workerBond: string | null
  agentId: string | null
  /** The offer's windows, from the board's terms. */
  disputeSeconds: number | null
  /** The job's fee, fixed at activation (D11); null before it. The agent is paid `net`. */
  charge?: { bps: number; fee: string; net: string } | null
  selection?:
    | {
        state: 'signed' | 'expired' | 'invalid' | 'unavailable'
        applicationId: string
        agentId: string
        activateBy: number
      }[]
    | null
    | undefined
}

type Pending =
  | { kind: 'approve' | 'reject' | 'cancel' | 'settle' | 'dispute' }
  | { kind: 'select'; applicationId: string; agentId: string }

const TOOL: Record<string, string> = {
  approve: 'approve_work',
  reject: 'reject_work',
  cancel: 'cancel_task',
  settle: 'settlement_actions',
  dispute: 'dispute',
}
const EVENT: Record<string, JobEvent> = {
  approve: 'approved',
  reject: 'rejected',
  cancel: 'cancelled',
  settle: 'settled',
  dispute: 'disputed',
}

const SETTLE_LABEL: Record<string, string> = {
  completeAfterSilence: 'Release the payment',
  rejectAfterDeliveryDeadline: 'Close it and refund the creator',
  rejectAfterWindow: 'Finalize the rejection',
  refundAfterArbitrationTimeout: 'Refund the creator',
}

const VIOLATIONS = [
  ['None', 'No fault'],
  ['Quality', 'Not good enough'],
  ['Falsified', 'Faked evidence'],
] as const
type Violation = (typeof VIOLATIONS)[number][0]

/**
 * `afterSignIn` is what the viewer could send once signed in; while they are not, those actions show as a sign-in
 * action instead (a button that cannot send would only fail silently).
 */
export function JobActions({
  job,
  phase,
  roles,
  auth,
  afterSignIn = [],
  sourceAvailable = true,
  onEvent,
}: {
  job: ActionJob
  phase: Phase
  roles: string[]
  auth: ReturnType<typeof useSignedIn>
  afterSignIn?: JobAction[]
  sourceAvailable?: boolean
  onEvent?: ((type: JobEvent, payload: Record<string, unknown>) => void) | undefined
}) {
  const signedIn = auth.signedIn
  const qc = useQueryClient()
  const toast = useToast()
  const api = boardApi(job.boardId)
  const signTypedDataAsync = useSignTypedDataWithPrompt()
  const { address } = useAccount()
  const [pending, setPending] = useState<Pending | null>(null)
  const [txs, setTxs] = useState<{ list: TxRequest[]; kind: string; owner: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [violation, setViolation] = useState<Violation>('None')
  const [reason, setReason] = useState('')
  const [statement, setStatement] = useState('')

  const agent = job.agentId !== null ? `Worker #${job.agentId}` : 'the agent'
  const reward = amount(job.reward, job.token)
  const charge = job.charge ?? null
  const paid = charge === null ? reward : amount(charge.net, job.token)
  const worker = roles.includes('worker')
  const canDispute = worker && phase.key === 'rejected-pending'
  const bar: JobAction[] = phase.actions.filter(
    (a) => a === 'approve' || a === 'reject' || a === 'cancel' || a === 'settle',
  )

  const close = () => {
    setPending(null)
    setError(null)
  }
  const done = (kind: string, hashes: string[]) => {
    setTxs(null)
    void refreshJob(qc, {
      boardId: job.boardId,
      taskId: job.taskId,
      ...(job.jobId === undefined ? {} : { jobId: job.jobId }),
    })
    const messages: Record<string, string> = {
      approve: `Paid ${paid} to ${agent}`,
      reject: 'Rejected. The dispute window is open.',
      cancel: 'Cancelled on-chain. Check the job timeline for the bond release and any forfeiture.',
      settle: 'Settled on-chain',
      dispute: 'Disputed. The arbitrator decides next.',
    }
    toast(messages[kind] ?? 'Done')
    const event = EVENT[kind]
    if (event !== undefined) onEvent?.(event, { txHash: hashes.at(-1) ?? null })
  }

  const go = async () => {
    if (pending === null || txs !== null) return
    if (!sourceAvailable)
      return setError('The job details are unavailable right now, so nothing can be sent. Retry them above.')
    if (address === undefined || !signedIn) return setError('Sign in first: only a signed-in wallet can send this.')
    setBusy(true)
    setError(null)
    try {
      if (pending.kind === 'select') {
        const chosen = pending
        setPending(null)
        const sel = await api.tool<{ nonce: string; sign: { typedData: string } }>('select_worker', {
          taskId: job.taskId,
          applicationId: pending.applicationId,
        })
        const signature = await signTypedDataAsync(
          typedDataArgs(sel.sign.typedData),
          prompts.selection(`Agent ID ${chosen.agentId}`),
        )
        await api.tool('submit_selection', { taskId: job.taskId, nonce: sel.nonce, signature })
        const refreshed = await api.tool<{ selection?: ActionJob['selection'] }>('get_task', { taskId: job.taskId })
        qc.setQueriesData<{ selection?: ActionJob['selection'] }>(
          {
            predicate: (query) =>
              query.queryKey[0] === 'get_task' &&
              query.queryKey[1] === job.boardId &&
              query.queryKey[2] === job.taskId &&
              query.queryKey[3] === address?.toLowerCase() &&
              query.queryKey[4] === signedIn,
          },
          (current) => (current === undefined ? current : { ...current, selection: refreshed.selection ?? null }),
        )
        void qc.invalidateQueries({ queryKey: ['get_task', job.boardId, job.taskId] })
        setPending(null)
        toast(`Selected Worker #${pending.agentId}. The job starts when it activates.`)
        return
      }
      const args: Record<string, unknown> = { taskId: job.taskId }
      if (pending.kind === 'reject') Object.assign(args, { violation, reason })
      if (pending.kind === 'dispute' && statement.trim() !== '') args.statement = statement
      const r = await api.tool<{ transactions: TxRequest[] }>(TOOL[pending.kind] as string, args)
      const kind = pending.kind
      setPending(null)
      if (r.transactions.length === 0)
        toast('Nothing to send right now: the chain has already moved on. Reload to see where it stands.', 'error')
      else setTxs({ list: r.transactions, kind, owner: address })
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  const label = (a: JobAction) =>
    a === 'approve'
      ? `Approve and pay ${reward}`
      : a === 'reject'
        ? 'Reject'
        : a === 'cancel'
          ? 'Cancel the job'
          : (SETTLE_LABEL[phase.timeout ?? ''] ?? 'Release what is left in escrow')
  const settleOnly = afterSignIn.every((a) => a === 'settle')
  const signInLabel = settleOnly
    ? `Sign in to ${label('settle').replace(/^./, (c) => c.toLowerCase())}`
    : 'Sign in to act on this job'

  return (
    <>
      {txs === null && sourceAvailable && signedIn && phase.actions.includes('select') && (
        <Applications
          job={job}
          signedIn={signedIn}
          onSelect={(applicationId, agentId) => setPending({ kind: 'select', applicationId, agentId })}
        />
      )}

      {(bar.length > 0 || canDispute) && (
        <div className="material-chrome sticky bottom-[calc(4.75rem+var(--safe-bottom))] z-20 flex flex-wrap gap-2.5 rounded-2xl p-2.5 shadow-popover lg:bottom-4">
          {bar.map((a) => (
            <Button
              key={a}
              size="lg"
              variant={a === 'approve' ? 'default' : a === 'settle' ? 'secondary' : 'destructive'}
              className={cn('flex-1', a === 'approve' && 'basis-full sm:basis-0')}
              disabled={txs !== null || !sourceAvailable}
              onClick={() => {
                if (txs === null) setPending({ kind: a as 'approve' | 'reject' | 'cancel' | 'settle' })
              }}
            >
              {label(a)}
            </Button>
          ))}
          {canDispute && (
            <Button
              size="lg"
              className="flex-1"
              disabled={txs !== null || !sourceAvailable}
              onClick={() => {
                if (txs === null) setPending({ kind: 'dispute' })
              }}
            >
              Dispute the rejection
            </Button>
          )}
        </div>
      )}

      {!signedIn && afterSignIn.length > 0 && (
        <div className="grid gap-2">
          <div className="material-chrome sticky bottom-[calc(4.75rem+var(--safe-bottom))] z-20 grid rounded-2xl p-2.5 shadow-popover lg:bottom-4">
            <SignIn auth={auth} label={signInLabel} />
          </div>
          <p className="px-4 text-ui text-muted-foreground">
            {settleOnly
              ? 'Anyone signed in can send this step; sign in to do it.'
              : 'This wallet has a part in this job. Sign in to see and send what it can do.'}
          </p>
        </div>
      )}

      <ConfirmSheet
        open={pending?.kind === 'approve'}
        onClose={close}
        title="Approve and pay?"
        description={
          charge === null
            ? 'This cannot be undone.'
            : 'This cannot be undone. A top-up, if any, is paid through Collect, less the same fee.'
        }
        confirm="Approve and pay"
        busy={busy}
        onConfirm={() => void go()}
      >
        <ItemGroup>
          <Item>
            <ItemContent className="flex-1">{agent} receives</ItemContent>
            <TokenAmount
              value={charge === null ? job.reward : charge.net}
              token={job.token}
              className="font-semibold"
            />
          </Item>
          {charge !== null && (
            <Item>
              <ItemContent className="flex-1">Sidequest’s {percent(charge.bps)} fee</ItemContent>
              <ItemContent className="text-muted-foreground">
                <TokenAmount value={charge.fee} token={job.token} />
              </ItemContent>
            </Item>
          )}
          {job.creatorBond !== null && job.creatorBond !== '0' && (
            <Item>
              <ItemContent className="flex-1">Your deposit at risk comes back</ItemContent>
              <ItemContent className="text-muted-foreground">{bond(job.creatorBond)}</ItemContent>
            </Item>
          )}
          {job.workerBond !== null && job.workerBond !== '0' && (
            <Item>
              <ItemContent className="flex-1">Its deposit at risk comes back</ItemContent>
              <ItemContent className="text-muted-foreground">{bond(job.workerBond)}</ItemContent>
            </Item>
          )}
          <Item>
            <ItemContent className="flex-1">Its public record</ItemContent>
            <ItemContent className="text-muted-foreground">+1 completed</ItemContent>
          </Item>
        </ItemGroup>
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </ConfirmSheet>

      <ConfirmSheet
        open={pending?.kind === 'reject'}
        onClose={close}
        title="Reject this work?"
        description={
          <>
            {agent} can dispute{' '}
            {job.disputeSeconds !== null ? `within ${span(job.disputeSeconds)}` : 'within the dispute window'}. Nothing
            moves before then, and you can still approve instead.
          </>
        }
        confirm="Reject"
        tone="destructive"
        busy={busy}
        disabled={reason.trim().length < 10}
        onConfirm={() => void go()}
      >
        <div className="grid gap-2">
          <span className="text-ui text-muted-foreground">Why</span>
          <Segmented label="Why" value={violation} onChange={setViolation} options={VIOLATIONS} />
          <p className="text-sm leading-snug text-muted-foreground">
            {violation === 'None'
              ? 'The reward comes back to you and both deposits at risk are returned. Nobody is penalised.'
              : `If the rejection stands, ${agent}'s ${bond(job.workerBond)} deposit at risk is burned. Use this only when the work breaks the accepted-when list${violation === 'Falsified' ? ' by faking its evidence' : ''}.`}
          </p>
        </div>
        <Field>
          <FieldLabel className="flex-col items-stretch">
            <span>What is wrong · the agent and an arbitrator read this</span>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="At least 10 characters" />
          </FieldLabel>
        </Field>
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </ConfirmSheet>

      <ConfirmSheet
        open={pending?.kind === 'cancel'}
        onClose={close}
        title="Cancel this job?"
        description="Nobody has started it. Cancel before 10 minutes after publish to release the full creator bond. At or after 10 minutes, or when the listing expires, the snapshotted unfilled-forfeit share goes to the treasury and the remainder is released."
        confirm="Cancel the job"
        cancelLabel="Keep it open"
        tone="destructive"
        busy={busy}
        onConfirm={() => void go()}
      >
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </ConfirmSheet>

      <ConfirmSheet
        open={pending?.kind === 'settle'}
        onClose={close}
        title={`${label('settle')}?`}
        description={<SettleText phase={phase} />}
        confirm={label('settle')}
        busy={busy}
        onConfirm={() => void go()}
      >
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </ConfirmSheet>

      <ConfirmSheet
        open={pending?.kind === 'dispute'}
        onClose={close}
        title="Dispute the rejection?"
        description="An arbitrator reads the job, the work, the rejection and both statements, then rules. A rejection upheld for a named fault burns your deposit at risk."
        confirm="Dispute"
        busy={busy}
        onConfirm={() => void go()}
      >
        <Field>
          <FieldLabel className="flex-col items-stretch">
            <span>Your case for the arbitrator (optional)</span>
            <Textarea value={statement} onChange={(e) => setStatement(e.target.value)} />
          </FieldLabel>
        </Field>
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </ConfirmSheet>

      <ConfirmSheet
        open={pending?.kind === 'select'}
        onClose={close}
        title={pending?.kind === 'select' ? `Select Agent ID ${pending.agentId}?` : 'Select'}
        description="You sign a selection; no transaction and no money moves now. The job starts when the agent activates it and posts its deposit at risk. If it does not, you can select someone else."
        confirm="Sign the selection"
        busy={busy}
        onConfirm={() => void go()}
      >
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </ConfirmSheet>

      {error !== null && pending === null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {txs !== null && (
        <Section title="Send">
          <TxSteps
            key={`${job.boardId}:${job.taskId}:${txs.kind}`}
            taskId={job.taskId}
            boardId={job.boardId}
            txs={txs.list}
            owner={txs.owner}
            canSend={sourceAvailable}
            onDone={(hashes) => done(txs.kind, hashes)}
          />
        </Section>
      )}
    </>
  )
}

function SettleText({ phase }: { phase: Phase }): ReactNode {
  switch (phase.timeout) {
    case 'completeAfterSilence':
      return 'The review window closed without a decision, so the work is accepted. This pays the agent and returns both deposits at risk. Anyone may send it; you pay a little gas.'
    case 'rejectAfterDeliveryDeadline':
      return "Nothing was delivered in time. This refunds the creator and burns the agent's deposit at risk if it posted one. Anyone may send it; you pay a little gas."
    case 'rejectAfterWindow':
      return 'No dispute was filed in time, so the rejection becomes final and the creator is refunded. Anyone may send it.'
    case 'refundAfterArbitrationTimeout':
      return 'The arbitrator did not rule in time. This refunds the creator and returns both deposits at risk. Anyone may send it.'
    default:
      return 'This releases what the last step left in escrow to whoever it belongs to. Anyone may send it.'
  }
}

function AgentRecord({ agentId }: { agentId: string }) {
  const agents = useAgents()
  const a = agents.data?.agents.find((x) => x.agentId === agentId)
  if (a === undefined) return <span>New agent</span>
  return (
    <span>
      {a.completed} of {a.jobs} jobs paid · earned {earnedLine(a.earned).first}
    </span>
  )
}

function Applications({
  job,
  signedIn,
  onSelect,
}: {
  job: ActionJob
  signedIn: boolean
  onSelect: (applicationId: string, agentId: string) => void
}) {
  const { address } = useAccount()
  const selected = new Set(
    job.selection?.filter((selection) => selection.state === 'signed').map((selection) => selection.applicationId) ??
      [],
  )
  const apps = useQuery({
    queryKey: boardKey(job.boardId, 'applications', job.boardId, job.taskId, address?.toLowerCase(), signedIn),
    queryFn: () =>
      boardApi(job.boardId).tool<Array<{ id: string; worker: string; agent_id: string; note: string }>>(
        'list_applications',
        {
          taskId: job.taskId,
        },
      ),
    enabled: signedIn && address !== undefined,
    refetchInterval: 15_000,
  })
  // Agents this creator has paid before (on-chain), listed first: the one a Hire again asked for is among them.
  const { items } = useJobs()
  const hiredBefore = new Set(
    items.flatMap(({ chain }) =>
      chain !== undefined &&
      paidJob(chain) &&
      chain.agent_id !== null &&
      address !== undefined &&
      chain.creator?.toLowerCase() === address.toLowerCase()
        ? [chain.agent_id]
        : [],
    ),
  )
  const list = (apps.data ?? []).toSorted(
    (a, b) => Number(hiredBefore.has(b.agent_id)) - Number(hiredBefore.has(a.agent_id)),
  )
  return (
    <Section
      title={`Applications${list.length > 0 ? ` · ${list.length}` : ''}`}
      note={
        selected.size > 0
          ? 'Selection is signed, not an activation. Other unexpired selections remain usable until one worker activates.'
          : 'Agents apply over MCP. Select one: you sign, no transaction; it starts when the agent activates.'
      }
    >
      {selected.size === 0 && job.selection?.some((selection) => selection.state === 'expired') && (
        <p role="status" className="mb-2 rounded-lg bg-warning/14 px-3 py-2 text-sm text-warning-text">
          The previous selection expired before activation. You can select an applicant again.
        </p>
      )}
      {selected.size === 0 && job.selection?.some((selection) => selection.state === 'invalid') && (
        <p role="status" className="mb-2 rounded-lg bg-warning/14 px-3 py-2 text-sm text-warning-text">
          The previous selection is no longer valid for this offer. No worker activation is confirmed.
        </p>
      )}
      {job.selection?.some((selection) => selection.state === 'unavailable') && (
        <p role="status" className="mb-2 rounded-lg bg-warning/14 px-3 py-2 text-sm text-warning-text">
          Selection verification is unavailable. A stored signature is not proof the worker can still activate.
        </p>
      )}
      {apps.isLoading ? null : list.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No applications yet</EmptyTitle>
            <EmptyDescription>Agents that apply show up here with their record.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup>
          {list.map((a) => (
            <Item key={a.id} className="before:left-14">
              <ItemMedia>
                <AgentOrb agentId={a.agent_id} />
              </ItemMedia>
              <ItemContent className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <BoardLink target={boardRoutes().agent(a.agent_id)} className="font-medium">
                    <AgentLabel id={a.agent_id} />
                  </BoardLink>
                  {hiredBefore.has(a.agent_id) && <Badge variant="info">Hired before</Badge>}
                </span>
                <ItemDescription className="block text-ui text-muted-foreground">
                  <AgentRecord agentId={a.agent_id} />
                </ItemDescription>
                {a.note !== '' && <span className="block text-sm text-muted-foreground">“{a.note}”</span>}
              </ItemContent>
              {selected.has(a.id) ? (
                <Badge variant="success">Selected</Badge>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => onSelect(a.id, a.agent_id)}>
                  Select
                </Button>
              )}
            </Item>
          ))}
        </ItemGroup>
      )}
    </Section>
  )
}
