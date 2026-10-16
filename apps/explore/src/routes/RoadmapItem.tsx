import { Link, useParams } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { Address, LoadingRows, PageTitle, Section } from '../components/kit.tsx'
import { ThreadView } from '../components/commons/ThreadView.tsx'
import { Markdown } from '../components/commons/Markdown.tsx'
import { GAP_LABEL, type RoadmapItemDetail, STATUS_LABEL, hiddenLabel, side, supportLine } from '../commons.ts'
import { useRoadmapItem } from '../commons-query.ts'

/** One roadmap item: the problem and the proposal, who supports it with how much SIDE, its gaps and its thread. */
export function RoadmapItemPage() {
  // SAFETY: the route is /commons/roadmap/$itemId, so itemId is always present.
  const { itemId } = useParams({ strict: false }) as { itemId: string }
  const id = Number(itemId)
  const detail = useRoadmapItem(id)
  const back = (
    <Link
      to="/commons"
      search={{ tab: 'roadmap' }}
      className="inline-flex items-center gap-1 text-ui text-muted-foreground"
    >
      <ArrowLeft aria-hidden className="size-4" />
      Roadmap
    </Link>
  )
  if (detail.isLoading)
    return (
      <>
        {back}
        <LoadingRows rows={4} />
      </>
    )
  if (detail.error !== null || detail.data === undefined)
    return (
      <>
        {back}
        <Alert variant="destructive">
          <AlertDescription>This item could not be read: {detail.error?.message ?? 'not found'}</AlertDescription>
        </Alert>
      </>
    )
  return (
    <>
      {back}
      <ItemBody detail={detail.data} />
    </>
  )
}

function ItemBody({ detail }: { detail: RoadmapItemDetail }) {
  const { item, supporters, gaps, log, thread, block } = detail
  return (
    <>
      <PageTitle sub={<Badge variant="outline">{STATUS_LABEL[item.status]}</Badge>}>{item.title}</PageTitle>
      {item.hidden !== null && <p className="text-muted-foreground italic">{hiddenLabel(item.hidden)}</p>}
      <Section title="Problem">
        <Markdown>{item.problem}</Markdown>
      </Section>
      <Section title="Proposal">
        <Markdown>{item.proposal}</Markdown>
      </Section>
      <Section title="Support" note={supportLine(item, block !== null)}>
        <ul className="grid gap-1">
          {supporters.map((s) => (
            <li key={s.address} className="flex items-center justify-between gap-3 text-sm">
              <Address value={s.address} />
              <span className="font-mono tabular-nums">{side(s.weight)} SIDE</span>
            </li>
          ))}
        </ul>
      </Section>
      {gaps.length > 0 && (
        <Section title="Gaps behind it">
          <ul className="grid gap-2 text-sm">
            {gaps.map((gap) => (
              <li key={gap.id}>
                <Link
                  to="/commons/gaps/$gapId"
                  params={{ gapId: String(gap.id) }}
                  className="underline underline-offset-4"
                >
                  <Badge variant="warning">{GAP_LABEL[gap.gapType]}</Badge> {gap.needed || 'Report text is hidden.'} (
                  {gap.reports})
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {log.length > 0 && (
        <Section title="Changes">
          <ul className="grid gap-1 text-sm text-muted-foreground">
            {log.map((action) => (
              <li key={action.seq}>
                {action.role} {action.action}: {action.reason}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Discussion">
        <ThreadView
          subject={thread.subject}
          empty="No discussion yet. Say why this matters, or how it should work."
          placeholder="Discuss this item"
        />
      </Section>
    </>
  )
}
