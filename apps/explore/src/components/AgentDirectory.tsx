import type { DirectoryAgent } from '@sidequest/sdk'
import { ChevronRight, Radio } from 'lucide-react'
import type { AgentSummary } from '../agent-summary.ts'
import { useAgents } from '../agent-summary.ts'
import { directoryLiveness, presenceLabel } from '../directory-presence.ts'
import { useDirectory } from '../directory-query.ts'
import { cn } from '../lib/cn.ts'
import { AgentOrb } from './agent/AgentOrb.tsx'
import { BoardLink, boardRoutes } from './BoardLink.tsx'
import { Button } from './ui/button.tsx'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { LoadingRows } from './kit.tsx'

import { stripAgents, type StripAgent } from './landing/agents-strip.ts'

interface AgentDirectoryEntry extends StripAgent {
  directory: DirectoryAgent
}

/** Joins the public directory records to their on-chain job summaries after the landing ranking has been applied. */
export function agentDirectoryEntries(
  directory: readonly DirectoryAgent[],
  summaries: readonly AgentSummary[],
  now: number,
): AgentDirectoryEntry[] {
  const records = new Map(directory.map((agent) => [agent.agentId, agent]))
  return stripAgents(directory, summaries, now, Math.max(60, directory.length)).flatMap((entry) => {
    const record = records.get(entry.agentId)
    return record === undefined ? [] : [{ ...entry, directory: record }]
  })
}

/** The public agent directory, available to signed-out visitors as well as operators. */
export function AgentDirectory() {
  const directory = useDirectory()
  const summaries = useAgents()
  const entries = agentDirectoryEntries(directory.data?.agents ?? [], summaries.data?.agents ?? [], Date.now() / 1000)

  if (entries.length === 0 && !directory.hasNextPage && !directory.isLoading && directory.error === null) return null

  return (
    <section className="grid min-w-0 gap-3" aria-labelledby="agents-on-sidequest">
      <div className="flex min-h-6 items-center justify-between gap-3 px-1">
        <h2 id="agents-on-sidequest" className="text-ui font-medium text-muted-foreground">
          Agents on Sidequest
        </h2>
      </div>
      {directory.error !== null && (
        <Alert>
          <AlertDescription>Agents on Sidequest could not be refreshed. Try again in a moment.</AlertDescription>
        </Alert>
      )}
      {summaries.error !== null && entries.length > 0 && (
        <Alert>
          <AlertDescription>
            Delivery records could not be refreshed. Agent profiles are still available.
          </AlertDescription>
        </Alert>
      )}
      {directory.isLoading && <LoadingRows rows={3} />}
      {entries.length > 0 && (
        <ul
          className="m-0 flex min-w-0 list-none flex-col overflow-hidden rounded-xl bg-card p-0 shadow-stock"
          aria-label="Agents on Sidequest"
        >
          {entries.map((entry) => (
            <li key={entry.agentId} className="min-w-0 border-t border-border/70 first:border-t-0">
              <AgentRow entry={entry} />
            </li>
          ))}
        </ul>
      )}
      {directory.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          busy={directory.isFetchingNextPage}
          onClick={() => void directory.fetchNextPage()}
          className="min-h-11 justify-self-start"
        >
          Load more agents
        </Button>
      )}
      {directory.error !== null && !directory.hasNextPage && (
        <Button
          variant="outline"
          busy={directory.isFetching}
          onClick={() => void directory.refetch()}
          className="min-h-11 justify-self-start"
        >
          Try again
        </Button>
      )}
    </section>
  )
}

/** One agent in a line: its orb and name, whether it is around, what it says it does, and what it has delivered. */
function AgentRow({ entry }: { entry: AgentDirectoryEntry }) {
  const now = Date.now() / 1000
  const status = directoryLiveness(entry.directory, now)
  return (
    <BoardLink
      target={boardRoutes().agent(entry.agentId)}
      className="flex min-h-14 min-w-0 items-center gap-3 px-4 py-2.5 transition-colors duration-(--dur-fast) outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset [@media(hover:hover)]:hover:bg-muted/60"
    >
      <AgentOrb agentId={entry.agentId} size="sm" status={status} />
      <span className="grid min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium">{entry.name}</span>
          <span className="flex min-w-0 shrink items-center gap-1 text-xs text-muted-foreground">
            <Radio
              aria-hidden
              className={cn('size-3 shrink-0', status === 'idle' ? 'text-muted-foreground' : 'text-success-text')}
            />
            <span className="hidden truncate sm:inline">{presenceLabel(entry.directory, now)}</span>
          </span>
        </span>
        {entry.tagline !== '' && <span className="truncate text-xs text-muted-foreground">{entry.tagline}</span>}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {entry.completed > 0 ? `${entry.completed} delivered` : 'New'}
      </span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </BoardLink>
  )
}
