import { SkipLink } from './RouteAccessibility.tsx'
import { xLink } from '../wallet.ts'
import { textLinkClass } from './kit.tsx'
import { cn } from '../lib/cn.ts'
/**
 * The app's frame, around its places: Services (what agents here offer, and the agents), Jobs (every board’s work and
 * quote requests) and Commons. On a wide screen: a sidebar with the places, then the operator's agents as their own
 * group with what each waits on, and the account link and the SIDE control at its foot. On a phone: a translucent top
 * bar with Sign in, or the account's mark, at its right, and a tab bar of the places, clear of the notch and the home
 * indicator. Content scrolls under the translucent chrome.
 */
import { Link, useLocation, useMatches } from '@tanstack/react-router'
import { BriefcaseBusiness, LayoutGrid, type LucideIcon, MessagesSquare, Plus } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { currentBoardId } from '../api.ts'
import { JOBS_LABEL } from '../places.ts'
import { onCommons } from '../commons-route.ts'
import { SetupPill, WelcomeOpener } from './onboarding/Onboarding.tsx'
import { agentHome, managedLiveness, pendingByAgent, useManagedAgents, useManagedApprovals } from '../managed.ts'
import { usePaused } from '../wallet.ts'
import { AccountAvatar, AccountLink, Count } from './AccountLink.tsx'
import { type LinkTarget, BoardLink, boardRoutes } from './BoardLink.tsx'
import { LaunchBanner } from './LaunchGate.tsx'
import { ConnectAgent } from './ConnectAgent.tsx'
import { SideChip } from './side/SideToken.tsx'

import { useCollectActions } from '../collect.ts'
import { AccountControl, useAuth, useAutoSignIn } from './Wallet.tsx'
import { AgentOrb } from './agent/AgentOrb.tsx'

type Place = {
  label: string
  icon: LucideIcon
  target: LinkTarget
  /** Whether the current path belongs to this place. */
  active: (path: string) => boolean
}

/** Pages that belong to the account rather than to a job or an agent. */
const ACCOUNT_PATHS = ['/account', '/sponsorship', '/admin', '/welcome']
const AGENT_PATHS = ['/services', '/agents', '/connect']
const onAccount = (p: string) => ACCOUNT_PATHS.some((a) => p.startsWith(a))

/**
 * Services, Jobs and Commons. An agent's page belongs to Services when it is one of the operator's own (`mine`), and
 * to Jobs otherwise: a worker reached from a job. Account pages belong to neither; the account is reached from the sidebar's foot
 * or the phone header.
 */
function places(mine: ReadonlySet<string>): Place[] {
  const r = boardRoutes()
  const ownAgent = (p: string) => {
    const id = /\/agent\/([0-9]+)$/.exec(p)?.[1]
    return id !== undefined && mine.has(id)
  }
  const agents = (p: string) => AGENT_PATHS.some((a) => p.startsWith(a)) || ownAgent(p)
  return [
    { label: 'Services', icon: LayoutGrid, target: { to: '/services' }, active: agents },
    {
      label: JOBS_LABEL,
      icon: BriefcaseBusiness,
      target: r.boardId === 'public' ? { to: '/jobs' } : r.jobs(),
      active: (p) => p !== '/' && !agents(p) && !onAccount(p) && !onCommons(p),
    },
    { label: 'Commons', icon: MessagesSquare, target: { to: '/commons' }, active: onCommons },
  ]
}

/** Site links kept in the sidebar, now that the docs are no longer a place in the nav. */
function SiteLinks({ className }: { className?: string }) {
  return (
    <p className={cn('text-xs text-muted-foreground', className)}>
      <a className="underline" href="https://github.com/grmkris/sidequest" target="_blank" rel="noreferrer">
        Source
      </a>{' '}
      ·{' '}
      <a className="underline" href="/docs">
        Docs
      </a>
      {xLink !== null && (
        <>
          {' '}
          ·{' '}
          <a className="underline" href={xLink} target="_blank" rel="noreferrer">
            X
          </a>
        </>
      )}
    </p>
  )
}

