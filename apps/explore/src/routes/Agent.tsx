import { publicKey } from '../queries.ts'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { BaseError, ContractFunctionRevertedError, maxUint256, zeroAddress } from 'viem'
import { useReadContracts } from 'wagmi'
import { isNew } from '../agent-stats.ts'
import { type ChainJob, fetchDirectoryAgent } from '../api.ts'
import { AgentJobs } from '../components/agent/AgentJobs.tsx'
import { BackingStrip } from '../components/agent/BackingStrip.tsx'
import { HeroStats } from '../components/agent/HeroStats.tsx'
import { NewAgentCard } from '../components/agent/NewAgentCard.tsx'
import { OwnerTabs } from '../components/agent/OwnerTabs.tsx'
import { ProfileHeader } from '../components/agent/ProfileHeader.tsx'
import { AgentServices } from '../components/DirectoryCards.tsx'
import { HireAgainLink, lastPaidJob } from '../components/job/HireAgain.tsx'
import { PageTitle } from '../components/kit.tsx'
import { BackingManager } from '../components/BackingManager.tsx'
import { PrivyLogin } from '../components/Privy.tsx'
import { Sheet } from '../components/Sheet.tsx'
import { useNow } from '../components/Time.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty.tsx'
import { Skeleton } from '../components/ui/skeleton.tsx'
import { useAuth } from '../components/Wallet.tsx'
import { useOwnedAgent } from '../managed.ts'
import { chain, deployment } from '../wallet.ts'
import type { AgentSummary } from '../agent-summary.ts'
import { backAmount, withoutBack } from '../backing-refusal.ts'
import { useReplaceSearch } from '../page-search.ts'

/** The ERC-8004 identity registry's reads the operator console needs (the SDK's ABI has no `tokenURI`). */
const identityAbi = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'getAgentWallet',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'string' }],
  },
] as const

/** An agent number as the registry numbers them: digits only, without leading zeros; null for anything else. */
function agentNumber(raw: unknown): string | null {
  const s = String(raw ?? '').trim()
  if (!/^\d{1,78}$/.test(s) || BigInt(s) > maxUint256) return null
  return BigInt(s).toString()
}

// ---------------------------------------------------------------------------------------------------------------
// The agent's registration: a data: JSON profile gives a name, description and (inline) picture; a URL gives none.
// ---------------------------------------------------------------------------------------------------------------

type AgentProfile =
  | { kind: 'json'; name: string | null; description: string | null; image: string | null; raw: string }
  | { kind: 'link'; url: string; href: string | null }

const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null

/**
 * Reads what an agent registered (`tokenURI`). A `data:application/json[;base64],…` profile yields its name and
 * description, and its image only when that is itself a data: URL (the page's CSP loads no remote images). Anything
 * else is a link: shown, and linked only when it is https.
 */
function parseProfile(uri: string | null | undefined): AgentProfile | null {
  if (uri === null || uri === undefined || uri.trim() === '') return null
  const u = uri.trim()
  if (/^data:application\/json/i.test(u)) {
    const comma = u.indexOf(',')
    const meta = u.slice(0, comma)
    const payload = u.slice(comma + 1)
    let json = payload
    try {
      if (/;base64$/i.test(meta))
        json = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)))
      else {
        try {
          json = decodeURIComponent(payload)
        } catch {
          json = payload
        }
      }
      const doc = JSON.parse(json) as Record<string, unknown>
      const image = text(doc.image, 200_000)
      return {
        kind: 'json',
        name: text(doc.name, 80),
        description: text(doc.description, 600),
        image: image !== null && /^data:image\/(png|jpeg|gif|webp|svg\+xml);/i.test(image) ? image : null,
        raw: u,
      }
    } catch {
      return { kind: 'link', url: u.slice(0, 120), href: null }
    }
  }
  return { kind: 'link', url: u, href: /^https:\/\//i.test(u) ? u : null }
}

/** A revert (the registry says no), as opposed to an RPC that did not answer. */
const isRevert = (e: unknown) =>
  e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError) !== null

export interface AgentIdentity {
  loading: boolean
  /** true registered, false not, null unknown (the RPC did not answer). */
  exists: boolean | null
  owner: `0x${string}` | undefined
  wallet: `0x${string}` | undefined
  uri: string | undefined
  profile: AgentProfile | null
}

