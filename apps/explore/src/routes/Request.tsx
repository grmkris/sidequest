import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { cn } from '../lib/cn.ts'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '../components/ui/empty.tsx'
import { Item, ItemGroup, ItemDescription, ItemContent, ItemMedia } from '../components/ui/item.tsx'
import { LoadingRows, PageTitle, Section, shortAddress, textLinkClass } from '../components/kit.tsx'
import { useQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { Check, ChevronLeft, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { parseUnits } from 'viem'
import {
  type DeliverableKind,
  type DeliverableSpec,
  type Quote,
  type QuoteRequest,
  type TxRequest,
  currentBoardId,
  tool,
} from '../api.ts'
import { BoardLink, boardRoutes, useBoardNavigate } from '../components/BoardLink.tsx'
import { humanAmount, relative } from '../format.ts'
import { Mark, Switch } from '../components/controls.tsx'
import { verdictText } from '../screening.ts'
import { SignIn } from '../components/SignIn.tsx'
import { ConfirmSheet, useToast } from '../components/Sheet.tsx'
import { When, useNow } from '../components/Time.tsx'
import { PostingSteps } from '../components/post/PostingSteps.tsx'
import { RollingCountdown } from '../components/RollingCountdown.tsx'
import { useQuoteRequests } from '../quote-requests.ts'
import { usePosterAgents } from './Jobs.tsx'
import { postedJustNow } from '../job-list.ts'

import type { useSignedIn } from '../components/Wallet.tsx'
import { AgentOrb } from '../components/agent/AgentOrb.tsx'
import { AgentLabel, AgentLink } from '../components/agent/AgentChip.tsx'
import { TokenAmount } from '../components/token/TokenAmount.tsx'
import { TOKENS } from '../format.ts'
import { writesOpen } from '../wallet.ts'
import { useAgents } from '../agent-summary.ts'
import { useManagedAgents } from '../managed.ts'
import { CreateWithAgent } from '../components/CreateWithAgent.tsx'
import { BondHorizonNotice } from '../components/BondHorizonNotice.tsx'
import { RequestTerms } from '../components/job/RequestTerms.tsx'
import { Brief, Parties } from '../components/job/JobParts.tsx'
import { JOBS_LABEL } from '../places.ts'

type Auth = ReturnType<typeof useSignedIn>
/** What `list_quote_requests` carries beyond the shared type: the request as frozen (checks, deliverable spec). */
type Request = QuoteRequest & { requiredChecks?: string[]; deliverable?: DeliverableSpec }

const symbolOf = (address: string) => TOKENS[address.toLowerCase()]?.symbol ?? shortAddress(address)
const KIND_LABEL: Record<DeliverableKind, string> = {
  git: 'Git commit',
  patch: 'Patch',
  artifact: 'File',
  url: 'Live URL',
  onchain: 'On-chain',
}

interface Picked {
  taskId: string
  termsHash: string
  screening: { verdict: string; reasons: string[] } | null
  transactions: TxRequest[]
}

/** The cheapest quote in each token, when there is more than one quote in it to compare. */
function lowestIds(quotes: Quote[]): Set<string> {
  const out = new Set<string>()
  const byToken = new Map<string, Quote[]>()
  for (const q of quotes) byToken.set(q.token.toLowerCase(), [...(byToken.get(q.token.toLowerCase()) ?? []), q])
  for (const qs of byToken.values()) {
    if (qs.length < 2) continue
    const units = qs.map((q) => {
      try {
        return parseUnits(q.amount, 18)
      } catch {
        return null
      }
    })
    const min = units.reduce<bigint | null>((m, u) => (u === null ? m : m === null || u < m ? u : m), null)
    qs.forEach((q, i) => {
      if (min !== null && units[i] === min) out.add(q.quoteId)
    })
  }
  return out
}

/**
 * One request. The requester compares every quote (price, the bidder's record on this board, declared running costs)
 * and picks one: the offer is frozen at the quoted price (`pick_quote`), with an execution budget (ADR-0009) only if
 * approved, possibly less than asked; then the publish transactions escrow the reward and the job page selects the
 * bidder. A picked request that was never published can be published later (`publish_transactions`). Everyone else
 * reads the request; quotes stay private to the requester.
 */
export function QuoteRequestPage({ auth }: { auth: Auth }) {
  const { requestId } = useParams({ strict: false }) as { requestId: string }
  const navigate = useBoardNavigate()
  const toast = useToast()
  const now = useNow()
  const boardId = currentBoardId()
  const requests = useQuoteRequests()
  const r = requests.data?.find((x) => x.requestId === requestId) as Request | undefined
  const posters = usePosterAgents()
  const quotes = useQuery({
    queryKey: ['list_quotes', boardId, requestId, auth.signedIn],
    queryFn: () => tool<{ creator: string; picked: string | null; quotes: Quote[] }>('list_quotes', { requestId }),
    enabled: auth.signedIn,
    refetchInterval: 15_000,
  })
  const agents = useAgents()
  const managed = useManagedAgents()

  const [picking, setPicking] = useState<Quote | null>(null)
  const [budgetOn, setBudgetOn] = useState(true)
  const [cap, setCap] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<(Picked & { quote: Quote }) | null>(null)
  const [publish, setPublish] = useState<{ taskId: string; txs: TxRequest[] } | null>(null)
  const [sheet, setSheet] = useState(false)
  const [preparing, setPreparing] = useState(false)

  const me = auth.address?.toLowerCase()
  const list = quotes.data?.quotes ?? []
  // The board exposes the frozen creator so a browser wallet may pick only its own request. A bidder's private view
  // never implies requester ownership, even when another quote is visible in stale UI state.
  const creator = quotes.data?.creator ?? r?.creator
  const mine = me !== undefined && creator !== undefined && creator.toLowerCase() === me
  // Keep the handoff button mounted during refresh. Its sheet validates a fresh owner list before showing any
  // instruction; unmounting it on every fetch would make its own useManagedAgents subscription refetch in a loop.
  const ownedPublisher =
    managed.isSuccess && !managed.isError
      ? managed.data?.agents.find(
          (agent) =>
            agent.state === 'active' &&
            agent.agent_id !== null &&
            agent.address !== null &&
            creator !== undefined &&
            agent.address.toLowerCase() === creator.toLowerCase(),
        )
      : undefined
  const pendingTask = picked?.taskId ?? quotes.data?.picked ?? r?.taskId ?? null
  const pickedTask = useQuery({
    queryKey: ['quote-picked-task', boardId, pendingTask],
    queryFn: () => tool<{ jobId: string | null }>('get_task', { taskId: pendingTask }),
    enabled: pendingTask !== null,
    refetchInterval: 15_000,
  })
  const jobId = pickedTask.data?.jobId ?? null
  // A request someone picked and published is its job now; an old link (inbox, Telegram) lands on that job. The
  // requester mid-publish stays here: their own flow navigates when the publish confirms.
  useEffect(() => {
    if (jobId !== null && picked === null && publish === null) void navigate(boardRoutes().job(jobId))
  }, [jobId, picked, publish])
  const price = picked === null ? null : humanAmount(picked.quote.amount, picked.quote.symbol)

  const record = (agentId: string) => {
    const a = agents.data?.agents.find((x) => x.agentId === agentId)
    if (a === undefined || a.jobs === 0) return 'New agent'
    return `${a.completed} of ${a.jobs} job${a.jobs === 1 ? '' : 's'} paid${a.lost > 0 ? ` · ${a.lost} lost` : ''}`
  }

  const choose = (q: Quote) => {
    setPicking(q)
    setBudgetOn(q.expectedCosts !== null)
    setCap(q.expectedCosts?.amount ?? '')
    setError(null)
  }
  const pick = async () => {
    if (picking === null) return
    setBusy(true)
    setError(null)
    try {
      const withBudget = budgetOn && picking.expectedCosts !== null && cap.trim() !== ''
      const p = await tool<Picked>('pick_quote', {
        requestId,
        quoteId: picking.quoteId,
        ...(withBudget ? { executionBudget: { kind: 'advance', cap: cap.trim() } } : {}),
      })
      setPicked({ ...p, quote: picking })
      setPublish({ taskId: p.taskId, txs: p.transactions })
      setPicking(null)
      setSheet(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  /** A pick from an earlier visit: the board hands out its publish transactions again (a terms hash lists once). */
  const resume = async () => {
    if (pendingTask === null) return
    if (publish !== null && publish.taskId === pendingTask) {
      setSheet(true)
      return
    }
    setPreparing(true)
    setError(null)
    try {
      const x = await tool<{ transactions: TxRequest[] }>('publish_transactions', { taskId: pendingTask })
      setPublish({ taskId: pendingTask, txs: x.transactions })
      setSheet(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPreparing(false)
    }
  }
  const published = async (taskId: string) => {
    const id = await tool<{ jobId: string | null }>('get_task', { taskId }).then(
      (t) => t.jobId,
      () => null,
    )
    setSheet(false)
    toast(price === null ? 'Published · the reward is locked in escrow' : `Published · ${price} locked in escrow`)
    await navigate(id !== null ? boardRoutes().job(id) : boardRoutes().jobs())
  }

  const open = r !== undefined && pendingTask === null && r.quoteDeadline > now
  const status =
    pendingTask !== null ? (
      <Badge variant="success">Quote picked</Badge>
    ) : r === undefined ? (
      <Badge variant="neutral">Closed</Badge>
    ) : open ? (
      <Badge variant="info">Taking quotes</Badge>
    ) : (
      <Badge variant="neutral">Quotes closed</Badge>
    )
  const posterAgent = r === undefined ? null : (r.creatorAgentId ?? posters.get(r.creator.toLowerCase()) ?? null)
  const quotesCount = r?.quotesCount ?? 0

  // The requester's controls lead; anyone else reads the brief first. Quotes stay private either way.
  const quoting = (
    <>
      {!auth.signedIn ? (
        <Section
          title="Quotes"
          note="Agents quote over the board's MCP server with submit_quote; the requester compares them here and picks one."
        >
          <ItemGroup className="grid justify-items-start gap-3 p-4">
            <p className="text-sm leading-snug text-muted-foreground">
              Quotes are private: only the requester sees them. Sign in as the requester to compare and pick.
            </p>
            <SignIn auth={auth} label="Sign in to see quotes" />
          </ItemGroup>
        </Section>
      ) : quotes.isLoading ? (
        <LoadingRows rows={2} />
      ) : quotes.error !== null ? (
        <Alert variant="destructive">
          <AlertDescription>{(quotes.error as Error).message}</AlertDescription>
        </Alert>
      ) : !mine ? (
        <Section
          title={list.length > 0 ? 'Your quote' : 'Quotes'}
          note="Quotes are private: only the requester sees all of them. Agents quote over the board's MCP server with submit_quote."
        >
          {ownedPublisher !== undefined && creator !== undefined && (
            <div className="mb-3 rounded-xl bg-primary/8 p-3">
              <p className="text-sm leading-snug text-muted-foreground">
                This request belongs to your hosted publisher, so the browser wallet cannot pick its private quotes.
              </p>
              <CreateWithAgent context="pick" requestId={requestId} publisherAddress={creator}>
                Choose with your agent
              </CreateWithAgent>
            </div>
          )}
          {list.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Quotes are private</EmptyTitle>
                <EmptyDescription>
                  Only the requester sees the quotes on this request. An agent quotes over MCP; its own quote then shows
                  here.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup>
              {list.map((q) => (
                <QuoteRow key={q.quoteId} q={q} record={record(q.agentId)} lowest={false} />
              ))}
            </ItemGroup>
          )}
        </Section>
      ) : (
        <>
          {pendingTask !== null && (
            <Section title="Picked">
              <ItemGroup>
                <Item className="before:left-14">
                  <ItemMedia>
                    <Mark tone={jobId !== null ? 'ok' : 'warn'} />
                  </ItemMedia>
                  <ItemContent className="min-w-0 flex-1">
                    <span className="block">
                      {picked !== null
                        ? `You picked Worker #${picked.quote.agentId}'s quote of ${price}`
                        : 'You picked a quote'}
                    </span>
                    <ItemDescription className="block text-ui text-muted-foreground">
                      {jobId !== null
                        ? `Published as job #${jobId}.`
                        : 'Not published yet: publish it to lock the reward in escrow.'}
                    </ItemDescription>
                  </ItemContent>
                  {jobId !== null ? (
                    <BoardLink
                      target={boardRoutes().job(jobId)}
                      className={cn(textLinkClass, 'shrink-0 font-semibold')}
                    >
                      Open job
                    </BoardLink>
                  ) : (
                    <Button size="sm" busy={preparing} onClick={() => void resume()}>
                      Publish
                    </Button>
                  )}
                </Item>
              </ItemGroup>
              {error !== null && picking === null && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </Section>
          )}

          <Section
            title={`Quotes · ${list.length}`}
            note={
              r !== undefined ? (
                <>
                  Every quote delivers by <When at={r.deliveryDeadline} show="time" />. The record is each agent&apos;s
                  jobs on this deployment, from chain records.
                </>
              ) : undefined
            }
          >
            {list.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No quotes yet</EmptyTitle>
                  <EmptyDescription>Agents quote over MCP; quotes appear here as they arrive.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <QuoteComparison
                quotes={list}
                record={record}
                onPick={pendingTask === null && writesOpen ? choose : undefined}
              />
            )}
          </Section>
        </>
      )}
    </>
  )
  const publishing = (
    <>
      {sheet && publish !== null && (
        <Section title={price === null ? 'Publish the job' : `Publish and lock ${price}`}>
          <p className="-mt-2 leading-snug text-muted-foreground">
            Your wallet sends these in order. Any backing deposit moves SIDE into the vault first. Publication escrows
            the reward and reserves your creator bond from that backing.
          </p>
          {picked !== null && picked.screening !== null && (
            <p className="text-sm text-muted-foreground">
              Screening: <span className="font-semibold text-foreground">{verdictText(picked.screening.verdict)}</span>{' '}
              (advice only; it never blocks publishing).
            </p>
          )}
          {publish !== null && (
            <PostingSteps
              key={publish.taskId}
              taskId={publish.taskId}
              txs={publish.txs}
              owner={auth.address!}
              onDone={() => void published(publish.taskId)}
            />
          )}
          <p className="text-ui leading-snug text-muted-foreground">
            Next, on the job page: confirm {picked === null ? 'the agent' : `Worker #${picked.quote.agentId}`} (a
            signature, no transaction). Once it has started, you grant any running-cost budget there.
          </p>
        </Section>
      )}
    </>
  )
  const theJob =
    r === undefined ? null : (
      <Section title="The job">
        <Brief brief={r.brief} criteria={r.acceptanceCriteria} met={false} />
      </Section>
    )

  return (
    <>
      <BoardLink
        target={boardRoutes().jobs()}
        className={cn(textLinkClass, '-mt-3 -mb-6 inline-flex items-center gap-0.5 justify-self-start py-3 text-sm')}
      >
        <ChevronLeft aria-hidden className="size-4" />
        {JOBS_LABEL}
      </BoardLink>

      <div className="grid gap-2">
        <PageTitle
          sub={
            <>
              {status}
              {(r?.tags ?? []).map((tag) => (
                <Badge key={tag} variant="neutral" className="capitalize">
                  {tag}
                </Badge>
              ))}
            </>
          }
        >
          {r?.title ?? 'Quote request'}
        </PageTitle>
        {r !== undefined && <Parties creator={r.creator} posterAgent={posterAgent} workerAgent={null} paid={false} />}
      </div>

      {requests.isLoading ? (
        <LoadingRows rows={3} />
      ) : (
        r === undefined &&
        !mine && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>This request is closed</EmptyTitle>
              <EmptyDescription>
                Requests stay listed for a week after quoting closes or a quote is picked.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      )}

      {/* A phone reads the clock, the brief and quotes, then the terms; from 1024 px the clock and terms sit beside. */}
      <div
        className={cn(
          'grid min-w-0 gap-7',
          r !== undefined && 'lg:grid-cols-[minmax(0,1fr)_19rem] lg:grid-rows-[auto_1fr] lg:gap-x-8',
          r === undefined
            ? ''
            : pendingTask === null
              ? "[grid-template-areas:'clock'_'main'_'terms'] lg:[grid-template-areas:'main_clock'_'main_terms']"
              : "[grid-template-areas:'main'_'terms'] lg:[grid-template-areas:'main_terms'_'main_terms']",
        )}
      >
        <div className="grid min-w-0 content-start gap-7 [grid-area:main]">
          {mine ? (
            <>
              {publishing}
              {quoting}
              {theJob}
            </>
          ) : (
            <>
              {theJob}
              {quoting}
            </>
          )}
        </div>
        {r !== undefined && (
          <>
            {pendingTask === null && (
              <section
                aria-label="Quoting"
                className="grid content-start gap-4 self-start rounded-2xl bg-card p-5 ring-1 ring-foreground/10 [grid-area:clock]"
              >
                <div className="grid gap-1">
                  <span className="text-ui text-muted-foreground">{open ? 'Quotes close in' : 'Quotes closed'}</span>
                  {open ? (
                    <RollingCountdown to={r.quoteDeadline} size="display" passed="closed" />
                  ) : (
                    <span className="text-lg font-medium">
                      <When at={r.quoteDeadline} show="time" />
                    </span>
                  )}
                </div>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                  <div className="grid gap-0.5">
                    <dt className="text-ui text-muted-foreground">Budget</dt>
                    <dd className="font-medium tabular-nums">
                      {r.budget === undefined ? (
                        'Open to quotes'
                      ) : (
                        <>
                          Up to <TokenAmount value={r.budget.max} token={r.budget.token} />
                        </>
                      )}
                    </dd>
                    {r.budgetCovered === true && (
                      <dd className="inline-flex items-center gap-1 text-ui text-success-text">
                        <Check aria-hidden className="size-3.5" />
                        Covered
                      </dd>
                    )}
                    {r.budgetCovered === false && (
                      <dd className="inline-flex items-center gap-1 text-ui text-warning-text">
                        <TriangleAlert aria-hidden className="size-3.5" />
                        Not covered
                      </dd>
                    )}
                  </div>
                  <div className="grid gap-0.5">
                    <dt className="text-ui text-muted-foreground">Quotes</dt>
                    <dd className="font-medium tabular-nums">{quotesCount === 0 ? 'None yet' : quotesCount}</dd>
                    <dd className="text-ui text-muted-foreground">Amounts stay private</dd>
                  </div>
                  {r.invite != null && (
                    <div className="col-span-2 grid gap-0.5">
                      <dt className="text-ui text-muted-foreground">Invited to quote</dt>
                      <dd>
                        <AgentLink id={r.invite.agentId} orb />
                      </dd>
                      <dd className="text-ui text-muted-foreground">Anyone else may quote too</dd>
                    </div>
                  )}
                  <div className="col-span-2 grid gap-0.5">
                    <dt className="text-ui text-muted-foreground">Posted</dt>
                    <dd className="font-medium">
                      {r.createdAt === undefined
                        ? '—'
                        : postedJustNow(r.createdAt, now)
                          ? 'Just now'
                          : relative(r.createdAt, now)}
                    </dd>
                  </div>
                </dl>
              </section>
            )}
            <Section title="Terms" className="self-start [grid-area:terms]">
              <RequestTerms
                steps={[
                  ...(r.createdAt === undefined ? [] : [{ label: 'Posted', at: r.createdAt }]),
                  { label: 'Quotes close', at: r.quoteDeadline },
                  { label: 'Deliver by', at: r.deliveryDeadline },
                ]}
                creatorBond={r.creatorBond}
                workerBond={r.workerBond}
                paidIn={
                  r.budget === undefined ? (
                    r.tokens.map(symbolOf).join(', ')
                  ) : (
                    <span className="inline-flex flex-wrap items-center justify-end gap-1">
                      Up to <TokenAmount value={r.budget.max} token={r.budget.token} />
                    </span>
                  )
                }
                deliverAs={(r.deliverable?.accepts ?? ['git']).map((k) => KIND_LABEL[k])}
                checks={r.requiredChecks ?? []}
                requester={r.creator}
                requesterAgent={posterAgent}
                you={r.creator.toLowerCase() === me}
              />
            </Section>
          </>
        )}
      </div>

      <ConfirmSheet
        open={picking !== null}
        onClose={() => {
          if (!busy) setPicking(null)
        }}
        title={picking === null ? 'Pick this quote?' : `Pick Agent ID ${picking.agentId}'s quote?`}
        description={
          picking === null ? undefined : (
            <>
              This fixes the job at{' '}
              <TokenAmount
                value={null}
                token={picking.token}
                text={humanAmount(picking.amount, picking.symbol)}
                className="font-semibold text-foreground"
              />{' '}
              and closes the other quotes. Your wallet then publishes it, which locks that amount in escrow.
            </>
          )
        }
        confirm="Pick this quote"
        onConfirm={() => void pick()}
        busy={busy}
        disabled={picking?.expectedCosts != null && budgetOn && cap.trim() === ''}
      >
        {r !== undefined && (
          <BondHorizonNotice bonded={Number(r.creatorBond) > 0 || Number(r.workerBond) > 0} tone="fix" />
        )}
        {picking !== null &&
          (picking.expectedCosts !== null ? (
            <div className="grid gap-3 rounded-xl bg-muted p-4">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">Approve a running-cost budget</span>
                  <span className="block text-ui text-muted-foreground">
                    Asked:{' '}
                    <TokenAmount
                      value={null}
                      token={picking.expectedCosts.token}
                      text={humanAmount(picking.expectedCosts.amount, picking.expectedCosts.symbol)}
                    />
                    {picking.expectedCosts.note !== '' && ` · ${picking.expectedCosts.note}`}
                  </span>
                </span>
                <Switch checked={budgetOn} onChange={setBudgetOn} label="Approve a running-cost budget" />
              </div>
              {budgetOn && (
                <label className="flex items-center gap-2">
                  <span className="flex-1 text-sm">Up to</span>
                  <Input
                    value={cap}
                    onChange={(e) => setCap(e.target.value)}
                    inputMode="decimal"
                    className="tabular-nums w-28 bg-card text-right"
                  />
                  <span className="w-14 shrink-0 truncate text-muted-foreground">{picking.expectedCosts.symbol}</span>
                </label>
              )}
              <p className="text-ui leading-snug text-muted-foreground">
                Separate from the price, and only if you approve it here: the agent may draw up to this cap from your
                wallet into its own for running costs, until the delivery deadline. You may approve less than it asked.
                Nothing is locked; you grant it on the job page once the agent has started, and can revoke it.
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">This quote declares no running costs.</p>
          ))}
        {error !== null && picking !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </ConfirmSheet>
    </>
  )
}

/** One quote as a row: who, their record, the price and what else they declared. */
function QuoteRow({
  q,
  record,
  lowest,
  onPick,
}: {
  q: Quote
  record: string
  lowest: boolean
  onPick?: (() => void) | undefined
}) {
  return (
    <Item className={cn('items-start py-3')}>
      <ItemMedia>
        <AgentOrb agentId={q.agentId} />
      </ItemMedia>
      <ItemContent className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex items-baseline justify-between gap-3">
          <BoardLink target={boardRoutes().agent(q.agentId)} className="truncate font-medium">
            <AgentLabel id={q.agentId} />
          </BoardLink>
          <TokenAmount
            value={null}
            token={q.token}
            text={humanAmount(q.amount, q.symbol)}
            className="shrink-0 font-semibold"
          />
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui text-muted-foreground">
          {record}
          <WorkerLoad load={q.workerLoad} />
          {lowest && <Badge variant="success">Lowest</Badge>}
        </span>
        {q.expectedCosts !== null && (
          <span className="text-ui text-muted-foreground">
            + running costs up to{' '}
            <TokenAmount
              value={null}
              token={q.expectedCosts.token}
              text={humanAmount(q.expectedCosts.amount, q.expectedCosts.symbol)}
            />
            {q.expectedCosts.note !== '' && ` · ${q.expectedCosts.note}`}
          </span>
        )}
        {q.note !== '' && <span className="text-sm leading-snug [overflow-wrap:anywhere]">{q.note}</span>}
        {onPick !== undefined && (
          <Button size="sm" variant="secondary" onClick={onPick} className="mt-1.5 justify-self-start">
            Pick
          </Button>
        )}
      </ItemContent>
    </Item>
  )
}

/** Side by side on a wide screen, as rows on a phone. */
function QuoteComparison({
  quotes,
  record,
  onPick,
}: {
  quotes: Quote[]
  record: (agentId: string) => string
  onPick?: ((q: Quote) => void) | undefined
}) {
  const lowest = lowestIds(quotes)
  return (
    <>
      <ItemGroup className="sm:hidden">
        {quotes.map((q) => (
          <QuoteRow
            key={q.quoteId}
            q={q}
            record={record(q.agentId)}
            lowest={lowest.has(q.quoteId)}
            onPick={onPick === undefined ? undefined : () => onPick(q)}
          />
        ))}
      </ItemGroup>

      <div className="hidden gap-3 sm:grid sm:grid-cols-2 lg:grid-cols-3">
        {quotes.map((q) => (
          <article key={q.quoteId} className="grid content-start gap-3 rounded-xl bg-card p-4">
            <header className="flex items-center gap-3">
              <AgentOrb agentId={q.agentId} />
              <span className="min-w-0">
                <BoardLink target={boardRoutes().agent(q.agentId)} className="block truncate font-medium">
                  <AgentLabel id={q.agentId} />
                </BoardLink>
                <span className="block text-ui text-muted-foreground">{record(q.agentId)}</span>
              </span>
            </header>
            <div className="grid gap-1">
              <span className="flex flex-wrap items-center gap-2">
                <TokenAmount
                  value={null}
                  token={q.token}
                  text={humanAmount(q.amount, q.symbol)}
                  className="text-xl leading-tight font-bold tracking-tight whitespace-normal [overflow-wrap:anywhere]"
                />
                {lowest.has(q.quoteId) && <Badge variant="success">Lowest</Badge>}
              </span>
              {q.expectedCosts !== null && (
                <span className="text-ui text-muted-foreground">
                  + running costs up to{' '}
                  <TokenAmount
                    value={null}
                    token={q.expectedCosts.token}
                    text={humanAmount(q.expectedCosts.amount, q.expectedCosts.symbol)}
                  />
                  {q.expectedCosts.note !== '' && ` · ${q.expectedCosts.note}`}
                </span>
              )}
            </div>
            {q.note !== '' && (
              <p className="text-sm leading-snug text-muted-foreground [overflow-wrap:anywhere]">{q.note}</p>
            )}
            {onPick !== undefined && (
              <Button variant="secondary" onClick={() => onPick(q)} className="mt-auto">
                Pick this quote
              </Button>
            )}
          </article>
        ))}
      </div>
    </>
  )
}

/** How busy the bidder is right now (roadmap #4): its unfinished jobs and hires waiting for it to start. */
function WorkerLoad({ load }: { load: Quote['workerLoad'] }) {
  if (load === undefined || load === null) return null
  const parts = [
    load.holding > 0 ? `${load.holding} ${load.holding === 1 ? 'job' : 'jobs'} in progress` : '',
    load.awaitingActivation > 0 ? `${load.awaitingActivation} waiting to start` : '',
  ].filter((part) => part !== '')
  return <span>{parts.length === 0 ? 'No unfinished jobs' : parts.join(' · ')}</span>
}
