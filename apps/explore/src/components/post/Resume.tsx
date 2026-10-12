import { boardKey, viewerKey } from '../../queries.ts'
import { cn } from '../../lib/cn.ts'
import { Badge } from '../ui/badge.tsx'
import { Button } from '../ui/button.tsx'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '../ui/empty.tsx'
import { Item, ItemGroup, ItemContent } from '../ui/item.tsx'
import { CopyButton, LoadingRows, PageTitle, Section, textLinkClass } from '../kit.tsx'
import { useQuery } from '@tanstack/react-query'
import { Lock } from 'lucide-react'
import { useState } from 'react'
import { type DeliverableKind, type DeliverableSpec, type TxRequest, boardApi, currentBoardId } from '../../api.ts'
import { amount, bond } from '../../format.ts'
import { useToken } from '../../useTokens.ts'
import { BoardLink, boardRoutes, useBoardNavigate } from '../BoardLink.tsx'
import { useToast } from '../Sheet.tsx'
import { When, useNow } from '../Time.tsx'
import { PostingSteps } from './PostingSteps.tsx'

import type { useSignedIn } from '../Wallet.tsx'
import { KV } from '../controls.tsx'
import { Preflight } from './Preflight.tsx'
import { ScreeningCard } from './Screening.tsx'
import { SignIn } from '../SignIn.tsx'
import { BondHorizonNotice } from '../BondHorizonNotice.tsx'
import { JOBS_LABEL } from '../../places.ts'

type Auth = ReturnType<typeof useSignedIn>

/** The board's `get_task` answer, as far as resuming a frozen offer reads it (amounts in base units). */
interface SavedOffer {
  taskId: string
  title: string
  kind: 'sidequest-v1'
  token: string
  reward: string
  creatorBond: string
  workerBond: string
  creator: string
  deliveryDeadline: number
  manifestUrl: string
  deliverable?: DeliverableSpec | null
  executionBudget: { kind: 'advance' | 'call'; amount: string; symbol: string; function?: string } | null
  jobId: string | null
  screening: { verdict: string; reasons: string[] }
  terms: { brief?: string; acceptanceCriteria?: string[]; evidencePolicy?: { checks?: string[] } | null }
}

const KIND_LABEL: Record<DeliverableKind, string> = {
  git: 'Git commit',
  patch: 'Patch',
  artifact: 'File',
  url: 'Live URL',
  onchain: 'On-chain',
}

/**
 * An offer the board froze that never reached the chain (`?resume=<taskId>`, linked from the drafts in Jobs): shown as
 * agents will see it, with its screening, and published by its creator through the board's `publish_transactions`,
 * which hands out the approvals and the publish again (a terms hash lists once, so it cannot publish twice).
 */
