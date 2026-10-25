import { boardKey, viewerKey, publicKey } from '../queries.ts'
import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Skeleton } from '../components/ui/skeleton.tsx'
import { cn } from '../lib/cn.ts'
import { ItemGroup } from '../components/ui/item.tsx'
import { Row, Section, TxLink, shortAddress, textLinkClass } from '../components/kit.tsx'
import {
  type JobAction,
  type LifecycleInput,
  type Phase,
  lifecycle,
  lifecycleFromIndexed,
  lifecycleFromTask,
} from '@sidequest/react'
import { useQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight, CircleAlert, Clock, Lock } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import type { Address as Account } from 'viem'
import {
  DELIVERABLE_KINDS,
  type Deliverable,
  type DeliverableCheck,
  type TaskIndexEntry,
  boardApi,
  currentBoardId,
  data,
} from '../api.ts'
import { BoardLink, boardRoutes } from '../components/BoardLink.tsx'
import { BudgetPanel } from '../components/BudgetPanel.tsx'
import { Delivered, type EvidenceRow } from '../components/job/Deliverables.tsx'
import { HireAgainLink } from '../components/job/HireAgain.tsx'
import { LaunchNotice } from '../components/LaunchGate.tsx'
import { FeeQuote, TopUp } from '../components/job/V1Panels.tsx'
import { type ActionJob, type JobEvent, JobActions } from '../components/job/JobActions.tsx'
import type { TimelineEvent } from '../components/job/Timeline.tsx'
import { DeliveryHero, JobStory, Parties, Receipt } from '../components/job/JobParts.tsx'
import { Thread } from '../components/job/Thread.tsx'
import { WalletLink } from '../components/WalletLink.tsx'
import { AgentLabel, useAgentName } from '../components/agent/AgentChip.tsx'
import { PhaseBadge, Sentence } from '../components/Phase.tsx'
import { useNow } from '../components/Time.tsx'

import type { useSignedIn } from '../components/Wallet.tsx'
import { TokenAmount } from '../components/token/TokenAmount.tsx'
import { amount, budgetCap, relative, span, tokenInfo } from '../format.ts'
import { StakePair } from '../components/job/RequestTerms.tsx'
import { sidequest } from '../sidequest.ts'
import { percent } from '../stake.ts'
import { useToken } from '../useTokens.ts'
import { firstParty, writesOpen } from '../wallet.ts'
import { partyLabels } from '../related-party.ts'
import {
  HostedBy,
  JobOfferBrief,
  OfferIdentity,
  jobOfferFields,
  type ForeignOffer,
  type JobOfferFields,
} from '../job-offer.tsx'
import { usePosterAgents } from './Jobs.tsx'
import { JOBS_LABEL } from '../places.ts'
import { jobAttribution, jobListingFallback, taskFromDetail, type FrozenTask } from '../job-detail.ts'

export type { JobEvent }

interface Detail {
  foreign_offer?: ForeignOffer | null

  job: {
    status: string
    kind: 'sidequest-v1' | null
    mode: string | null
    stack: string | null
    worker: string | null
    agent_id: string | null
    deliverable: string | null
    violation: string | null
    rejection_reason_hash: string | null
    creator: string | null
    approver: string | null
    token: string | null
    reward: string | null
    creator_bond: string | null
    worker_bond: string | null
    delivery_deadline: number | null
    selection_deadline: number | null
    published_tx: string | null
    manifest_hash?: string | null
    /** From activation (quoteActivation's terms): the fee rate, the fee and what the agent is paid. */
    fee_bps?: number | null
    fee?: string | null
    net?: string | null
  }
  submission: { deliverable: string; provider: string; tx_hash: string } | null
  evidence: EvidenceRow[]
  ruling: { for_worker: number; slash_loser: number; reason_hash: string; tx_hash: string } | null
  rewards: Array<{ kind: string; recipient: string; amount: string; tx_hash: string }>
  bonds: Array<{ side: string; outcome: string; recipient: string | null; amount: string; tx_hash: string }>
  feedback: { agent_id: string; value: string | null; tag: string | null; recorded: number; tx_hash: string } | null
  timeline?: TimelineEvent[]
  board: { boardId: string; taskId: string } | null
}

