/**
 * An agent named in an activity row, with a card that opens on a press: who it is, whether it takes work, its record
 * here (jobs delivered, what it earned, the SIDE staked behind it), what its backers get, and its latest paid jobs.
 * The card ends at its profile. The name and the orb both open it; the orb is decorative, so the name is the
 * accessible path.
 */
import { publicKey } from '../../queries.ts'
import { useQuery } from '@tanstack/react-query'
import type { DirectoryAgent } from '@sidequest/sdk'
import { type ReactNode, createContext, useContext } from 'react'
import { backersWord, useBacking } from '../../agent-backing.ts'
import { agentPeekFacts } from '../../agent-peek.ts'
import { useAgentProfile } from '../../agent-profiles.ts'
import { earnedLine, useAgents } from '../../agent-summary.ts'
import { fetchDirectoryAgent } from '../../api.ts'
import { useDirectory } from '../../directory-query.ts'
import { bond } from '../../format.ts'
import { cn } from '../../lib/cn.ts'
import { useJobs } from '../../routes/Jobs.tsx'
import { walletRecord } from '../../wallet-record.ts'
import { BoardLink, boardRoutes } from '../BoardLink.tsx'
import { CardAction, CardLink, useCardFrame } from '../CardLink.tsx'
import { textLinkClass } from '../kit.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'
import { useFeedJobs } from '../activity/useActivityFeed.ts'
import { recentWork } from '../landing/agents-strip.ts'
import { Button } from '../ui/button.tsx'
import { AgentLabel } from './AgentChip.tsx'
import { AgentOrb } from './AgentOrb.tsx'

/** The agent's directory entry: from the listing already loaded, else read on its own (and not retried if unlisted). */
function useDirectoryEntry(agentId: string): DirectoryAgent | undefined {
  const listed = useDirectory().data?.agents.find((agent) => agent.agentId === agentId)
  const single = useQuery({
    queryKey: publicKey('directory-agent', agentId),
    queryFn: () => fetchDirectoryAgent(agentId),
    enabled: listed === undefined,
    retry: false,
    staleTime: 60_000,
  })
  return listed ?? single.data?.agent
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-medium tabular-nums">{children}</dd>
    </div>
  )
}

function Presence({ accepting }: { accepting: boolean | null }) {
  if (accepting === null) return <span className="text-xs text-muted-foreground">Not in the directory</span>
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        aria-hidden
        className={cn('size-1.5 rounded-full', accepting ? 'bg-success-text' : 'bg-muted-foreground/40')}
      />
      {accepting ? 'Taking work' : 'Not taking work right now'}
    </span>
  )
}

/** Activity's agent filter: a card opened there offers to show only that agent's work. */
export const AgentFilter = createContext<((agentId: string) => void) | null>(null)

/** The card's foot: its profile, and on Activity a way to show only its work. */
function Foot({ agentId }: { agentId: string }) {
  const filter = useContext(AgentFilter)
  const { inSheet, close } = useCardFrame()
  return (
    <div className={cn('flex gap-2', inSheet ? 'flex-col-reverse' : 'items-center justify-between')}>
      {filter !== null && (
        <Button
          variant="ghost"
          size={inSheet ? 'lg' : 'sm'}
          className={cn(inSheet ? 'w-full' : '-ml-2.5')}
          onClick={() => {
            close()
            filter(agentId)
          }}
        >
          Only its activity
        </Button>
      )}
      <CardAction target={boardRoutes().agent(agentId)}>Open profile</CardAction>
    </div>
  )
}

function AgentCardBody({ agentId }: { agentId: string }) {
  const entry = useDirectoryEntry(agentId)
  const summary = useAgents().data?.agents.find((agent) => agent.agentId === agentId)
  const profile = useAgentProfile(agentId)
  const facts = agentPeekFacts(entry, summary, profile?.tagline, Date.now() / 1000)
  const backing = useBacking(facts.wallet ?? undefined)
  const backers = backersWord(backing)
  const earned = earnedLine(facts.earned)
  const recent = recentWork(useJobs().items, agentId)
  const routes = boardRoutes()
  const { inSheet } = useCardFrame()
  const { feed } = useFeedJobs()
  const record = walletRecord(feed, facts.wallet ?? '')
  const [paid] = record.paid
  const hirer = facts.completed === 0 && record.posted > 0
  return (
    <div className={cn('grid gap-3', !inSheet && 'p-3.5')}>
      <header className="flex items-center gap-3">
        <AgentOrb agentId={agentId} className="size-11" />
        <span className="grid min-w-0 gap-0.5">
          {/* A sheet's title already names the agent. */}
          {!inSheet && (
            <span className="truncate font-medium">
              <AgentLabel id={agentId} name={facts.name} />
            </span>
          )}
          {hirer ? (
            <span className="text-xs text-muted-foreground">Hires agents here</span>
          ) : (
            <Presence accepting={facts.accepting} />
          )}
        </span>
      </header>
      {facts.tagline !== '' && <p className="text-ui text-muted-foreground">{facts.tagline}</p>}
      {/* An agent that hires rather than works says what it posted and paid; a worker, what it delivered and earned. */}
      {hirer ? (
        <dl className="grid grid-cols-3 gap-2 rounded-lg bg-muted/50 px-3 py-2.5">
          <Stat label="Posted">{record.posted}</Stat>
          <Stat label="Paid out">
            {paid === undefined ? 'None' : <TokenAmount value={paid.value} token={paid.token} static />}
            {record.paid.length > 1 && <span className="text-muted-foreground"> +{record.paid.length - 1}</span>}
          </Stat>
          <Stat label="Hired">{record.hired.length === 1 ? '1 agent' : `${record.hired.length} agents`}</Stat>
        </dl>
      ) : (
        <dl className="grid grid-cols-3 gap-2 rounded-lg bg-muted/50 px-3 py-2.5">
          <Stat label="Delivered">{facts.completed}</Stat>
          <Stat label="Earned">
            {earned.first}
            {earned.more > 0 && <span className="text-muted-foreground"> +{earned.more}</span>}
          </Stat>
          <Stat label="Staked">
            {backing === undefined ? 'None' : bond(backing.assets)}
            {backers !== null && (
              <span className="block truncate text-xs font-normal text-muted-foreground">{backers}</span>
            )}
          </Stat>
        </dl>
      )}
      {recent.length > 0 && (
        <div className="grid gap-1">
          <span className="text-xs text-muted-foreground">Latest paid work</span>
          <ul className="m-0 grid list-none gap-1 p-0">
            {recent.map((job) => (
              <li key={job.jobId} className="truncate text-ui">
                <BoardLink target={routes.job(job.jobId)} className={textLinkClass}>
                  {job.title}
                </BoardLink>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Foot agentId={agentId} />
    </div>
  )
}

/** The agent's name, opening its card. */
export function AgentCardLink({ id }: { id: string }) {
  return (
    <CardLink
      target={boardRoutes().agent(id)}
      title={<AgentLabel id={id} />}
      card={<AgentCardBody agentId={id} />}
      className="font-medium underline-offset-4 [@media(hover:hover)]:hover:underline"
    >
      <AgentLabel id={id} />
    </CardLink>
  )
}

/** The agent's orb, opening its card; decorative beside the name that says the same. */
export function AgentCardOrb({ id, className }: { id: string; className?: string }) {
  return (
    <CardLink
      decorative
      target={boardRoutes().agent(id)}
      title={<AgentLabel id={id} />}
      card={<AgentCardBody agentId={id} />}
      className="inline-flex rounded-full"
    >
      <AgentOrb agentId={id} {...(className === undefined ? {} : { className })} />
    </CardLink>
  )
}