/** The agent's on-chain identity (ERC-8004): owner, agent wallet and registration, re-read every 10 s when `live`. */
function useAgentIdentity(id: string | null, live = false): AgentIdentity {
  const n = id === null ? 0n : BigInt(id)
  const reads = useReadContracts({
    contracts: [
      { address: deployment.identity, abi: identityAbi, functionName: 'ownerOf', args: [n], chainId: chain.id },
      { address: deployment.identity, abi: identityAbi, functionName: 'getAgentWallet', args: [n], chainId: chain.id },
      { address: deployment.identity, abi: identityAbi, functionName: 'tokenURI', args: [n], chainId: chain.id },
    ],
    query: { enabled: id !== null, refetchInterval: live ? 10_000 : false },
  })
  const [owner, wallet, uri] = reads.data ?? []
  const exists = owner === undefined ? null : owner.status === 'success' ? true : isRevert(owner.error) ? false : null
  const w = wallet?.status === 'success' ? wallet.result : undefined
  const u = uri?.status === 'success' ? uri.result : undefined
  return {
    loading: reads.isLoading,
    exists: reads.error !== null && reads.data === undefined ? null : exists,
    owner: owner?.status === 'success' ? owner.result : undefined,
    wallet: w === zeroAddress ? undefined : w,
    uri: u,
    profile: parseProfile(u),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The agent's record: every job it took, the evaluator's ratings and what happened to its bonds (chain facts).
// ---------------------------------------------------------------------------------------------------------------

/** Per token, in base units: reward and bonus (gross), Sidequest's fee on them, and what the worker got (net). */
export type MoneyTotals = { gross: string; fee: string; net: string }

interface AgentTime {
  activeSince: number | null
  lastActive: number | null
  medianTurnaroundSeconds: number | null
  turnarounds: number
}

/** A job row of the record: the indexer's chain facts, its board and the policy hash that keys its frozen offer. */
export type RecordJob = ChainJob & { policy_hash?: string | null }

export interface AgentRecord {
  agent: AgentSummary
  /** The wallets it worked from. */
  wallets: string[]
  bonds: { returned?: number; burned?: number }
  /** The jobs it took. */
  jobs: RecordJob[]
  feedback: Array<{ job_id: string; value: string; tag: string; recorded: number; tx_hash: string | null }>
  // Since the profile release; optional so an older API (and older fixtures) still read.
  /** Whether the identity registry knows the agent; null when it did not answer. */
  registered?: boolean | null
  currentWallet?: string | null
  /** The jobs its wallets posted, newest first (at most 200). */
  posted?: RecordJob[]
  work?: { earned: Record<string, MoneyTotals> }
  hiring?: { posted: number; open: number; paidOut: Record<string, MoneyTotals> }
  time?: AgentTime
}

/**
 * `/data/agents/<id>`: the agent's record, or null when the number has no record (not registered and no jobs). Fetched
 * directly rather than through `data()`, which folds "not found" and "unavailable" into one error; here they differ.
 */
async function fetchAgentRecord(id: string): Promise<AgentRecord | null> {
  const res = await fetch(`/data/agents/${encodeURIComponent(id)}`)
  const body = (await res.json()) as (AgentRecord & { ok: true }) | { ok: false; code?: string; message?: string }
  if (body.ok) return body
  if (body.code === 'not-found') return null
  throw new Error(body.message ?? 'unavailable')
}

const useAgentRecord = (id: string | null, refetchInterval = 30_000) =>
  useQuery({
    queryKey: publicKey('data-agent', id),
    queryFn: () => fetchAgentRecord(id as string),
    enabled: id !== null,
    refetchInterval,
  })

/** "once", "twice", "3 times". */
export const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)

const RATING: Record<string, { words: string; good: boolean }> = {
  completed: { words: 'completed', good: true },
  rejected: { words: 'rejected', good: false },
  'rejected-quality': { words: 'rejected: not good enough', good: false },
  'rejected-falsified': { words: 'rejected: falsified evidence', good: false },
  'not-delivered': { words: 'not delivered', good: false },
}

/** The evaluator's ratings in plain words, completed first: "11 completed", "2 rejected: not good enough". */
export function ratings(
  feedback: Record<string, number>,
): Array<{ tag: string; count: number; words: string; good: boolean }> {
  return Object.entries(feedback)
    .filter(([, n]) => n > 0)
    .map(([tag, count]) => ({
      tag,
      count,
      words: RATING[tag]?.words ?? tag.replaceAll('-', ' '),
      good: RATING[tag]?.good ?? false,
    }))
    .toSorted((a, b) => Number(b.good) - Number(a.good) || b.count - a.count)
}

// ---------------------------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------------------------

/** An agent's public profile: its ERC-8004 identity, its record across every board, what it took and what it posted. */
export function AgentPage() {
  const { agentId } = useParams({ strict: false }) as { agentId: string }
  const id = agentNumber(agentId)
  if (id === null) {
    return (
      <>
        <PageTitle>Agent</PageTitle>
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>That is not an Agent ID</EmptyTitle>
            <EmptyDescription>The ERC-8004 identity registry numbers agents, like 1942.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    )
  }
  return <Profile id={id} />
}

function Profile({ id }: { id: string }) {
  const identity = useAgentIdentity(id)
  const record = useAgentRecord(id)
  const directory = useQuery({
    queryKey: publicKey('directory-agent', id),
    queryFn: () => fetchDirectoryAgent(id),
    refetchInterval: 20_000,
  })
  const wallet = (identity.wallet ?? record.data?.currentWallet ?? record.data?.wallets[0]) as `0x${string}` | undefined
  const { address } = useAuth()
  const now = useNow()
  // "Back this agent" (the header's, and Manage's) opens the backing form in a sheet, for the owner and everyone else.
  // A `?back=<SIDE>` link (a backing request or a refused post) opens it with that amount filled in.
  const [backPrefill] = useState(() => backAmount(window.location.search))
  const [backing, setBacking] = useState(backPrefill !== null)
  // The sheet holds the amount now; drop it from the URL so a reload does not open the sheet again.
  const replaceSearch = useReplaceSearch()
  useEffect(() => {
    if (backPrefill !== null) replaceSearch(withoutBack(window.location.search))
  }, [])
  const openBacking = () => setBacking(true)
  const again = lastPaidJob(record.data?.jobs ?? [], address, id)
  // The signed-in operator's own agent gets its owner tabs; everyone else, the public profile alone.
  const managed = useOwnedAgent(id)
  const overview = (
    <>
      {again !== undefined && (
        <div className="grid gap-1.5">
          <HireAgainLink jobId={again.job_id} />
          <p className="px-4 text-ui text-muted-foreground">
            You paid this agent for job #{again.job_id}. Hire again gives your publisher that job as context for a fresh
            hire.
          </p>
        </div>
      )}
      {record.isLoading ? (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : record.error !== null ? (
        <p className="text-ui text-destructive-text">
          This agent&apos;s record is unavailable right now. Its identity is read from the chain.
        </p>
      ) : record.data === null && identity.exists === false ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>No Agent ID {id}</EmptyTitle>
            <EmptyDescription>
              Nothing is registered under this number on the ERC-8004 identity registry.{' '}
              <Link to="/connect" className="text-foreground underline decoration-foreground/30 underline-offset-4">
                Register an agent
              </Link>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : isNew(record.data) ? (
        managed === undefined ? (
          <NewAgentCard />
        ) : null
      ) : (
        <HeroStats record={record.data!} now={now} owner={managed !== undefined} />
      )}
      {directory.data?.agent !== undefined && (
        <AgentServices agent={directory.data.agent} delivered={record.data?.agent.completed ?? 0} />
      )}
      {record.data != null && !isNew(record.data) && wallet !== undefined && (
        <AgentJobs record={record.data} agentId={id} wallet={wallet} />
      )}
      {wallet !== undefined && identity.exists !== false && <BackingStrip wallet={wallet} viewer={address} />}
      {managed === undefined && identity.exists !== false && (
        <Link
          to="/connect"
          className="justify-self-start px-1 text-ui text-muted-foreground underline decoration-current/30 underline-offset-4 hover:text-foreground"
        >
          Is this your agent? Connect it
        </Link>
      )}
    </>
  )
  return (
    <>
      <ProfileHeader
        id={id}
        identity={identity}
        wallet={wallet}
        directory={directory.data?.agent}
        owner={managed !== undefined}
        {...(managed === undefined ? {} : { managedId: managed.id })}
        onBack={openBacking}
      />
      {managed === undefined ? (
        overview
      ) : (
        <OwnerTabs
          managed={managed}
          overview={overview}
          posted={record.data?.posted}
          taken={record.data?.jobs}
          onBack={openBacking}
        />
      )}
      {wallet !== undefined && identity.exists !== false && (
        <BackSheet
          id={id}
          wallet={wallet}
          viewer={address}
          open={backing}
          onOpenChange={setBacking}
          initialAmount={backPrefill ?? undefined}
        />
      )}
    </>
  )
}

/**
 * Backing this agent, in a sheet: the form for a signed-in viewer (its confirm step stays on the page once sent), a
 * sign-in for anyone else.
 */
function BackSheet({
  id,
  wallet,
  viewer,
  open,
  onOpenChange,
  initialAmount,
}: {
  id: string
  wallet: `0x${string}`
  viewer: `0x${string}` | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  initialAmount: string | undefined
}) {
  if (viewer === undefined)
    return (
      <Sheet open={open} onClose={() => onOpenChange(false)} title="Back this agent">
        <p className="text-sm text-muted-foreground">Sign in to back this agent with SIDE.</p>
        <PrivyLogin />
      </Sheet>
    )
  return (
    <BackingManager
      owner={viewer}
      scope={{ kind: 'agent', account: wallet, agentId: id }}
      sheet={{ open, onOpenChange }}
      initialAmount={initialAmount}
    />
  )
}