/** The board's `get_task` answer, as far as this page reads it. */
interface BoardTask extends FrozenTask {
  chain: {
    status: string
    provider: string | null
    timely: boolean
    submittedAt: number | null
    reviewEndsAt: number | null
    disputeEndsAt: number | null
    arbitrationEndsAt: number | null
    violation: string | null
    listingMatchesOffer: boolean | null
    paused?: boolean
  }
  you: string[] | null
  selection?: ActionJob['selection']
  /** Public: how many agents applied, and who (agent ID, time; never the note). */
  applicationCount?: number
  applicants?: ActionJob['applicants']
  /** Public: the newest signed, unexpired selection, waiting for the agent to activate. */
  pendingSelection?: { agentId: string; activateBy: number } | null
  deliverables?: Array<{
    repo: string
    branch: string
    sha: string
    deliverable_hash: string
    descriptor?: Deliverable
    check?: DeliverableCheck | null
  }>
  evidence?: Array<{ submissionHash: string; label: string }>
}

type Auth = ReturnType<typeof useSignedIn>

const VERDICT: Record<string, string> = {
  clean: 'Looks fine',
  caution: 'Flagged for a closer look',
  reject: 'Flagged as risky',
  unscreened: 'Not screened',
}
const VIOLATION: Record<string, string> = {
  None: 'no fault named',
  Quality: 'not good enough',
  Falsified: 'faked evidence',
}
/** A viewer who is no party to any job: the permissionless steps are exactly what it may send. */
const STRANGER = '0x0000000000000000000000000000000000000001'

/** How a finished job ended, read from its events, so the phase can say "accepted by silence" or "ruled for…". */
function outcomeOf(d: Detail | undefined) {
  const tl = d?.timeline ?? []
  const timeout = tl.find((e) => e.name === 'TimedOut')
  if (d?.ruling != null) return d.ruling.for_worker === 1 ? ('ruled-worker' as const) : ('ruled-creator' as const)
  if (timeout !== undefined) {
    const r = String(timeout.args.reason)
    if (r.startsWith('0x7265766965772d')) return 'silence' as const // "review-…"
    if (r.startsWith('0x64656c6976657279')) return 'missed' as const // "delivery…"
    if (r.startsWith('0x6172626974726174696f6e')) return 'arbitration-timeout' as const // "arbitration…"
    return 'rejection-final' as const
  }
  if (tl.some((e) => e.name === 'Accepted')) return 'accepted' as const
  return null
}

