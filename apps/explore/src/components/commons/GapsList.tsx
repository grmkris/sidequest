import { Link, useLocation } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Badge } from '../ui/badge.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty.tsx'
import { LoadingRows, Select } from '../kit.tsx'
import { Button } from '../ui/button.tsx'
import { Input } from '../ui/input.tsx'
import { Field, FieldLabel } from '../ui/field.tsx'
import { When } from '../Time.tsx'
import { GAP_LABEL, GAP_STATUS_LABEL, type Gap, type GapFilters, type GapStatus, type GapType } from '../../commons.ts'
import { useGaps } from '../../commons-query.ts'
import { gapFilters, gapSearch } from '../../commons-route.ts'
import { useReplaceSearch } from '../../page-search.ts'

/**
 * What agents could not do through Sidequest, as they reported it with `report_gap`: one card per gap (reports of the
 * same gap are counted together), with an example of what was needed and tried, and the roadmap items it feeds.
 */
export function GapsList() {
  const { searchStr } = useLocation()
  const filters = gapFilters(searchStr)
  const gaps = useGaps(filters)
  const list = gaps.data?.pages.flatMap((page) => page.gaps) ?? []
  return (
    <div className="grid gap-4">
      <GapsFilters filters={filters} searchStr={searchStr} />
      {gaps.error !== null && (
        <Alert variant="destructive">
          <AlertDescription>
            Gaps could not be read: {gaps.error.message}{' '}
            <Button variant="link" onClick={() => void gaps.refetch()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {gaps.isLoading ? <LoadingRows rows={4} /> : <GapCards gaps={list} failed={gaps.error !== null} />}
      {gaps.hasNextPage && (
        <Button variant="outline" busy={gaps.isFetchingNextPage} onClick={() => void gaps.fetchNextPage()}>
          Load more gaps
        </Button>
      )}
    </div>
  )
}

function GapsFilters({ filters, searchStr }: { filters: GapFilters; searchStr: string }) {
  const replaceSearch = useReplaceSearch()
  const [tool, setTool] = useState(filters.tool ?? '')
  useEffect(() => setTool(filters.tool ?? ''), [filters.tool])
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        replaceSearch(gapSearch(searchStr, { ...filters, tool }))
      }}
    >
      <Field className="w-auto">
        <FieldLabel htmlFor="gap-status">Status</FieldLabel>
        <Select
          id="gap-status"
          value={filters.status ?? ''}
          onChange={(event) =>
            // SAFETY: this native select contains only the gap statuses and the empty all-statuses option.
            replaceSearch(gapSearch(searchStr, { ...filters, status: event.target.value as GapStatus | '' }))
          }
        >
          <option value="">All statuses</option>
          {Object.entries(GAP_STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <Field className="w-auto">
        <FieldLabel htmlFor="gap-type">Type</FieldLabel>
        <Select
          id="gap-type"
          value={filters.gapType ?? ''}
          onChange={(event) =>
            // SAFETY: this native select contains only the gap types and the empty all-types option.
            replaceSearch(gapSearch(searchStr, { ...filters, gapType: event.target.value as GapType | '' }))
          }
        >
          <option value="">All types</option>
          {Object.entries(GAP_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <Field className="w-auto">
        <FieldLabel htmlFor="gap-tool">Tool</FieldLabel>
        <Input
          id="gap-tool"
          value={tool}
          onChange={(event) => setTool(event.target.value)}
          pattern="[a-z][a-z0-9_]{1,63}"
          placeholder="Any tool"
        />
      </Field>
      <Button type="submit" variant="outline">
        Apply tool filter
      </Button>
    </form>
  )
}

function GapCards({ gaps, failed }: { gaps: readonly Gap[]; failed: boolean }) {
  if (gaps.length === 0 && !failed)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No gaps match these filters</EmptyTitle>
          <EmptyDescription>
            Agents report here, with the report_gap tool, when Sidequest could not do what they needed.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  return (
    <ul className="grid gap-3">
      {gaps.map((gap) => (
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
        <Badge variant="outline">{GAP_STATUS_LABEL[gap.status]}</Badge>
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
        <Link
          to="/commons/gaps/$gapId"
          params={{ gapId: String(gap.id) }}
          className="text-foreground underline underline-offset-4"
        >
          Read {gap.reports === 1 ? 'report' : `all ${gap.reports} reports`}
        </Link>
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
