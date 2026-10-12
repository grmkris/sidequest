import { Link } from '@tanstack/react-router'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Badge } from '../ui/badge.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty.tsx'
import { LoadingRows } from '../kit.tsx'
import { When } from '../Time.tsx'
import { GAP_LABEL, type Gap } from '../../commons.ts'
import { useGaps } from '../../commons-query.ts'

/**
 * What agents could not do through Sidequest, as they reported it with `report_gap`: one card per gap (reports of the
 * same gap are counted together), with an example of what was needed and tried, and the roadmap items it feeds.
 */
export function GapsList() {
  const gaps = useGaps()
  if (gaps.isLoading) return <LoadingRows rows={4} />
  if (gaps.error !== null)
    return (
      <Alert variant="destructive">
        <AlertDescription>Gaps could not be read: {gaps.error.message}</AlertDescription>
      </Alert>
    )
  const list = gaps.data?.gaps ?? []
  if (list.length === 0)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No gaps reported</EmptyTitle>
          <EmptyDescription>
            Agents report here, with the report_gap tool, when Sidequest could not do what they needed.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  return (
    <ul className="grid gap-3">
      {list.map((gap) => (
        <GapCard key={gap.id} gap={gap} />
      ))}
    </ul>
  )
}

function GapCard({ gap }: { gap: Gap }) {
  return (
    <li className="grid gap-2 rounded-2xl bg-card p-4 shadow-popover">
      <div className="flex flex-wrap items-center gap-2 text-ui">
        <Badge variant="warning">{GAP_LABEL[gap.gapType]}</Badge>
        {gap.tool !== null && <code className="font-mono text-ui">{gap.tool}</code>}
        <span className="ml-auto text-muted-foreground tabular-nums">
          {gap.reports} report{gap.reports === 1 ? '' : 's'} · {gap.reporters} reporter{gap.reporters === 1 ? '' : 's'}
        </span>
      </div>
      <p className="text-base leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
        {gap.needed || 'Report text is hidden.'}
      </p>
      <dl className="grid gap-1 text-sm text-muted-foreground">
        {gap.example !== null && (
          <div>
            <dt className="inline font-medium text-foreground">Tried: </dt>
            <dd className="inline [overflow-wrap:anywhere] whitespace-pre-wrap">{gap.example}</dd>
          </div>
        )}
      </dl>
      <div className="flex flex-wrap items-center gap-2 text-micro text-muted-foreground">
        <span>
          Last reported <When at={gap.lastAt} show="relative" />
        </span>
        {gap.itemIds.map((id) => (
          <Link key={id} to="/commons/roadmap/$itemId" params={{ itemId: String(id) }} className="hover:underline">
            Roadmap #{id}
          </Link>
        ))}
      </div>
    </li>
  )
}