/** The brand mark (src/brand/mark.svg), in the tint so it follows light, dark and a tint change. */
export function Mark() {
  return (
    <svg aria-hidden viewBox="0 0 32 32" className="size-6 shrink-0">
      <rect width="32" height="32" rx="7" className="fill-primary" />
      <path
        d="M8 9h8l8 8M24 23h-8l-8-8"
        className="stroke-primary-foreground"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}

/** The brand; a board's name accompanies it in the phone header. */
function Brand({ stacked = false }: { stacked?: boolean }) {
  const boardId = currentBoardId()
  return (
    <div className="flex min-w-0 items-center">
      <Link
        to="/"
        className="flex min-h-11 max-w-full min-w-0 items-center gap-2 text-base font-semibold tracking-tight"
      >
        <Mark />
        <span className="truncate">
          Sidequest
          {!stacked && boardId !== 'public' && <span className="font-normal text-muted-foreground"> · {boardId}</span>}
        </span>
      </Link>
    </div>
  )
}

/**
 * Every page reads in one column, so its title starts at the same place wherever you go. A form or a page of reading
 * declares `staticData: { measure: 'narrow' }` on its route: everything but its header then stops at 42rem, left-aligned
 * under the full-width title, and so do its loading and error states.
 */
const useNarrow = () => useMatches({ select: (matches) => matches.at(-1)?.staticData.measure === 'narrow' })

function useShellState() {
  const auth = useAuth()
  const account = useAutoSignIn(auth)
  const paused = usePaused()
  const narrow = useNarrow()
  const { pathname } = useLocation()
  const managed = useManagedAgents()
  const approvals = useManagedApprovals()
  const agents = auth.signedIn ? (managed.data?.agents ?? []) : []
  const pending = pendingByAgent(auth.signedIn ? (approvals.data?.approvals ?? []) : [])
  const waiting = [...pending.values()].reduce((sum, n) => sum + n, 0)
  const mine = new Set(agents.flatMap((a) => (a.agent_id === null ? [] : [a.agent_id])))
  const [agentsPlace, jobs, commonsPlace] = places(mine)
  // Nothing is counted when unknown.
  const collect = useCollectActions(auth.address, auth.signedIn).data?.length ?? 0
  return { auth, account, paused, narrow, pathname, agents, pending, waiting, jobs, agentsPlace, commonsPlace, collect }
}

type ShellState = ReturnType<typeof useShellState>

export function Shell({ children }: { children: ReactNode }) {
  const state = useShellState()
  const { auth, account, paused, narrow, pathname, collect } = state
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <SkipLink />
      {auth.signedIn && auth.address !== undefined && <WelcomeOpener address={auth.address} />}
      <aside
        className="sticky top-0 hidden h-dvh flex-col gap-1 overflow-y-auto border-r bg-sidebar px-3 pt-4 pb-4 text-sidebar-foreground lg:flex"
        aria-label="Sections"
      >
        <div className="px-2 pb-4">
          <Brand stacked />
        </div>
        <SidebarPlaces state={state} />
        <div className="mt-auto grid gap-3 pt-6">
          {auth.signedIn && auth.address !== undefined && <SetupPill address={auth.address} className="mx-1" />}
          {auth.signedIn ? (
            <AccountLink collect={collect} />
          ) : (
            <div className="px-1">
              <AccountControl auth={auth} account={account} full />
            </div>
          )}
          <SideChip className="mx-1 justify-self-start" />
          <ConnectAgent variant="sidebar" />
          <SiteLinks className="px-1" />
        </div>
      </aside>

      <div className="min-w-0">
        <header className="material-chrome material-edge-bottom sticky top-0 z-30 pt-[var(--safe-top)] lg:hidden">
          <div className="flex min-h-12 items-center justify-between gap-3 pr-[max(1rem,var(--safe-right))] pl-[max(1rem,var(--safe-left))]">
            <Brand />
            <span className="flex items-center gap-1">
              <ConnectAgent variant="icon" />
              {auth.signedIn ? <AccountAvatar collect={collect} /> : <AccountControl auth={auth} account={account} />}
            </span>
          </div>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          key={pathname}
          className="mx-auto grid w-full max-w-5xl min-w-0 animate-[view-in_0.32s_var(--ease-sheet)] gap-7 pt-5 pr-[max(1rem,var(--safe-right))] pb-[calc(6.5rem+var(--safe-bottom))] pl-[max(1rem,var(--safe-left))] outline-none lg:px-10 lg:pt-10 lg:pb-16"
        >
          <LaunchBanner />
          {paused && (
            <div role="alert" className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive-text">
              The contracts are paused by their admin: nothing can be published, delivered, paid or spent until they are
              unpaused, and deadlines keep running.{' '}
              <a
                className="underline"
                href="https://github.com/grmkris/sidequest#trust"
                target="_blank"
                rel="noreferrer"
              >
                What the admin can do
              </a>
            </div>
          )}
          <div className={cn('grid min-w-0 gap-7', narrow && '[&>*:not(header)]:max-w-2xl')}>{children}</div>
        </main>
      </div>

      <PhoneTabs state={state} />
    </div>
  )
}

