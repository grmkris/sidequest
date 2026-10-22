/**
 * A wallet's page: what a wallet that is not an agent did here. Its record as a poster (what it posted, paid out, still
 * holds and lost to disputes), the agents it hired, owns and backs, its open requests and its activity. An agent's
 * wallet goes to the agent's page, which tells the same story with a name. Everything here is public.
 */
import { directoryFirstQuery } from '../queries.ts'
import { useQuery } from '@tanstack/react-query'
import { Link, Navigate, useParams } from '@tanstack/react-router'
import { ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import { type Address, erc721Abi, getAddress, isAddress } from 'viem'
import { useReadContract, useReadContracts } from 'wagmi'
import { type FeedEvent, involves, newestPerJob } from '../activity-feed.ts'
import { useAgents } from '../agent-summary.ts'
import { data } from '../api.ts'
import { EventRow } from '../components/activity/EventRow.tsx'
import { RowList } from '../components/activity/StretchedRow.tsx'
import { type ActivityFeed, useActivityFeed } from '../components/activity/useActivityFeed.ts'
import { AgentCardLink } from '../components/agent/AgentCard.tsx'
import { AgentOrb } from '../components/agent/AgentOrb.tsx'
import { factoryValue, walletAgentsKey } from '../components/DelegationPositions.tsx'
import { CopyButton, LoadingRows, PageTitle, Section, shortAddress, textLinkClass } from '../components/kit.tsx'
import { TokenAmount } from '../components/token/TokenAmount.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty.tsx'
import { Monogram, useAuth } from '../components/Wallet.tsx'
import { useDelegations } from '../delegation-query.ts'
import { useDirectory } from '../directory-query.ts'
import { cn } from '../lib/cn.ts'
import { positionLabel } from '../position-label.ts'
import { usePosterAgents } from './Jobs.tsx'
import { sidequest } from '../sidequest.ts'
import { type TokenSum, type WalletRecord, hasHistory, walletRecord } from '../wallet-record.ts'
import { chain, deployed, deployment, explorer } from '../wallet.ts'

const TILE = 'grid min-w-0 content-start gap-1 rounded-xl bg-card px-4 py-3.5 shadow-stock'

/** The agent whose wallet this is, if any: from what this page already knows, else the index's answer. */
function useWalletAgent(address: Address): { agentId: string | null; checked: boolean } {
  const known = usePosterAgents().get(address.toLowerCase())
  // The same read usePosterAgents makes: until the directory answers, its agents' wallets are unknown.
  const directory = useQuery(directoryFirstQuery())
  const indexed = useQuery({
    queryKey: walletAgentsKey(address),
    queryFn: () => data<{ agents: string[] }>(`agents?wallet=${encodeURIComponent(address)}`),
    enabled: known === undefined,
    staleTime: 5 * 60_000,
  })
  if (known !== undefined) return { agentId: known, checked: true }
  return { agentId: indexed.data?.agents[0] ?? null, checked: !indexed.isPending && !directory.isPending }
}

/** The agents this wallet owns: every agent this page knows, asked who owns it, and the registry's count as a check. */
function useOwnedAgents(address: Address) {
  const directory = useDirectory().data?.agents ?? []
  const summaries = useAgents().data?.agents ?? []
  const ids = [...new Set([...directory.map((a) => a.agentId), ...summaries.map((a) => a.agentId)])]
  const owners = useReadContracts({
    contracts: ids.map(
      (id) =>
        ({
          address: deployment.identity,
          abi: erc721Abi,
          functionName: 'ownerOf',
          args: [BigInt(id)],
          chainId: chain.id,
        }) as const,
    ),
    query: { enabled: deployed && ids.length > 0, staleTime: 60_000 },
  })
  const count = useReadContract({
    address: deployment.identity,
    abi: erc721Abi,
    functionName: 'balanceOf',
    args: [address],
    chainId: chain.id,
    query: { enabled: deployed, staleTime: 60_000 },
  })
  const owned = ids.filter((_, i) => {
    const read = owners.data?.[i]
    return read?.status === 'success' && read.result.toLowerCase() === address.toLowerCase()
  })
  return { owned, total: count.data === undefined ? null : Number(count.data) }
}

function Tile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className={TILE}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl leading-tight font-semibold tracking-tight tabular-nums">{value}</span>
      {sub !== undefined && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  )
}

/** The largest amount, and how many other tokens there are. */
function Money({ sums }: { sums: TokenSum[] }) {
  const [first] = sums
  if (first === undefined) return <>None</>
  return (
    <>
      <TokenAmount value={first.value} token={first.token} static />
      {sums.length > 1 && <span className="text-base text-muted-foreground"> +{sums.length - 1}</span>}
    </>
  )
}

function Record({ record }: { record: WalletRecord }) {
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <Tile label="Posted" value={record.posted} sub={`${record.paidJobs} paid`} />
      <Tile label="Paid out" value={<Money sums={record.paid} />} />
      <Tile label="In escrow" value={<Money sums={record.escrow} />} />
      <Tile label="Disputes" value={record.disputes} sub={`${record.refunded} refunded`} />
    </div>
  )
}

/** Agents as a list of rows: each orb and name opening its card, with what the wallet has with it. */
function AgentRows({ rows }: { rows: { agentId: string; note: ReactNode }[] }) {
  return (
    <ul className="m-0 grid list-none gap-0 overflow-hidden rounded-xl bg-card p-0 shadow-stock">
      {rows.map(({ agentId, note }) => (
        <li
          key={agentId}
          className="flex min-h-12 items-center gap-3 border-t border-border/70 px-4 py-2 first:border-t-0"
        >
          <AgentOrb agentId={agentId} size="sm" />
          <span className="min-w-0 flex-1 truncate text-sm">
            <AgentCardLink id={agentId} />
          </span>
          <span className="shrink-0 text-ui text-muted-foreground tabular-nums">{note}</span>
        </li>
      ))}
    </ul>
  )
}

