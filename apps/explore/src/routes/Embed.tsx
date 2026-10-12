import { boardKey } from '../queries.ts'
import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { Address } from '../components/kit.tsx'
import { useQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useAccount, useConnect } from 'wagmi'
import { type BoardInfo, currentBoardId, tool } from '../api.ts'
import { PrivyLogin } from '../components/Privy.tsx'

import { FundButton } from '../components/Fund.tsx'
import { useAuth } from '../components/Wallet.tsx'
import { JobPage } from './Job.tsx'
import { JobsPage } from './Jobs.tsx'

export type EmbedEvent =
  | 'ready'
  | 'signed-in'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'disputed'
  | 'settled'
  | 'error'
  | 'resize'

/** Tells the host page what happened (ADR-0008 postMessage contract). Payloads carry only public identifiers. */
function postToHost(board: string, type: EmbedEvent, payload: Record<string, unknown> = {}) {
  if (window.parent === window) return
  window.parent.postMessage({ source: 'sidequest', v: 1, board, type, payload }, '*')
}

/**
 * The drop-in widget (`/embed/<board>?view=task|jobs&…`): one job or the board's jobs
 * list, with no site chrome, inside a host page's iframe (`embed.js`). Wallet: Privy by default; `wallet=injected`
 * connects the page's own `window.ethereum` (a host that already has a wallet, or a test harness).
 */
export function EmbedPage() {
  const { boardId } = useParams({ strict: false }) as { boardId: string }
  const search = new URLSearchParams(window.location.search)
  const wallet = search.get('wallet') ?? 'privy'
  const view = search.get('view') ?? 'jobs'
  const taskId = search.get('taskId')
  const auth = useAuth()
  const { isConnected } = useAccount()
  const { connect, connectors } = useConnect()
  const board = useQuery({
    queryKey: boardKey(boardId, 'get_board', boardId),
    queryFn: async () => (await tool<{ board: BoardInfo }>('get_board')).board,
  })
  const task = useQuery({
    queryKey: boardKey(boardId, 'embed-task', taskId, auth.address?.toLowerCase(), auth.signedIn),
    queryFn: () => tool<{ jobId: string | null }>('get_task', { taskId }),
    enabled: taskId !== null,
    refetchInterval: 10_000,
  })

  useEffect(() => {
    postToHost(boardId, 'ready', { view })
    const ro = new ResizeObserver(() =>
      postToHost(boardId, 'resize', { height: document.documentElement.scrollHeight }),
    )
    ro.observe(document.body)
    return () => ro.disconnect()
  }, [boardId, view])

  const injected = connectors.find((c) => c.id === 'injected')
  useEffect(() => {
    if (wallet === 'injected' && !isConnected && injected !== undefined) connect({ connector: injected })
  }, [wallet, isConnected, connect, injected])

  useEffect(() => {
    if (auth.signedIn && auth.address !== undefined) postToHost(boardId, 'signed-in', { address: auth.address })
  }, [auth.signedIn, auth.address, boardId])

  // The host's look: a forced light or dark theme, its own accent (validated), and no background of our own.
  useEffect(() => {
    const root = document.documentElement
    const theme = search.get('theme')
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme
    const accent = search.get('accent')
    if (accent !== null && /^[0-9a-fA-F]{6}$/.test(accent)) {
      const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(accent.slice(i, i + 2), 16) / 255) as [
        number,
        number,
        number,
      ]
      const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6
      root.style.setProperty('--primary', `#${accent}`)
      root.style.setProperty('--primary-foreground', light ? '#111114' : '#ffffff')
      root.style.setProperty('--ring', `#${accent}`)
    }
    document.body.style.background = 'transparent'
    root.style.background = 'transparent'
  }, [])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const signIn = async () => {
    setBusy(true)
    setError(null)
    try {
      await auth.signIn()
    } catch (e) {
      const m = (e as Error).message.split('\n')[0] ?? 'sign-in failed'
      setError(m)
      postToHost(boardId, 'error', { code: 'sign-in', message: m })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto grid max-w-3xl gap-5 p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 font-semibold">
          <svg aria-hidden viewBox="0 0 32 32" className="size-5 shrink-0">
            <rect width="32" height="32" rx="7" className="fill-primary" />
            <path
              d="M10 8v16M22 8v16M10 16h12"
              className="stroke-primary-foreground"
              strokeWidth="3.5"
              strokeLinecap="round"
            />
          </svg>
          <span className="truncate">{board.data?.name ?? currentBoardId()}</span>
          <span className="text-ui font-normal text-muted-foreground">on Sidequest</span>
        </span>
        <span className="flex items-center gap-2">
          {auth.address === undefined ? (
            wallet === 'injected' ? (
              <Button
                size="sm"
                disabled={injected === undefined}
                onClick={() => injected !== undefined && connect({ connector: injected })}
              >
                Connect wallet
              </Button>
            ) : (
              <PrivyLogin />
            )
          ) : (
            <>
              <Address value={auth.address} />

              <FundButton address={auth.address} />

              {auth.signedIn ? (
                <Badge variant="success">Signed in</Badge>
              ) : (
                <Button size="sm" busy={busy} onClick={signIn}>
                  Sign in
                </Button>
              )}
            </>
          )}
        </span>
      </header>
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {view === 'jobs' && <JobsPage />}
      {view !== 'jobs' && view !== 'task' && <p role="status">Choose a supported widget view: jobs or task.</p>}
      {view === 'task' &&
        (task.data?.jobId !== undefined && task.data.jobId !== null ? (
          <JobPage
            auth={auth}
            jobId={task.data.jobId}
            onEvent={(type, payload) => postToHost(boardId, type, { taskId, ...payload })}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {taskId === null ? 'No job selected.' : 'This job is not published yet.'}
          </p>
        ))}
    </div>
  )
}
