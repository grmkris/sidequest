import { boardPrefix } from '../api.ts'
import { boardsQuery } from '../queries.ts'
import { useQuery } from '@tanstack/react-query'
import { useRouterState } from '@tanstack/react-router'
import { boardRoutes } from './BoardLink.tsx'
import { PostJob } from './PostJob.tsx'
import { JOBS_LABEL } from '../places.ts'

/** Every hosted board (ADR-0008), shared with the Boards page. */
const useBoards = () => useQuery({ ...boardsQuery(), refetchInterval: 60_000 })

/**
 * The page's title, its board, and Post a job: a brief and verified publisher handoff to the coding client.
 * Inside an embed only the title shows; the host page explains itself.
 */
export function JobsHeader({ title = JOBS_LABEL }: { title?: string }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const embedded = pathname.startsWith('/embed/')
  return (
    <header className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="font-display text-3xl leading-tight font-normal tracking-tight [overflow-wrap:break-word] min-w-0 text-balance sm:text-4xl">
          {title}
        </h1>
        <BoardName />
      </div>
      {!embedded && <PostJob key={boardPrefix()} />}
    </header>
  )
}

/** Tenant policy remains visible on its scoped page; public discovery needs no board switcher. */
function BoardName() {
  const { boardId } = boardRoutes()
  const boards = useBoards()
  if (boardId === 'public') return null
  return (
    <span className="rounded-md bg-muted px-2.5 py-1 text-ui text-muted-foreground">
      {boards.data?.boards.find((board) => board.id === boardId)?.name ?? boardId}
    </span>
  )
}
