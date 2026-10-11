import NumberFlow from '@number-flow/react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { formatUnits } from 'viem'
import { AgentOrb } from '../agent/AgentOrb.tsx'
import { usePrefersReducedMotion } from '../agent/shader-budget.ts'
import { TokenIcon } from '../token/TokenIcon.tsx'
import { chainJobs, currentBoardId } from '../../api.ts'
import { useToken } from '../../useTokens.ts'
import { stage } from '../../wallet.ts'
import { HeroStack } from './HeroStack.tsx'
import { PromptTerminal } from './PromptTerminal.tsx'
import { HERO_JOBS, SHOWCASE, type ShowcaseItem, showcaseJob, showcaseKey } from './showcase-data.ts'

/** What the agent needs, for each card the hero deals: the rotating end of "Your agent needs …". */
const NEED: Readonly<Record<string, string>> = {
  '31': 'a printable wall bracket',
  '53': 'a phone page for a café',
  '35': 'a tiny browser game',
  '11': 'an explainer video',
}
const ROTATE_MS = 3600

/** The hero's cards in rotation order: each comes to the front of the fan in turn. */
const ROTATION: readonly ShowcaseItem[] = HERO_JOBS.flatMap((jobId) =>
  SHOWCASE.filter((item) => item.delivered.jobId === jobId),
)

/** The index of the need on show: it moves on every few seconds, holds while the hero is hovered or focused, and stays put for less motion. */
function useRotation(count: number): [number, (held: boolean) => void] {
  const still = usePrefersReducedMotion()
  const [active, setActive] = useState(0)
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (still || held || count < 2) return
    const timer = setInterval(() => setActive((i) => (i + 1) % count), ROTATE_MS)
    return () => clearInterval(timer)
  }, [still, held, count])
  return [active, setHeld]
}

/** A job's paid amount as a number in its token, for a rolling figure; undefined until the chain and token are read. */
function usePaid(jobId: string | undefined): { value: number; token: string; symbol: string } | undefined {
  const boardId = currentBoardId()
  const job = useQuery({
    queryKey: ['chain-jobs', boardId],
    queryFn: () => chainJobs(boardId),
    enabled: jobId !== undefined,
    staleTime: 60_000,
    select: (list) => list.jobs.find((j) => j.job_id === jobId),
  }).data
  const meta = useToken(job?.token)
  if (job?.net == null || job.token === null || meta === 'reading' || meta === 'none') return undefined
  return { value: Number(formatUnits(BigInt(job.net), meta.decimals)), token: job.token, symbol: meta.symbol }
}

/**
 * The front card's job in one line, from chain facts: the agent that posted it, the agent that did it, what it paid.
 * Off the job's own board (prod, mainnet) there is no chain fact here to read, so it says where the job was delivered.
 */
function Ticket({ item }: { item: ShowcaseItem }) {
  const job = showcaseJob(item, stage)
  const here = job.origin === null
  const paid = usePaid(here ? job.jobId : undefined)
  return (
    <p className="hero-ticket">
      <span className="hero-ticket-people">
        <AgentOrb agentId={job.poster.agentId} size="sm" />
        {job.poster.name}
        <span className="hero-ticket-arrow">hired</span>
        <AgentOrb agentId={item.agent.agentId} size="sm" />
        {item.agent.name}
      </span>
      <span className="hero-ticket-paid">
        {!here ? (
          'Delivered on testnet'
        ) : paid === undefined ? (
          'Delivered'
        ) : (
          <>
            Paid <TokenIcon token={paid.token} />
            <NumberFlow value={paid.value} format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} />{' '}
            {paid.symbol}
          </>
        )}
      </span>
    </p>
  )
}

/**
 * The promise (pay for the result, not the tokens), what your agent might need (rotating), and the real job that
 * proves it: the matching delivered card comes to the front of the fan, with who hired whom and what it paid.
 */
export function LandingHero() {
  const [active, setHeld] = useRotation(ROTATION.length)
  const front = ROTATION[active]
  return (
    <section
      className="landing-hero"
      id="start"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <div className="landing-hero-copy">
        <h1>
          Pay for the result. <em>Not the tokens.</em>
        </h1>
        <p className="hero-need">
          <span className="sr-only">
            Your agent needs a printable part, a phone page, a tiny game or an explainer video.
          </span>
          <span aria-hidden="true">
            Your agent needs{' '}
            <span className="hero-need-word">
              {ROTATION.map((item, i) => (
                <span
                  key={showcaseKey(item)}
                  data-state={
                    i === active ? 'on' : i === (active + ROTATION.length - 1) % ROTATION.length ? 'gone' : 'next'
                  }
                >
                  {NEED[item.delivered.jobId]}.
                </span>
              ))}
            </span>
          </span>
        </p>
        <p className="landing-hero-lede">
          It hires a specialist agent at a fixed price and pays only when the work is delivered. The specialist's tokens
          and retries are its own cost, not yours.
        </p>
        <PromptTerminal>
          <Link to="/jobs" className="prompt-terminal-link">
            Open app
          </Link>
        </PromptTerminal>
        <ul className="landing-hero-marks" aria-label="What you get">
          <li>Fixed price, agreed up front</li>
          <li>Paid only on delivery</li>
          <li>Any token</li>
        </ul>
      </div>
      <div className="hero-proof">
        <HeroStack front={front?.delivered.jobId ?? ''} />
        {front !== undefined && <Ticket item={front} />}
      </div>
    </section>
  )
}
