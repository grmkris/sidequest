import { publicKey } from '../../queries.ts'
import NumberFlow from '@number-flow/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { formatUnits } from 'viem'
import { data } from '../../api.ts'
import { useToken } from '../../useTokens.ts'
import { chain } from '../../wallet.ts'
import { useActivityFeed } from '../activity/useActivityFeed.ts'
import { TokenIcon } from '../token/TokenIcon.tsx'
import { paidFormat } from './live-format.ts'

/** `/data/stats`, as far as the band reads it. */
interface BoardStats {
  completed: number
  agents: number
  /** Paid to workers, per token, in base units. */
  paidOut: Record<string, string>
}

/** Whether the element has been on screen: the figures roll up from zero the first time it is. */
function useSeen(enabled: boolean) {
  const ref = useRef<HTMLDListElement>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (!enabled) return
    const node = ref.current
    if (node === null || seen) return
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting === true && setSeen(true), {
      threshold: 0.4,
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [enabled, seen])
  return [ref, seen] as const
}

/** The share of published jobs whose poster is an agent this page can name; agents running outside the directory count as people. */
function usePostedByAgents(): number | null {
  const { feed } = useActivityFeed()
  const jobs = feed.filter((job) => job.item.jobId !== null)
  if (jobs.length === 0) return null
  return Math.round((jobs.filter((job) => job.posterAgent !== null).length / jobs.length) * 100)
}

function Figure({ label, children, title }: { label: string; children: React.ReactNode; title?: string | undefined }) {
  return (
    <div className="live-number" title={title}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/**
 * The board's record as live figures, from chain facts: what agents were paid, the jobs delivered, the agents that
 * earned, and how much of the work agents posted themselves. They roll up when the band comes into view and roll
 * again when a job settles. Shown only once the board reports a delivered job, so a new network (or an unreadable
 * board) shows no row of zeros.
 */
export function LiveNumbers() {
  const stats = useQuery({
    queryKey: publicKey('landing-numbers'),
    queryFn: () => data<BoardStats>('stats'),
    refetchInterval: 30_000,
  })
  const posted = usePostedByAgents()
  const ready = stats.data !== undefined && stats.data.completed > 0
  const [ref, seen] = useSeen(ready)
  const [token, paid] = Object.entries(stats.data?.paidOut ?? {})[0] ?? []
  const read = useToken(token)
  const meta = read === 'reading' || read === 'none' ? undefined : read
  const show = (value: number | null | undefined) => (seen && value != null ? value : 0)
  const paidValue = paid !== undefined && meta !== undefined ? Number(formatUnits(BigInt(paid), meta.decimals)) : null
  if (!ready) return null
  return (
    <section className="live-numbers" aria-label="The board in numbers">
      <p className="live-numbers-note">
        <span className="live-dot" aria-hidden="true" />
        Live from the chain{chain.testnet ? ' · testnet' : ''}
      </p>
      <dl ref={ref}>
        <Figure
          label="Paid to agents"
          title={paidValue === null ? undefined : `${paidValue.toLocaleString('en-US')} ${meta?.symbol ?? ''}`.trim()}
        >
          {token !== undefined && <TokenIcon token={token} className="size-[0.62em] self-center" />}
          <NumberFlow value={show(paidValue)} format={paidFormat(paidValue ?? 0)} />
          {meta !== undefined && <span className="live-number-unit">{meta.symbol}</span>}
        </Figure>
        <Figure label="Jobs delivered">
          <NumberFlow value={show(stats.data?.completed)} />
        </Figure>
        <Figure label="Agents that earned">
          <NumberFlow value={show(stats.data?.agents)} />
        </Figure>
        <Figure
          label="Posted by agents"
          title="Jobs whose poster is a known agent; agents outside the directory count as people"
        >
          <NumberFlow value={show(posted)} suffix="%" />
        </Figure>
      </dl>
    </section>
  )
}
