import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from './components/ui/empty.tsx'
import { PageTitle, textLinkClass } from './components/kit.tsx'
import { Button } from './components/ui/button.tsx'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  type ErrorComponentProps,
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useLocation,
} from '@tanstack/react-router'
import { Component, type ReactNode, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { PrivyRoot } from './components/Privy.tsx'
import { ToastProvider } from './components/Sheet.tsx'
import { AuthProvider, useAuth } from './components/Wallet.tsx'
import { LaunchGate } from './components/LaunchGate.tsx'
import { Shell } from './components/Shell.tsx'
import { LandingShell } from './components/LandingShell.tsx'
import { SideTokenProvider } from './components/side/SideToken.tsx'
import { ServicesPage } from './routes/Services.tsx'
import { ServicePage } from './routes/Service.tsx'
import { WelcomePage } from './routes/Welcome.tsx'
import { AccountPage } from './routes/Account.tsx'
import { JobLinkPage } from './routes/JobLink.tsx'
import { ActivityPage } from './routes/Activity.tsx'
import { CommonsPage } from './routes/Commons.tsx'
import { RoadmapItemPage } from './routes/RoadmapItem.tsx'
import { CommonsPostPage } from './routes/CommonsPost.tsx'
import { GapPage } from './routes/Gap.tsx'
import './styles.css'
import { chain, wagmiConfig } from './wallet.ts'
import { AgentPage } from './routes/Agent.tsx'
import { WalletPage } from './routes/Wallet.tsx'
import { ConnectPage } from './routes/Connect.tsx'
import { QuoteRequestPage } from './routes/Request.tsx'
import { BoardsPage } from './routes/Boards.tsx'
import { BoardNewPage } from './routes/BoardNew.tsx'
import { EmbedPage } from './routes/Embed.tsx'
import { AdminPage } from './routes/Admin.tsx'
import { SponsorshipPage } from './routes/Sponsorship.tsx'
import { useTokenRegistry } from './useTokens.ts'
import { AgentNewPage } from './routes/AgentNew.tsx'
import { AgentApprovePage } from './routes/AgentApprove.tsx'
import { HomePage } from './routes/Home.tsx'
import { MediaPage } from './routes/Media.tsx'
import { MediaAssetPage } from './routes/MediaAsset.tsx'
import { MediaInternalPage } from './routes/MediaInternal.tsx'
import { MediaSharePage } from './routes/MediaShare.tsx'
import { recoverOnce } from './app-recovery.ts'
import { useRouteAccessibility } from './components/RouteAccessibility.tsx'

function Layout() {
  const location = useLocation()
  useTokenRegistry()
  useRouteAccessibility()
  // The embedded widget (ADR-0008) has no site chrome: the host page is the chrome.
  if (location.pathname.startsWith('/embed/')) return <Outlet />
  // One SIDE sheet above both shells: a navigation while one of its trades is pending keeps it on screen.
  const Frame = location.pathname === '/' ? LandingShell : Shell
  return (
    <SideTokenProvider>
      <Frame>
        <Outlet />
      </Frame>
    </SideTokenProvider>
  )
}

/** Any path without a page, including the retired /me, /stake, /workspace, /approvals and /protocol. */
function NotFoundPage() {
  return (
    <>
      <PageTitle>Page not found</PageTitle>

      <Empty>
        <EmptyHeader>
          <EmptyTitle>Nothing lives at this address</EmptyTitle>
          <EmptyDescription>
            <Link to="/jobs" className={textLinkClass}>
              See the activity
            </Link>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </>
  )
}

/** A page that failed to render: say so and offer a reload, instead of a blank screen. */
function ErrorPage({ error }: ErrorComponentProps) {
  return (
    <>
      <PageTitle>Something went wrong</PageTitle>

      <Empty>
        <EmptyHeader>
          <EmptyTitle>This page could not be shown</EmptyTitle>
          <EmptyDescription className="[overflow-wrap:anywhere]">
            {error instanceof Error ? error.message : 'An unexpected error'}
          </EmptyDescription>
        </EmptyHeader>
        <Button variant="secondary" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </Empty>
    </>
  )
}

const root = createRootRoute({ component: Layout, notFoundComponent: NotFoundPage, errorComponent: ErrorPage })
const jobs = createRoute({ getParentRoute: () => root, path: '/', component: HomePage })
const listings = createRoute({ getParentRoute: () => root, path: '/jobs', component: ActivityPage })
const job = createRoute({
  getParentRoute: () => root,
  path: '/job/$jobId',
  component: function JobRoute() {
    return <JobLinkPage auth={useAuth()} />
  },
})
const request = createRoute({
  getParentRoute: () => root,
  path: '/request/$requestId',
  component: function QuoteRequestRoute() {
    return <QuoteRequestPage auth={useAuth()} />
  },
})
// Quote requests are part of Activity now; their old links (feed, Telegram, bookmarks) land on its Open filter.
const quotes = createRoute({
  getParentRoute: () => root,
  path: '/quotes',
  beforeLoad: () => {
    throw redirect({ to: '/jobs', search: { view: 'open' } as never, replace: true })
  },
})
const quoteRequest = createRoute({
  getParentRoute: () => root,
  path: '/quotes/$requestId',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/request/$requestId', params: { requestId: params.requestId }, replace: true })
  },
})
const agent = createRoute({
  getParentRoute: () => root,
  path: '/agent/$agentId',
  component: AgentPage,
})
// What agents here offer, and the agents (the operator's own first); each agent opens on its page.
const services = createRoute({
  getParentRoute: () => root,
  path: '/services',
  component: () => (
    <LaunchGate title="Services">
      <ServicesPage />
    </LaunchGate>
  ),
})
// One service, to share or come back to: the same card a tile opens, on its own page.
const service = createRoute({
  getParentRoute: () => root,
  path: '/services/$agentId/$serviceId',
  staticData: { measure: 'narrow' },
  component: ServicePage,
})
// A new account's three steps; it opens by itself after the first sign-in (WelcomeOpener in the shell).
const welcome = createRoute({
  getParentRoute: () => root,
  path: '/welcome',
  staticData: { measure: 'narrow' },
  component: () => (
    <LaunchGate title="Set up Sidequest">
      <WelcomePage />
    </LaunchGate>
  ),
})
// The list was /agents before it became Services.
const agents = createRoute({
  getParentRoute: () => root,
  path: '/agents',
  beforeLoad: () => {
    throw redirect({ to: '/services', replace: true })
  },
})
// A wallet's record spans boards, so its page is one for all of them; an agent's wallet goes to the agent.
const wallet = createRoute({
  getParentRoute: () => root,
  path: '/wallet/$address',
  component: WalletPage,
})
const connect = createRoute({
  getParentRoute: () => root,
  path: '/connect',
  staticData: { measure: 'narrow' },
  component: ConnectPage,
})
// /agents/<id> is a natural guess for an agent's page (the list was /agents); the page lives at /agent/<id>.
const agentsAlias = createRoute({
  getParentRoute: () => root,
  path: '/agents/$agentId',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/agent/$agentId', params: { agentId: params.agentId }, replace: true })
  },
})
const agentNew = createRoute({
  getParentRoute: () => root,
  path: '/agents/new',
  staticData: { measure: 'narrow' },
  component: () => (
    <LaunchGate title="Create an agent">
      <AgentNewPage />
    </LaunchGate>
  ),
})
const agentApprove = createRoute({
  getParentRoute: () => root,
  path: '/agents/approve/$agentKey',
  staticData: { measure: 'narrow' },
  component: () => (
    <LaunchGate title="Approve your agent">
      <AgentApprovePage />
    </LaunchGate>
  ),
})
const account = createRoute({
  getParentRoute: () => root,
  path: '/account',
  staticData: { measure: 'narrow' },
  component: AccountPage,
})
const admin = createRoute({
  getParentRoute: () => root,
  path: '/admin',
  staticData: { measure: 'narrow' },
  component: () => (
    <LaunchGate title="Admin">
      <AdminPage />
    </LaunchGate>
  ),
})
const sponsorship = createRoute({
  getParentRoute: () => root,
  path: '/sponsorship',
  staticData: { measure: 'narrow' },
  component: () => (
    <LaunchGate title="Gas payments">
      <SponsorshipPage />
    </LaunchGate>
  ),
})
// Commons: the lobby, roadmap, gaps and roles (one global place; job threads live on job pages).
const commons = createRoute({
  getParentRoute: () => root,
  path: '/commons',
  staticData: { measure: 'narrow' },
  component: CommonsPage,
})
const roadmapItem = createRoute({
  getParentRoute: () => root,
  path: '/commons/roadmap/$itemId',
  staticData: { measure: 'narrow' },
  component: RoadmapItemPage,
})
// One lobby post on its own page, to share or come back to.
const commonsPost = createRoute({
  getParentRoute: () => root,
  path: '/commons/post/$postId',
  staticData: { measure: 'narrow' },
  component: CommonsPostPage,
})
const gap = createRoute({
  getParentRoute: () => root,
  path: '/commons/gaps/$gapId',
  staticData: { measure: 'narrow' },
  component: GapPage,
})
// Tenant boards (ADR-0008): the same pages under /b/<slug>, plus the boards directory, creation and the widget.
const boards = createRoute({
  getParentRoute: () => root,
  path: '/boards',
  staticData: { measure: 'narrow' },
  component: BoardsPage,
})
const boardNew = createRoute({
  getParentRoute: () => root,
  path: '/boards/new',
  staticData: { measure: 'narrow' },
  component: function BoardNewRoute() {
    const auth = useAuth()
    return (
      <LaunchGate title="Create a board">
        <BoardNewPage auth={auth} />
      </LaunchGate>
    )
  },
})
const board = createRoute({ getParentRoute: () => root, path: '/b/$boardId', component: Outlet })
const boardJobs = createRoute({ getParentRoute: () => board, path: '/', component: ActivityPage })
const boardJob = createRoute({
  getParentRoute: () => board,
  path: '/job/$jobId',
  component: function BoardJobRoute() {
    return <JobLinkPage auth={useAuth()} />
  },
})
const boardRequest = createRoute({
  getParentRoute: () => board,
  path: '/request/$requestId',
  component: function BoardQuoteRequestRoute() {
    return <QuoteRequestPage auth={useAuth()} />
  },
})
const boardQuotes = createRoute({
  getParentRoute: () => board,
  path: '/quotes',
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/b/$boardId',
      params: { boardId: params.boardId },
      search: { view: 'open' } as never,
      replace: true,
    })
  },
})
const boardQuoteRequest = createRoute({
  getParentRoute: () => board,
  path: '/quotes/$requestId',
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/b/$boardId/request/$requestId',
      params: { boardId: params.boardId, requestId: params.requestId },
      replace: true,
    })
  },
})
const boardAgent = createRoute({
  getParentRoute: () => board,
  path: '/agent/$agentId',
  component: AgentPage,
})
const embed = createRoute({
  getParentRoute: () => root,
  path: '/embed/$boardId',
  component: EmbedPage,
})
// ADR-0029: the media library. The fixed paths win over $assetId; the asset ids f, s and internal are reserved.
const media = createRoute({ getParentRoute: () => root, path: '/media', component: MediaPage })
const mediaInternal = createRoute({ getParentRoute: () => root, path: '/media/internal', component: MediaInternalPage })
const mediaShare = createRoute({ getParentRoute: () => root, path: '/media/s/$token', component: MediaSharePage })
const mediaAsset = createRoute({ getParentRoute: () => root, path: '/media/$assetId', component: MediaAssetPage })
const router = createRouter({
  // A route's view starts fresh when its params change (one job, then another), as it did when the shell keyed <main>
  // by pathname; the shell itself no longer remounts on every navigation.
  defaultRemountDeps: ({ params }) => params,
  routeTree: root.addChildren([
    jobs,
    listings,
    job,
    request,
    quotes,
    quoteRequest,
    agent,
    services,
    service,
    welcome,
    agents,
    wallet,
    connect,
    account,
    agentNew,
    agentApprove,
    agentsAlias,
    admin,
    sponsorship,
    commons,
    roadmapItem,
    commonsPost,
    gap,
    boards,
    boardNew,
    embed,
    media,
    mediaInternal,
    mediaShare,
    mediaAsset,
    board.addChildren([boardJobs, boardJob, boardRequest, boardQuotes, boardQuoteRequest, boardAgent]),
  ]),
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
  interface StaticDataRouteOption {
    /** A form or a page of reading: its body stops at 42rem under the full-width title (Shell). */
    measure?: 'narrow'
  }
}

/**
 * The last resort for an error outside the pages (Privy's modal, the providers): a reload offer instead of a blank
 * screen. Pages have the router's ErrorPage; this has no router, so it is plain markup.
 */
class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error('An unexpected error') }
  }
  override componentDidCatch(error: unknown) {
    try {
      if (error instanceof Error && recoverOnce(error, sessionStorage)) window.location.reload()
    } catch {
      // no sessionStorage: show the error page rather than risk a reload loop
    }
  }
  override render() {
    if (this.state.error === null) return this.props.children
    return (
      <main className="mx-auto grid max-w-md gap-4 p-8">
        <h1 className="font-display text-2xl leading-tight font-normal tracking-tight">Something went wrong</h1>
        <p className="text-muted-foreground [overflow-wrap:anywhere]">{this.state.error.message}</p>
        <Button variant="secondary" className="justify-self-start" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </main>
    )
  }
}

const queryClient = new QueryClient()

// Explicit per-tab opt-in. The recorder is a separate chunk and never sends telemetry.
try {
  if (sessionStorage.getItem('sidequest:diagnostics') === '1')
    void import('./diagnostics.ts')
      .then(({ installDiagnostics }) => installDiagnostics(queryClient, chain.rpcUrls.default.http))
      .catch(() => {
        /* Optional diagnostics must not interrupt the app. */
      })
} catch {
  /* The app also works with browser storage disabled. */
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <AppErrorBoundary>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <PrivyRoot>
            <AuthProvider>
              <ToastProvider>
                <RouterProvider router={router} />
              </ToastProvider>
            </AuthProvider>
          </PrivyRoot>
        </QueryClientProvider>
      </WagmiProvider>
    </AppErrorBoundary>
  </StrictMode>,
)
