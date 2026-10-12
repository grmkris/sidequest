/**
 * An agent wherever Explore names it — job rows, people on a job, quotes, the sidebar: its orb (seeded by the Agent ID,
 * so it looks the same everywhere) and its name with the Agent ID beside it ("Scout #2013"), or "Worker #2013" without
 * a name, linking to its profile. The label is plain inline text after an aria-hidden orb, so a row's text reads
 * "Worker #2013" with no line break.
 */
import { publicKey, directoryFirstQuery } from '../../queries.ts'
import { type InfiniteData, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DirectoryAgent } from '@sidequest/sdk'
import { agentLabel, agentName } from '../../agent-name.ts'
import type { DirectoryPage } from '../../api.ts'
import { useManagedAgents } from '../../managed.ts'
import { cn } from '../../lib/cn.ts'
import { BoardLink, boardRoutes } from '../BoardLink.tsx'
import { AgentOrb } from './AgentOrb.tsx'

/** The agent's name from what is already loaded; the directory's first page is read once (and kept) only if needed. */
export function useAgentName(id: string, given?: string | null): string | null {
  const client = useQueryClient()
  const managed = useManagedAgents()
  const entry = client.getQueryData<{ agent: DirectoryAgent }>(publicKey('directory-agent', id))?.agent
  const listed = client
    .getQueryData<InfiniteData<DirectoryPage>>(publicKey('data-directory'))
    ?.pages.flatMap((page) => page.agents)
  const known = agentName(id, { given, managed: managed.data?.agents, entry, directory: listed })
  const first = useQuery({
    ...directoryFirstQuery(),
    enabled: known === null,
  })
  return known ?? agentName(id, { directory: first.data?.agents })
}

/** The words alone, for a row that already shows the agent's orb: "Scout #2013", or "Worker #2013" without a name. */
export function AgentLabel({ id, name }: { id: string; name?: string | null }) {
  const label = agentLabel(id, useAgentName(id, name))
  return (
    <>
      {label.text}
      {label.id !== null && <span className="text-muted-foreground"> {label.id}</span>}
    </>
  )
}

/**
 * An agent named inside a sentence or a row's details, linking to its profile on this board: its small orb (`orb`)
 * and its label.
 */
export function AgentLink({ id, orb = false, className }: { id: string; orb?: boolean; className?: string }) {
  return (
    <BoardLink
      target={boardRoutes().agent(id)}
      className={cn('inline-flex items-center gap-1.5 font-medium underline-offset-4 hover:underline', className)}
    >
      {orb && <AgentOrb agentId={id} size="sm" />}
      <span>
        <AgentLabel id={id} />
      </span>
    </BoardLink>
  )
}