export function JobPage({
  auth,
  jobId: given,
  onEvent,
}: {
  auth: Auth
  jobId?: string
  onEvent?: (type: JobEvent, payload: Record<string, unknown>) => void
}) {
  const params = useParams({ strict: false }) as { jobId?: string }
  const jobId = given ?? params.jobId ?? ''
  const now = useNow()
  const chain = useQuery({
    queryKey: publicKey('job', jobId),
    queryFn: () => data<Detail>(`jobs/${jobId}`),
    refetchInterval: 15_000,
    enabled: /^\d+$/.test(jobId),
  })
  const d = chain.data
  /**
   * The indexed job detail includes its board and task attribution. Only missing attribution needs the
   * board index scan: it keeps newly published/local offers visible while avoiding the full jobs and task-index reads
   * on the normal detail path. The selected row is immutable offer metadata; chain/detail remains authoritative.
   */
  const listingFallback = useQuery(jobListingFallback(currentBoardId(), jobId, chain.isFetched && d?.board == null))
  // The offer lives on the board it was frozen on, which may not be the one this page is on.
  const { boardId, taskId, local } = jobAttribution(currentBoardId(), d?.board, listingFallback.data)
  const board = useQuery({
    queryKey: boardKey(boardId, 'get_task', boardId, taskId, auth.address?.toLowerCase(), auth.signedIn),
    queryFn: () => boardApi(boardId).tool<BoardTask>('get_task', { taskId }),
    enabled: taskId !== undefined,
    refetchInterval: 15_000,
  })
  const t = board.data
  const listed = taskFromDetail(t, jobId, local)
  const roles = auth.signedIn ? (t?.you ?? []) : []

  let input: LifecycleInput | null = null
  if (t !== undefined && !board.isError) {
    const lifecycleTask = lifecycleFromTask(t)
    if (
      roles.includes('creator') &&
      auth.address !== undefined &&
      lifecycleTask.parties.creator?.toLowerCase() !== auth.address.toLowerCase()
    ) {
      lifecycleTask.parties = { ...lifecycleTask.parties, creator: auth.address }
    }
    input = { ...lifecycleTask, outcome: outcomeOf(d) }
  } else if (d !== undefined) {
    const settlePending = ['rejected', 'cancelled', 'expired'].includes(d.job.status) && d.rewards.length === 0
    input = { ...lifecycleFromIndexed(d.job), outcome: outcomeOf(d), settlePending }
  }
  const phase: Phase | null =
    input === null ? null : lifecycle(input, auth.signedIn ? (auth.address ?? null) : null, now)
  // What this wallet could send once signed in (with no wallet yet, what any signed-in stranger could): offered as a
  // sign-in action, never as a button that does nothing.
  const afterSignIn: JobAction[] =
    input === null || auth.signedIn ? [] : lifecycle(input, auth.address ?? STRANGER, now).actions

  const selection = auth.signedIn ? t?.selection : undefined
  const waitingForActivation =
    !board.isError &&
    !chain.isError &&
    phase?.key === 'hire-open' &&
    t?.chain.provider === null &&
    (selection?.some((record) => record.state === 'signed') === true || (t?.pendingSelection ?? null) !== null)
  const picked = t?.pendingSelection ?? null

  const offer = jobOfferFields({
    jobId,
    local: listed,
    detail: t,
    foreign: d?.foreign_offer,
    chainHash: d?.job.manifest_hash,
  })
  const title = offer.title
  const screening = listed?.screening ?? t?.screening
  const reward = d?.job.reward ?? listed?.reward ?? null
  const token = d?.job.token ?? listed?.token ?? null
  // A token nobody listed (ADR-0010) is read from the chain once, so every amount on the page has its decimals.
  useToken(token)
  const agentId = d?.job.agent_id ?? null
  const creator = d?.job.creator ?? listed?.creator ?? null
  const posters = usePosterAgents()
  const posterAgent =
    listed?.creatorAgentId ?? (creator === null ? undefined : posters.get(creator.toLowerCase())) ?? null
  const delivered = d?.job.deliverable != null
  const otherBoard = d?.board != null && d.board.boardId !== currentBoardId() && d.board.boardId !== 'public'

  if (!/^\d+$/.test(jobId)) {
    return (
      <>
        <Back />
        <h1 className="font-display text-3xl leading-tight font-normal tracking-tight [overflow-wrap:break-word] min-w-0">
          That is not a Job ID
        </h1>
        <p>Jobs use a number, like 84.</p>
      </>
    )
  }
  if ((chain.isLoading || listingFallback.isLoading || board.isLoading) && listed === undefined) return <JobSkeleton />
  if (d !== undefined && d.job.kind !== 'sidequest-v1') {
    return (
      <>
        <Back />

        <div className="grid gap-2 rounded-2xl bg-card p-6 text-center">
          <p className="font-semibold">Job #{jobId} is on an earlier contract</p>
          <p className="text-sm text-muted-foreground">Sidequest shows jobs on its v1 contracts only.</p>
        </div>
      </>
    )
  }
  if (chain.data === undefined && listed === undefined && !chain.isLoading) {
    return (
      <>
        <Back />

        <div className="grid gap-2 rounded-2xl bg-card p-6 text-center">
          <p className="font-semibold">
            {chain.isError ? 'Chain job details are unavailable' : `Job #${jobId} is not indexed yet`}
          </p>
          <p className="text-sm text-muted-foreground">
            {chain.isError
              ? 'The chain index could not be read. This does not mean the job is still in progress or unpaid.'
              : 'A newly published job appears about a minute after its block is final.'}
          </p>
          <Button variant="secondary" onClick={() => void chain.refetch()}>
            Retry job details
          </Button>
        </div>
      </>
    )
  }

  return (
    <>
      <Back />

      {chain.isError && (
        <div role="status" className="grid gap-2 rounded-xl bg-warning/14 p-4 text-sm text-warning-text">
          <p>
            Chain job details are unavailable.
            {d === undefined
              ? ' Payment history cannot be confirmed from the index.'
              : ` Showing last-known indexed facts from ${new Date(chain.dataUpdatedAt).toLocaleString()}.`}
          </p>
          <Button variant="secondary" onClick={() => void chain.refetch()}>
            Retry job details
          </Button>
        </div>
      )}

      {board.isError && (
        <div role="status" className="grid gap-2 rounded-xl bg-warning/14 p-4 text-sm text-warning-text">
          <p>
            Board details are unavailable.{' '}
            {d !== undefined
              ? 'Showing indexed chain facts instead; actions are paused until the offer refreshes.'
              : 'Offer terms and actions cannot be confirmed.'}
          </p>
          <Button variant="secondary" onClick={() => void board.refetch()}>
            Retry offer details
          </Button>
        </div>
      )}

      <header className="grid min-w-0 gap-2">
        <h1 className="font-display text-3xl leading-tight font-normal tracking-tight [overflow-wrap:break-word] min-w-0 text-balance sm:text-4xl">
          {title}
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {waitingForActivation ? (
            <>
              <Badge variant="success">Selected</Badge>
              <span>On-chain: Open</span>
            </>
          ) : (
            <PhaseBadge phase={phase} />
          )}
          {title !== `Job #${jobId}` && <span>Job #{jobId}</span>}
          <span>
            {listed?.quoted === true || d?.foreign_offer?.terms.quote != null ? 'Hired from quotes' : 'Direct hire'}
          </span>
          <HostedBy origin={offer.origin} />
          {otherBoard && <Badge variant="info">{d?.board?.boardId}</Badge>}
          {partyLabels({ jobId, creator, posterAgent, workerAgent: agentId }, firstParty).map((label) => (
            <Badge
              key={label}
              variant="warning"
              title={
                label === 'Related party'
                  ? "Both sides are Sidequest's own wallets or crew agents"
                  : "A demo hire run by Sidequest's founder"
              }
            >
              {label}
            </Badge>
          ))}
          {roles.map((r) => (
            <Badge key={r} variant="info">
              You: {r}
            </Badge>
          ))}
        </div>
        <Parties
          creator={creator}
          posterAgent={posterAgent}
          workerAgent={agentId !== null && agentId !== '0' ? agentId : null}
          paid={phase?.key === 'completed'}
        />
      </header>

      {waitingForActivation ? (
        <div role="status" className="grid gap-1 rounded-xl bg-card px-4 py-3.5">
          <p className="font-semibold">
            {picked === null ? (
              'Selected, waiting for worker activation'
            ) : (
              <>
                Selected: <AgentLabel id={picked.agentId} />, waiting for activation
              </>
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            {selection?.some((record) => record.state === 'signed') === true
              ? 'Your signed selection is saved. The worker must activate before its cutoff; the job remains Open on-chain until then.'
              : `The creator signed this selection. The agent must activate ${picked === null ? 'before its cutoff' : relative(picked.activateBy)}; the job remains Open on-chain until then.`}
          </p>
        </div>
      ) : (
        phase !== null && <NextStep phase={phase} />
      )}

      {/* One column on a phone (the work, the money, the rest); two once the column holds 56rem, the money and milestones beside. */}
      <div className="@container/detail min-w-0">
        <div
          className={cn(
            'grid min-w-0 gap-7 @4xl/detail:grid-cols-[minmax(0,1fr)_19rem] @4xl/detail:grid-rows-[auto_1fr] @4xl/detail:gap-x-8',
            delivered
              ? "[grid-template-areas:'hero'_'side'_'body'] @4xl/detail:[grid-template-areas:'hero_side'_'body_side']"
              : "[grid-template-areas:'side'_'body'] @4xl/detail:[grid-template-areas:'body_side'_'body_side']",
          )}
        >
          {delivered && (
            <div className="grid min-w-0 content-start gap-7 [grid-area:hero]">
              <DeliveryHero where={{ boardId, taskId, hash: d?.job.deliverable }} jobId={jobId} />
              <Delivered
                deliverables={(t?.deliverables ?? []).map((x) => ({
                  deliverable_hash: x.deliverable_hash,
                  descriptor: x.descriptor ?? { kind: 'git', url: x.repo, ref: x.branch, sha: x.sha },
                  check: x.check ?? null,
                }))}
                evidence={d?.evidence ?? []}
              />
            </div>
          )}

          <aside className="grid min-w-0 content-start gap-4 [grid-area:side] @4xl/detail:sticky @4xl/detail:top-6 @4xl/detail:self-start">
            {d === undefined ? (
              reward !== null && (
                <Receipt>
                  <Money phase={phase} reward={reward} token={token} agentId={agentId} charge={chargeOf(d)} />
                </Receipt>
              )
            ) : (
              <JobStory
                events={d.timeline ?? []}
                phase={phase}
                job={{ token, reward, agentId, deliveryDeadline: d.job.delivery_deadline, creator: d.job.creator }}
                money={
                  reward === null ? undefined : (
                    <Money phase={phase} reward={reward} token={token} agentId={agentId} charge={chargeOf(d)} />
                  )
                }
              />
            )}
          </aside>

          <div className="grid min-w-0 content-start gap-7 [grid-area:body]">
            {screening !== undefined && (screening.verdict === 'reject' || screening.verdict === 'caution') && (
              // The verdict is advice, but a worker deciding whether to take the job should see it before the brief.
              // Advice, not a block: the screener also flags ordinary briefs (a competitive teardown, job 16), so not red.
              <Alert>
                <CircleAlert aria-hidden />
                <AlertTitle>
                  {screening.verdict === 'reject'
                    ? 'An AI screener flagged this brief as risky'
                    : 'An AI screener flagged this brief for a closer look'}
                </AlertTitle>
                <AlertDescription className="[overflow-wrap:anywhere]">
                  {screening.reasons[0] !== undefined && <span className="block">{screening.reasons[0]}</span>}
                  Its verdict is advice; read the brief before you take the job.
                </AlertDescription>
              </Alert>
            )}

            {offer.brief !== undefined && (
              <Section title="The job">
                <JobOfferBrief offer={offer} met={phase?.key === 'completed'} />
              </Section>
            )}

            {taskId !== undefined && <Thread boardId={boardId} taskId={taskId} jobId={jobId} />}

            {d !== undefined && (d.job.violation !== null || d.ruling !== null) && (
              <Dispute d={d} boardId={boardId} taskId={taskId} auth={auth} isParty={roles.length > 0} />
            )}

            {writesOpen &&
              phase?.key === 'completed' &&
              agentId !== null &&
              auth.address !== undefined &&
              creator?.toLowerCase() === auth.address.toLowerCase() && (
                <div className="grid gap-1.5">
                  <HireAgainLink jobId={jobId} />
                  <p className="px-4 text-ui text-muted-foreground">
                    A new direct hire of Agent ID {agentId} with the same token, reward and terms. You review it before
                    anything is sent.
                  </p>
                </div>
              )}

            {writesOpen &&
              phase?.key === 'hire-open' &&
              auth.signedIn &&
              auth.address !== undefined &&
              !roles.includes('creator') && (
                <FeeQuote jobId={jobId} holding={sidequest.holding} viewer={auth.address as Account} token={token} />
              )}

            {writesOpen &&
              token !== null &&
              auth.signedIn &&
              auth.address !== undefined &&
              phase !== null &&
              !phase.terminal &&
              ['active', 'submitted'].includes(t?.chain.status ?? '') && (
                <TopUp
                  boardId={boardId}
                  jobId={jobId}
                  holding={sidequest.holding}
                  token={token as Account}
                  viewer={auth.address as Account}
                />
              )}

            {writesOpen && listed !== undefined && listed.executionBudget !== null && boardId === currentBoardId() && (
              <BudgetPanel
                task={listed}
                status={t?.chain.status ?? d?.job.status ?? 'unknown'}
                roles={roles}
                signedIn={auth.signedIn}
                address={auth.address}
              />
            )}

            <Details d={d} listed={listed} t={t} offer={offer} viewer={auth.address} />
          </div>
        </div>
      </div>

      {phase !== null && t !== undefined && taskId !== undefined && !writesOpen && <LaunchNotice />}

      {writesOpen && phase !== null && t !== undefined && taskId !== undefined && (
        <JobActions
          job={{
            jobId,
            taskId,
            boardId,
            reward,
            token,
            creatorBond: d?.job.creator_bond ?? listed?.creatorBond ?? null,
            workerBond: d?.job.worker_bond ?? listed?.workerBond ?? null,
            agentId,
            disputeSeconds: t.terms.windows?.disputeSeconds ?? null,
            charge: chargeOf(d),
            selection,
            applicants: t.applicants,
          }}
          phase={phase}
          roles={roles}
          auth={auth}
          afterSignIn={afterSignIn}
          sourceAvailable={!board.isError && !chain.isError}
          onEvent={onEvent}
        />
      )}
    </>
  )
}

function Back() {
  return (
    <BoardLink
      target={boardRoutes().jobs()}
      className={cn(textLinkClass, '-mt-2.5 -mb-[1.125rem] inline-flex w-fit items-center gap-0.5 py-2.5')}
    >
      <ChevronLeft aria-hidden className="-ml-1.5 size-5" strokeWidth={2.4} />
      {JOBS_LABEL}
    </BoardLink>
  )
}

function JobSkeleton() {
  return (
    <>
      <Back />
      <output className="sr-only">Loading job details</output>
      <header className="grid min-w-0 gap-2" aria-hidden>
        <Skeleton className="h-14 w-4/5 sm:h-8" />
        <Skeleton className="h-6 w-3/5" />
        <Skeleton className="h-5 w-2/5" />
      </header>
      <div className="@container/detail min-w-0" aria-hidden>
        <div className="grid min-w-0 gap-7 @4xl/detail:grid-cols-[minmax(0,1fr)_19rem] @4xl/detail:gap-x-8">
          <div className="grid content-start gap-7">
            <Skeleton className="h-64 rounded-xl" />
            <Skeleton className="h-40 rounded-xl" />
          </div>
          <div className="grid content-start gap-4">
            <Skeleton className="h-24 rounded-2xl" />
            <Skeleton className="h-40 rounded-xl" />
          </div>
        </div>
      </div>
    </>
  )
}

/** The job's fee, fixed at activation; null before it. */
type Charge = { bps: number; fee: string; net: string } | null
const chargeOf = (d: Detail | undefined): Charge =>
  d?.job.fee_bps == null || d.job.fee == null || d.job.net == null
    ? null
    : { bps: d.job.fee_bps, fee: d.job.fee, net: d.job.net }

/**
 * Where the reward is: locked in escrow, paid, or back with the creator. The agent is paid the reward less Sidequest's
 * fee (D11), so once the fee is fixed the paid amount is that net, never the reward.
 */
function Money({
  phase,
  reward,
  token,
  agentId,
  charge,
}: {
  phase: Phase | null
  reward: string
  token: string | null
  agentId: string | null
  charge: Charge
}) {
  const terminal = phase?.terminal === true
  const draft = phase?.key === 'draft' || phase?.key === 'draft-stale'
  const paid = phase?.key === 'completed'
  const name = useAgentName(agentId ?? '')
  const agent = agentId === null ? 'the agent' : (name ?? `Worker #${agentId}`)
  const afterFee = charge === null ? '' : ` less Sidequest’s ${percent(charge.bps)} fee`
  const where = draft
    ? 'Not locked yet: publishing locks it in escrow'
    : paid
      ? charge === null
        ? `Paid to ${agent}`
        : `Paid to ${agent}: the ${amount(reward, token)} reward${afterFee}`
      : terminal
        ? 'Back with the creator'
        : phase === null
          ? 'Chain payment status unavailable'
          : charge === null
            ? `Locked in escrow · paid to ${agent} when the work is accepted`
            : `Locked in escrow · ${agent} gets ${amount(charge.net, token)} when the work is accepted, after Sidequest’s ${percent(charge.bps)} fee`
  return (
    <div className="relative grid min-w-0 gap-2 p-4">
      {paid && <span className="stamp-paid absolute top-4 right-4">Paid</span>}
      <span className="min-w-0">
        <span className="tabular-nums block text-3xl leading-none font-semibold tracking-tight [overflow-wrap:break-word]">
          {/* At large text sizes on a phone the amount wraps rather than widen the page. */}
          <TokenAmount
            value={paid && charge !== null ? charge.net : reward}
            token={token}
            className="whitespace-normal"
          />
        </span>
        <span className="mt-2 flex items-start gap-1.5 text-sm text-pretty text-muted-foreground">
          {!terminal && !draft && <Lock aria-hidden className="mt-0.5 size-3.5 shrink-0" />}
          {where}
        </span>
        {token !== null && tokenInfo(token).unverified === true && (
          <span className="mt-1 block text-ui text-muted-foreground [overflow-wrap:anywhere]">
            Unverified token {token}: anyone can deploy a token under any name
          </span>
        )}
      </span>
    </div>
  )
}

/** What happens next and who acts: addressed to the viewer when it is theirs to do. */
function NextStep({ phase }: { phase: Phase }) {
  if (phase.terminal && phase.actions.length === 0) {
    return (
      <p className="px-1 text-sm leading-relaxed text-muted-foreground">
        <Sentence parts={phase.next} />
      </p>
    )
  }
  const you = phase.youAct && phase.toYou !== null
  return (
    <div className="grid gap-2">
      <div
        className={cn('flex gap-3 rounded-2xl px-4 py-3.5 leading-relaxed', you ? 'bg-warning/14' : 'bg-primary/10')}
      >
        {you ? (
          <CircleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-warning-text" />
        ) : (
          <Clock aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" />
        )}
        <p>
          {you && <span className="font-semibold">You: </span>}
          <Sentence parts={you ? (phase.toYou ?? phase.next) : phase.next} />
        </p>
      </div>
      {phase.warnings.map((w) => (
        <p key={w} role="alert" className="rounded-xl bg-destructive/12 px-4 py-2.5 text-sm text-destructive-text">
          {w}
        </p>
      ))}
    </div>
  )
}

function Dispute({
  d,
  boardId,
  taskId,
  auth,
  isParty,
}: {
  d: Detail
  boardId: string
  taskId: string | undefined
  auth: Auth
  isParty: boolean
}) {
  const bundle = useQuery({
    queryKey: boardKey(boardId, 'bundle', boardId, taskId, viewerKey(auth.address, auth.signedIn)),
    queryFn: () =>
      boardApi(boardId).tool<{
        bundle: { rejection: { reasonText: string | null }; statements: Array<{ role: string; text: string }> }
      }>('get_dispute_bundle', { taskId }),
    enabled: auth.signedIn && isParty && taskId !== undefined && d.job.violation !== null,
    retry: false,
  })
  const reason = bundle.data?.bundle.rejection.reasonText
  return (
    <Section
      title="Rejection and dispute"
      note={
        reason === undefined || reason === null
          ? 'The written reason is shown to the creator, the approver and the agent; everyone else sees its fingerprint on-chain.'
          : undefined
      }
    >
      <ItemGroup role="presentation" className="px-4 py-2">
        {d.job.violation !== null && <Row label="Rejected as">{VIOLATION[d.job.violation] ?? d.job.violation}</Row>}
        <Row label="Reason">
          {reason ?? (
            <span className="font-mono text-ui">{d.job.rejection_reason_hash?.slice(0, 14) ?? 'unknown'}…</span>
          )}
        </Row>
        {bundle.data?.bundle.statements.map((s, i) => (
          <Row key={i} label={`${s.role[0]?.toUpperCase()}${s.role.slice(1)}'s statement`}>
            {s.text}
          </Row>
        ))}
        {d.ruling !== null && (
          <Row label="Ruling">
            <span className="inline-flex flex-wrap items-center justify-end gap-2">
              <Badge variant={d.ruling.for_worker === 1 ? 'success' : 'destructive'}>
                {d.ruling.for_worker === 1 ? 'For the agent' : 'For the creator'}
              </Badge>
              {d.ruling.slash_loser === 1 && (
                <Badge variant="destructive">
                  {d.ruling.for_worker === 1
                    ? 'Creator’s deposit at risk sent to the treasury'
                    : 'Agent’s deposit at risk sent to the treasury'}
                </Badge>
              )}
              <TxLink hash={d.ruling.tx_hash} />
            </span>
          </Row>
        )}
      </ItemGroup>
    </Section>
  )
}

/** Who pays and judges, by wallet (each opening its card), and the hired agent's wallet. */
function PeopleRows({
  d,
  listed,
  viewer,
}: {
  d: Detail | undefined
  listed: TaskIndexEntry | undefined
  viewer: string | undefined
}) {
  const creator = d?.job.creator ?? listed?.creator ?? null
  const approver = d?.job.approver ?? listed?.approver ?? null
  const me = (a: string) => viewer !== undefined && a.toLowerCase() === viewer.toLowerCase()
  return (
    <>
      {creator !== null && (
        <Row label="Creator" hint="Pays, and approves unless an approver is named">
          <WalletLink address={creator} />
          {me(creator) && <span className="block text-ui">You</span>}
        </Row>
      )}
      {approver !== null && creator !== null && approver.toLowerCase() !== creator.toLowerCase() && (
        <Row label="Approver" hint="Judges the work">
          <WalletLink address={approver} />
          {me(approver) && <span className="block text-ui">You</span>}
        </Row>
      )}
      {d?.job.worker != null && (
        <Row label="Agent wallet">
          <span className="font-mono text-ui">{shortAddress(d.job.worker)}</span>
        </Row>
      )}
    </>
  )
}

/** A deposit as SIDE base units, or null when the job has not said. */
const sideBase = (value: string | null | undefined) => (value === null || value === undefined ? null : BigInt(value))
/** The deposits each side put at risk on the job. */
function Deposits({ d, listed }: { d: Detail | undefined; listed: TaskIndexEntry | undefined }) {
  return (
    <div className="grid gap-2 py-2 text-sm">
      <span>
        Deposits at risk
        <span className="block text-xs text-muted-foreground">
          Returned unless a ruling or a missed deadline sends one to the treasury
        </span>
      </span>
      <StakePair
        creator={sideBase(d?.job.creator_bond ?? listed?.creatorBond)}
        worker={sideBase(d?.job.worker_bond ?? listed?.workerBond)}
      />
    </div>
  )
}

function Details({
  d,
  listed,
  t,
  offer,
  viewer,
}: {
  d: Detail | undefined
  listed: TaskIndexEntry | undefined
  t: BoardTask | undefined
  offer: JobOfferFields
  viewer: string | undefined
}) {
  const screening = listed?.screening ?? t?.screening
  const windows = offer.windows
  return (
    <details className="group rounded-xl bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 font-medium [&::-webkit-details-marker]:hidden">
        Details
        <ChevronRight aria-hidden className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
      </summary>
      <div className="border-t-[0.5px] border-border px-4 py-2">
        <PeopleRows d={d} listed={listed} viewer={viewer} />
        {windows !== undefined && (
          <Row label="Windows">
            <span className="grid justify-items-end">
              <span>review {span(windows.reviewSeconds)}</span>
              <span>dispute {span(windows.disputeSeconds)}</span>
              <span>arbitration {span(windows.arbitrationSeconds)}</span>
            </span>
          </Row>
        )}
        <Deposits d={d} listed={listed} />
        {listed?.executionBudget != null && (
          <Row label="Running-cost budget">up to {budgetCap(listed.executionBudget)}, not escrowed</Row>
        )}
        {listed !== undefined && (
          <Row label="Deliver as">
            {(listed.deliverable?.accepts ?? ['git'])
              .map((k) => DELIVERABLE_KINDS.find((x) => x.kind === k)?.label ?? k)
              .join(', ')}
            {listed.deliverable?.target !== undefined && (
              <span className="block text-ui">{listed.deliverable.target}</span>
            )}
          </Row>
        )}
        {listed !== undefined && listed.requiredChecks.length > 0 && (
          <Row label="Required GitHub check">{listed.requiredChecks.join(', ')}</Row>
        )}
        {screening !== undefined && (
          <Row label="Screening" hint="An AI screener reads every brief; its verdict is advice">
            {VERDICT[screening.verdict] ?? screening.verdict}
            {screening.reasons.length > 0 && <span className="block text-ui">{screening.reasons.join(' · ')}</span>}
          </Row>
        )}
        <Row label="Offer ID">
          <OfferIdentity offer={offer} />
        </Row>
        {d?.job.published_tx != null && (
          <Row label="Published">
            <TxLink hash={d.job.published_tx} />
          </Row>
        )}
        {d?.submission != null && (
          <Row label="On-chain delivery">
            <span className="font-mono text-ui">{d.submission.deliverable.slice(0, 14)}…</span>{' '}
            <TxLink hash={d.submission.tx_hash} />
          </Row>
        )}
      </div>
    </details>
  )
}