function SidebarPlaces({ state }: { state: ShellState }) {
  const { auth, pathname, agents, pending, waiting, jobs, agentsPlace, commonsPlace } = state
  return (
    <nav className="grid gap-0.5" aria-label="Places">
      {agentsPlace !== undefined && (
        <SideItem
          place={agentsPlace}
          on={
            agentsPlace.active(pathname) &&
            !(auth.signedIn && pathname === '/agents/new') &&
            !agents.some((a) => onAgent(pathname, a.agent_id))
          }
        />
      )}
      {jobs !== undefined && <SideItem place={jobs} on={jobs.active(pathname)} />}
      {commonsPlace !== undefined && <SideItem place={commonsPlace} on={commonsPlace.active(pathname)} />}
      {auth.signedIn && (
        <h2 className="flex items-center gap-2 px-2 pt-5 pb-1 text-xs font-medium text-muted-foreground">
          Your agents
          {waiting > 0 && <Count n={waiting} kind="waiting" />}
        </h2>
      )}
      {auth.signedIn && (
        <ul className="grid gap-0.5" aria-label="Your agents">
          {agents.map((agent) => {
            const n = pending.get(agent.id) ?? 0
            const on = onAgent(pathname, agent.agent_id)
            return (
              <li key={agent.id}>
                <BoardLink
                  target={agentHome(agent)}
                  aria-current={on ? 'page' : undefined}
                  className={sideClass(on, true)}
                >
                  <AgentOrb
                    agentId={agent.agent_id ?? agent.id}
                    size="sm"
                    status={managedLiveness(agent, Date.now() / 1000)}
                  />
                  <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                  {n > 0 && <Count n={n} kind="waiting" />}
                </BoardLink>
              </li>
            )
          })}
          <li>
            <Link to="/agents/new" className={sideClass(pathname === '/agents/new', true)}>
              <Plus aria-hidden className="size-4 text-muted-foreground" />
              <span className="flex-1">New agent</span>
            </Link>
          </li>
        </ul>
      )}
    </nav>
  )
}

function PhoneTabs({ state }: { state: ShellState }) {
  const { jobs, agentsPlace, commonsPlace, pathname, waiting } = state
  return (
    <nav
      aria-label="Sections"
      className="material-chrome fixed inset-x-0 bottom-0 z-30 grid auto-cols-fr grid-flow-col border-t border-border/60 pt-1.5 pr-[var(--safe-right)] pb-[calc(0.375rem+var(--safe-bottom))] pl-[var(--safe-left)] lg:hidden"
    >
      {[agentsPlace, jobs, commonsPlace].map((p) => {
        if (p === undefined) return null
        const on = p.active(pathname)
        const Icon = p.icon
        const n = p === agentsPlace ? waiting : 0
        return (
          <PlaceLink
            key={p.label}
            place={p}
            aria-current={on ? 'page' : undefined}
            className={cn(
              textLinkClass,
              cn(
                'relative grid min-h-11 justify-items-center gap-0.5 py-1 text-micro font-medium transition-opacity active:opacity-60',
                on ? 'text-foreground' : 'text-muted-foreground',
              ),
            )}
          >
            <Icon aria-hidden className="size-6" strokeWidth={on ? 2.2 : 1.7} />
            {p.label}
            {n > 0 && <Count n={n} kind="waiting" className="absolute top-0 left-[calc(50%+0.5rem)]" />}
          </PlaceLink>
        )
      })}
    </nav>
  )
}

/** Whether this page is the managed agent's own page. */
function onAgent(pathname: string, agentId: string | null): boolean {
  return agentId !== null && new RegExp(`/agent/${agentId}$`).test(pathname)
}

const sideClass = (on: boolean, nested = false) =>
  cn(
    'flex min-h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors duration-(--dur-fast) [@media(hover:hover)]:hover:bg-sidebar-accent/70',
    nested ? 'text-muted-foreground' : 'font-medium',
    on && 'bg-sidebar-accent text-sidebar-accent-foreground [@media(hover:hover)]:hover:bg-sidebar-accent',
  )

function PlaceLink({ place, ...props }: { place: Place } & Omit<ComponentProps<'a'>, 'href' | 'target'>) {
  return <BoardLink target={place.target} {...props} />
}

function SideItem({ place, on, count = null }: { place: Place; on: boolean; count?: ReactNode }) {
  const Icon = place.icon
  return (
    <PlaceLink place={place} aria-current={on ? 'page' : undefined} className={sideClass(on)}>
      <Icon aria-hidden className={cn('size-4', on ? 'text-foreground' : 'text-muted-foreground')} />
      <span className="flex-1">{place.label}</span>
      {count}
    </PlaceLink>
  )
}
