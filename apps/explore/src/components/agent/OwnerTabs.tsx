import { managedKey } from '../../queries.ts'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useState } from 'react'
import type { ManagedAgent } from '../../api.ts'
import { agentStatus } from '../../agent-api.ts'
import { needsYou } from '../../agent-stats.ts'
import { unfinishedApproval } from '../../approval-view.ts'
import { useManagedApprovals } from '../../managed.ts'
import { type OwnerTab, focusedApproval, ownerSearch, ownerTab } from '../../owner-route.ts'
import type { RecordJob } from '../../routes/Agent.tsx'
import { useNow } from '../Time.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs.tsx'
import { useAuth } from '../Wallet.tsx'
import { AccessCards } from './AccessCards.tsx'
import { ManagedAgentCard } from './ManagedAgentCard.tsx'
import { NeedsYouStrip } from './NeedsYouStrip.tsx'
import { useReplaceSearch } from '../../page-search.ts'
import { AgentApprovals } from './AgentApprovals.tsx'

const triggerClass = 'flex-none px-0 min-h-9 pointer-coarse:min-h-11 group-data-horizontal/tabs:after:bottom-[-1px]'

/**
 * An agent's page as its operator sees it: the public profile under Overview with what needs them on top, then its
 * approvals (waiting first, then the decided ones) and Manage (budget, wallet, backing, connection, access). The tab
 * is kept in the URL; an approval link (`?tab=approvals&approval=<id>`) opens Approvals with that approval in view.
 */
const canReadStatus = (signedIn: boolean, state: string) => signedIn && state !== 'pending'

export function OwnerTabs({
  managed,
  overview,
  posted,
  taken,
  onBack,
}: {
  managed: ManagedAgent
  overview: ReactNode
  posted: readonly RecordJob[] | undefined
  taken: readonly RecordJob[] | undefined
  onBack: () => void
}) {
  const [tab, setTab] = useState(() => ownerTab(window.location.search))
  const [focus, setFocus] = useState(() => focusedApproval(window.location.search))
  const [scrollTo, setScrollTo] = useState<string | null>(null)
  const auth = useAuth()
  const approvals = useManagedApprovals()
  const mine = (approvals.data?.approvals ?? []).filter((a) => a.agent_id === managed.id)
  const pending = mine.filter((a) => a.status === 'pending').length
  const unfinished = mine.filter(unfinishedApproval).length
  const status = useQuery({
    queryKey: managedKey('managed-agent-status', auth.address, auth.signedIn, managed.id),
    queryFn: () => agentStatus(managed.id),
    refetchInterval: 20000,
    enabled: canReadStatus(auth.signedIn, managed.state),
  })
  const now = useNow()
  const items = needsYou({
    pendingApprovals: pending,
    unfinishedApprovals: unfinished,
    taken: taken ?? [],
    posted: posted ?? [],
    allowances: status.data?.allowances ?? [],
    revoked: managed.state === 'revoked',
    onchainDisabled: status.data?.revocation.onchainPermissionsDisabled === true,
    now,
  })
  const replaceSearch = useReplaceSearch()
  useEffect(() => {
    replaceSearch(ownerSearch(window.location.search, tab))
  }, [tab])
  useEffect(() => {
    if (scrollTo === null) return
    document.getElementById(scrollTo)?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    })
    setScrollTo(null)
  }, [scrollTo, tab])
  // The approval a link pointed at is shown once: leaving Approvals lets it go.
  const go = (next: OwnerTab) => {
    if (next !== 'approvals') setFocus(null)
    setTab(next)
  }
  const open = (next: OwnerTab, card?: string) => {
    go(next)
    if (card !== undefined) setScrollTo(card)
  }
  return (
    <Tabs value={tab} onValueChange={(value) => go(value as OwnerTab)} className="gap-7">
      <TabsList
        variant="line"
        aria-label="Your agent"
        className="w-full justify-start gap-5 rounded-none border-b p-0 group-data-horizontal/tabs:h-auto"
      >
        <TabsTrigger value="overview" className={triggerClass}>
          Overview
        </TabsTrigger>
        <TabsTrigger value="approvals" className={triggerClass}>
          Approvals
          {pending + unfinished > 0 && (
            <span className="tabular-nums rounded-full bg-warning/15 px-1.5 text-micro font-semibold text-warning-text">
              {pending + unfinished}
              <span className="sr-only"> need you</span>
            </span>
          )}
        </TabsTrigger>
        <TabsTrigger value="manage" className={triggerClass}>
          Manage
        </TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="grid gap-7 text-base">
        <NeedsYouStrip items={items} onTab={(t) => open(t)} />
        {overview}
      </TabsContent>
      <TabsContent value="approvals" className="grid gap-7 text-base">
        <AgentApprovals managed={managed} posted={posted} focus={focus} />
      </TabsContent>
      <TabsContent value="manage" className="grid gap-7 text-base">
        <AccessCards agent={managed} />
        <ManagedAgentCard agent={managed} onBack={onBack} />
      </TabsContent>
    </Tabs>
  )
}
