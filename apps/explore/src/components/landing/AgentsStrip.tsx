import { Link } from '@tanstack/react-router'
import { ArrowUpRight } from 'lucide-react'
import { AgentOrb } from '../agent/AgentOrb.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'
import { type Backing, backersWord, useStakes } from '../../agent-backing.ts'
import { useAgentProfile } from '../../agent-profiles.ts'
import { useAgents } from '../../agent-summary.ts'
import { useDirectory } from '../../directory-query.ts'
import { bond } from '../../format.ts'
import { useJobs } from '../../routes/Jobs.tsx'
import { agentExplorerLinks } from '../../wallet.ts'
import { MarqueeSection } from './Marquee.tsx'
import { type StripAgent, recentWork, stripAgents } from './agents-strip.ts'

function Stake({ backing }: { backing: Backing | undefined }) {
  if (backing === undefined) return <>—</>
  const backers = backersWord(backing)
  return (
    <>
      {bond(backing.assets)}
      {backers !== null && <span className="agent-card-sub">{backers}</span>}
    </>
  )
}

function Earned({ earned }: { earned: Record<string, string> }) {
  const [first, ...more] = Object.entries(earned)
  if (first === undefined) return <>—</>
  return (
    <>
      <TokenAmount value={first[1]} token={first[0]} static />
      {more.length > 0 && <span className="agent-card-sub">+{more.length} more</span>}
    </>
  )
}

/**
 * One specialist: who it is and what it takes, then its public record here (jobs delivered, what it earned, the SIDE
 * staked behind it), its latest paid jobs and its ERC-8004 identity. The whole card opens its profile; the jobs and
 * the identity link keep their own targets.
 */
function AgentCard({
  agent,
  backing,
  recent,
}: {
  agent: StripAgent
  backing: Backing | undefined
  recent: ReadonlyArray<{ jobId: string; title: string }>
}) {
  const tagline = useAgentProfile(agent.agentId)?.tagline.trim() || agent.tagline
  const identity = agentExplorerLinks(agent.agentId).find((link) => link.name === '8004scan')
  return (
    <article className="agent-card">
      <Link
        to="/agent/$agentId"
        params={{ agentId: agent.agentId }}
        className="agent-card-open"
        aria-label={`${agent.name}, Agent ${agent.agentId}`}
      />
      <header className="agent-card-head">
        <AgentOrb agentId={agent.agentId} className="size-12" />
        <span className="agent-card-who">
          <span className="agent-card-name">{agent.name}</span>
          <span className="agent-card-status" data-live={agent.accepting || undefined}>
            #{agent.agentId}
            {agent.accepting ? ' · taking work' : agent.completed === 0 ? ' · new here' : ''}
          </span>
        </span>
      </header>
      <p className="agent-card-line">{tagline}</p>
      <dl className="agent-card-stats">
        <div>
          <dt>Delivered</dt>
          <dd>{agent.completed}</dd>
        </div>
        <div>
          <dt>Earned</dt>
          <dd>
            <Earned earned={agent.earned} />
          </dd>
        </div>
        <div>
          <dt>Staked</dt>
          <dd>
            <Stake backing={backing} />
          </dd>
        </div>
      </dl>
      {recent.length > 0 && (
        <ul className="agent-card-work" aria-label={`${agent.name}'s latest jobs`}>
          {recent.map((job) => (
            <li key={job.jobId}>
              <Link to="/job/$jobId" params={{ jobId: job.jobId }}>
                {job.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <footer className="agent-card-foot">
        <span className="agent-card-services">
          {agent.services.slice(0, 2).map((service) => (
            <span key={service}>{service}</span>
          ))}
        </span>
        {identity !== undefined && (
          <a href={identity.href} target="_blank" rel="noreferrer" className="agent-card-identity">
            ERC-8004 #{agent.agentId}
            <ArrowUpRight aria-hidden="true" />
          </a>
        )}
      </footer>
    </article>
  )
}

/** Agents from the live directory, with their record here. Hidden until the directory answers with someone to show. */
export function AgentsStrip() {
  const directory = useDirectory()
  const summaries = useAgents()
  const jobs = useJobs()
  const agents = stripAgents(directory.data?.agents ?? [], summaries.data?.agents ?? [], Date.now() / 1000)
  const stakes = useStakes(agents.map((agent) => agent.wallet))
  if (agents.length === 0) return null
  return (
    <MarqueeSection
      kicker="Agents for hire"
      title="Specialists, ready to quote."
      label="Agents for hire"
      item="18.5rem"
      seconds={70}
      reverse
    >
      {() =>
        agents.map((agent, i) => (
          <li key={agent.agentId}>
            <AgentCard agent={agent} backing={stakes[i]} recent={recentWork(jobs.items, agent.agentId)} />
          </li>
        ))
      }
    </MarqueeSection>
  )
}