function Backing({ address }: { address: Address }) {
  const reads = useDelegations(sidequest, address, deployed)
  const directory = useDirectory().data?.agents
  const positions = (reads.data?.positions ?? []).filter((p) => p.position.shares > 0n)
  if (positions.length === 0) return null
  const rows = positions.flatMap(({ position }) => {
    const label = positionLabel(position.account, { directory })
    return label.agentId === undefined ? [] : [{ agentId: label.agentId, note: factoryValue(position.value) }]
  })
  if (rows.length === 0) return null
  return (
    <Section title="Backs">
      <AgentRows rows={rows} />
    </Section>
  )
}

function Owned({ address }: { address: Address }) {
  const { owned, total } = useOwnedAgents(address)
  if (owned.length === 0 && (total === null || total === 0)) return null
  const unlisted = total === null ? 0 : total - owned.length
  return (
    <Section
      title="Owns"
      {...(unlisted > 0
        ? { note: `${unlisted} more ${unlisted === 1 ? 'agent' : 'agents'} not listed on this board.` }
        : {})}
    >
      {owned.length > 0 && <AgentRows rows={owned.map((agentId) => ({ agentId, note: '' }))} />}
    </Section>
  )
}

/** Its open requests, then its jobs, each once at its newest step. */
function Feed({ feed, address }: { feed: ActivityFeed; address: Address }) {
  const { steps } = feed
  const mine = newestPerJob(feed.events.filter((e): e is FeedEvent => e.job !== undefined && involves(e.job, address)))
  const asking = mine.filter((e) => e.jobId === null && e.job?.bucket === 'open')
  const rest = mine.filter((e) => !asking.includes(e))
  if (feed.jobs.loading || steps.isPending) return <LoadingRows rows={3} />
  return (
    <>
      {asking.length > 0 && (
        <Section title="Asking for quotes">
          <RowList label="Open requests">
            {asking.map((event) => (
              <EventRow key={event.key} event={event} />
            ))}
          </RowList>
        </Section>
      )}
      {rest.length > 0 && (
        <Section title="Activity">
          <RowList label="Activity">
            {rest.map((event) => (
              <EventRow key={event.key} event={event} />
            ))}
          </RowList>
          {steps.hasNextPage && (
            <Button
              variant="secondary"
              className="justify-self-center"
              busy={steps.isFetchingNextPage}
              onClick={() => void steps.fetchNextPage()}
            >
              Show older activity
            </Button>
          )}
        </Section>
      )}
    </>
  )
}

function Header({ address, you }: { address: Address; you: boolean }) {
  return (
    <header className="flex items-center gap-4">
      <span className="inline-flex size-16 shrink-0 [&>span]:size-full">
        <Monogram seed={address} />
      </span>
      <PageTitle
        sub={
          <>
            {you && (
              <>
                <Badge variant="info">You</Badge>
                <Link to="/account" className={textLinkClass}>
                  Your account
                </Link>
              </>
            )}
            {/* A phone has the short form in the title; the copy button carries the whole. */}
            <span className="hidden font-mono text-xs break-all sm:inline">{address}</span>
            <CopyButton value={address} label="Copy address" />
            <a
              href={explorer('address', address)}
              target="_blank"
              rel="noreferrer"
              className={cn(textLinkClass, 'inline-flex items-center gap-1 text-ui')}
            >
              Explorer
              <ExternalLink aria-hidden className="size-3" />
            </a>
          </>
        }
      >
        <span className="font-mono">{shortAddress(address)}</span>
      </PageTitle>
    </header>
  )
}

function WalletProfile({ address }: { address: Address }) {
  const { address: viewer } = useAuth()
  const you = viewer !== undefined && viewer.toLowerCase() === address.toLowerCase()
  const feed = useActivityFeed(address)
  const record = walletRecord(feed.feed, address)
  return (
    <>
      <Header address={address} you={you} />
      {/* The record reads the chain's jobs only; their titles can come later. */}
      {!feed.jobs.chainReady ? (
        <LoadingRows rows={2} />
      ) : hasHistory(record) ? (
        <Record record={record} />
      ) : (
        <p className="px-1 text-ui text-muted-foreground">
          It has not posted, asked for quotes or approved work on Sidequest.
        </p>
      )}
      {record.hired.length > 0 && (
        <Section title="Hired">
          <AgentRows
            rows={record.hired.map((h) => ({ agentId: h.agentId, note: `${h.jobs} ${h.jobs === 1 ? 'job' : 'jobs'}` }))}
          />
        </Section>
      )}
      <Owned address={address} />
      <Backing address={address} />
      <Feed feed={feed} address={address} />
    </>
  )
}

export function WalletPage() {
  const { address: raw } = useParams({ from: '/wallet/$address' })
  if (!isAddress(raw, { strict: false }))
    return (
      <>
        <PageTitle>Wallet</PageTitle>
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>That is not a wallet address</EmptyTitle>
            <EmptyDescription>A wallet address is 0x followed by 40 hexadecimal characters.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    )
  return <AgentOrWallet address={getAddress(raw)} />
}

/** An agent's wallet opens the agent; any other wallet, its own page. */
function AgentOrWallet({ address }: { address: Address }) {
  const agent = useWalletAgent(address)
  if (agent.agentId !== null) return <Navigate to="/agent/$agentId" params={{ agentId: agent.agentId }} replace />
  if (!agent.checked) return <LoadingRows rows={3} />
  return <WalletProfile address={address} />
}