export function ResumeOffer({
  taskId,
  auth,
  onPublished,
}: {
  taskId: string
  auth: Auth
  onPublished?: ((p: { taskId: string; jobId: string | null; txHash: string | null }) => void) | undefined
}) {
  const navigate = useBoardNavigate()
  const toast = useToast()
  const now = useNow()
  const scope = new URLSearchParams(window.location.search).get('board')
  const boardId = scope !== null && /^[a-z0-9-]{3,32}$/.test(scope) ? scope : currentBoardId()
  const api = boardApi(boardId)
  const routes = boardRoutes(boardId)
  const task = useQuery({
    queryKey: boardKey(boardId, 'resume-offer', boardId, taskId, viewerKey(auth.address, auth.signedIn)),
    queryFn: () => api.tool<SavedOffer>('get_task', { taskId }),
  })
  const [txs, setTxs] = useState<TxRequest[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const t = task.data
  useToken(t?.token)
  const mine = t !== undefined && auth.address !== undefined && t.creator.toLowerCase() === auth.address.toLowerCase()

  const header = (
    <>
      <BoardLink target={routes.jobs()} className={cn(textLinkClass, 'text-sm')}>
        Back to {JOBS_LABEL.toLowerCase()}
      </BoardLink>

      <PageTitle
        sub={t !== undefined && t.jobId === null ? <Badge variant="warning">Not published yet</Badge> : undefined}
      >
        {t?.title ?? 'A saved offer'}
      </PageTitle>
    </>
  )
  if (task.isLoading) {
    return (
      <>
        {header}

        <LoadingRows rows={4} />
      </>
    )
  }
  if (t === undefined) {
    return (
      <>
        {header}

        <Alert variant="destructive">
          <AlertDescription>
            This offer could not be loaded: {(task.error as Error | null)?.message ?? 'it was not found on this board'}.
          </AlertDescription>
        </Alert>
      </>
    )
  }
  if (t.kind !== 'sidequest-v1') {
    return (
      <>
        {header}

        <Empty>
          <EmptyHeader>
            <EmptyTitle>This offer is on an earlier contract</EmptyTitle>
            <EmptyDescription>It can no longer be published. Create a fresh job with your agent.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    )
  }
  if (t.jobId !== null) {
    return (
      <>
        {header}

        <Empty>
          <EmptyHeader>
            <EmptyTitle>Already published</EmptyTitle>
            <EmptyDescription>
              <BoardLink target={routes.job(t.jobId)} className={textLinkClass}>
                Open job #{t.jobId}
              </BoardLink>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    )
  }

  const lapsed = t.deliveryDeadline <= now
  const reward = amount(t.reward, t.token)
  const criteria = t.terms.acceptanceCriteria ?? []
  const checks = t.terms.evidencePolicy?.checks ?? []
  const accepts = t.deliverable?.accepts ?? ['git']

  const prepare = async () => {
    if (txs !== null) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await api.tool<{ transactions: TxRequest[] }>('publish_transactions', { taskId })
      setTxs(r.transactions)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const published = async (hashes: string[]) => {
    const jobId = await api.tool<{ jobId: string | null }>('get_task', { taskId }).then(
      (x) => x.jobId,
      () => null,
    )
    toast(`Published · ${reward} locked in escrow`)
    if (onPublished !== undefined) onPublished({ taskId, jobId, txHash: hashes.at(-1) ?? null })
    else await navigate(jobId !== null ? routes.job(jobId) : routes.jobs())
  }

  return (
    <>
      {header}

      <Section title="What agents will see">
        <ItemGroup>
          <Item>
            <ItemContent className="grid min-w-0 gap-1 py-1">
              <span className="font-semibold [overflow-wrap:anywhere]">{t.title}</span>
              <span className="text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                {t.terms.brief ?? ''}
              </span>
            </ItemContent>
          </Item>
          {criteria.length > 0 && (
            <Item>
              <ItemContent className="grid min-w-0 gap-1 py-1">
                <span className="text-ui text-muted-foreground">Accepted when</span>
                <ul className="grid list-disc gap-0.5 pl-5 text-sm [overflow-wrap:anywhere]">
                  {criteria.map((c, i) => (
                    <li key={`${i}-${c}`}>{c}</li>
                  ))}
                </ul>
              </ItemContent>
            </Item>
          )}
          <KV label="How agents compete">Direct hire</KV>
          <KV label="Reward">
            <span className="tabular-nums font-semibold text-foreground">{reward}</span>
          </KV>
          <KV label="Deliver by">
            <When at={t.deliveryDeadline} />
          </KV>
          <KV label="Deliver as">{accepts.map((k) => KIND_LABEL[k]).join(', ')}</KV>
          {checks.length > 0 && (
            <KV label="Required GitHub check">
              <code className="font-mono text-ui">{checks.join(', ')}</code>
            </KV>
          )}
          <KV label="Deposits at risk">{`${bond(t.creatorBond)} reserved from your backing · at least ${bond(t.workerBond)} from the agent's`}</KV>
          <BondHorizonNotice bonded={BigInt(t.creatorBond) > 0n || BigInt(t.workerBond) > 0n} tone="fix" />
          {t.executionBudget !== null && (
            <KV label="Running-cost budget">
              {t.executionBudget.kind === 'call'
                ? `Up to ${t.executionBudget.amount} ${t.executionBudget.symbol} for one contract call`
                : `Up to ${t.executionBudget.amount} ${t.executionBudget.symbol}`}
            </KV>
          )}
        </ItemGroup>
      </Section>

      <ScreeningCard screening={t.screening} />

      {!auth.signedIn ? (
        <Section note="Only the person who prepared this offer can publish it.">
          <SignIn auth={auth} />
        </Section>
      ) : !mine ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Not your offer</EmptyTitle>
            <EmptyDescription>
              Only the person who prepared this offer can publish it. You can create a job of your own with your agent.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <Preflight address={auth.address} token={t.token} reward={BigInt(t.reward)} bond={BigInt(t.creatorBond)} />

          <div className="flex items-center gap-3.5 rounded-xl bg-card p-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/14 text-primary">
              <Lock aria-hidden className="size-5" />
            </span>
            <span className="min-w-0">
              <span className="tabular-nums block text-2xl leading-tight font-bold tracking-tight [overflow-wrap:anywhere]">
                {reward}
              </span>
              <span className="block text-sm text-muted-foreground">
                Locked in escrow when you publish · due <When at={t.deliveryDeadline} show="relative" />
              </span>
            </span>
          </div>

          {lapsed && (
            <p className="rounded-xl bg-warning/14 px-4 py-3 text-sm text-warning-text">
              Its delivery deadline has passed, so it can no longer be published. Create a fresh job with your agent and
              new dates.
            </p>
          )}

          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Section
            title="Publish"
            note="Your wallet sends the reward approval and the publish transaction in order; your deposit at risk is reserved from your backing. Only the wallet confirmation is an overlay."
          >
            {txs !== null ? (
              <PostingSteps
                boardId={boardId}
                key={taskId}
                taskId={taskId}
                txs={txs}
                owner={t.creator}
                canSend={!lapsed && mine}
                onDone={(hashes) => void published(hashes)}
              />
            ) : (
              <Button size="lg" busy={busy} disabled={lapsed} onClick={() => void prepare()}>
                Prepare wallet steps
              </Button>
            )}
          </Section>
        </>
      )}

      <Section title="Details">
        <ItemGroup>
          <Item>
            <ItemContent className="flex-1">Offer ID</ItemContent>
            <ItemContent className="font-mono text-ui text-muted-foreground">{t.taskId}</ItemContent>
            <CopyButton value={t.taskId} label="Copy offer ID" />
          </Item>
          <Item render={<a href={t.manifestUrl} target="_blank" rel="noreferrer" />} className={textLinkClass}>
            The full terms, as agents read them
          </Item>
        </ItemGroup>
      </Section>
    </>
  )
}
