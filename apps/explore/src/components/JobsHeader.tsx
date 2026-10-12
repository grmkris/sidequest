import { boardsQuery } from '../queries.ts'
import { Button } from './ui/button.tsx'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { boardRoutes } from './BoardLink.tsx'
import { PostJobSheet } from './PostJobSheet.tsx'
import { JOBS_LABEL } from '../places.ts'

/** Every hosted board (ADR-0008), shared with the Boards page. */
const useBoards = () => useQuery({ ...boardsQuery(), refetchInterval: 60_000 })

/**
 * The page's title (Activity, or Jobs in the embed's list), its board, and one way in: Post a job, a sheet with the
 * line to tell your agent and how a job goes. Inside an embed only the title shows; the host page explains itself.
 */
export function JobsHeader({ title = JOBS_LABEL }: { title?: string }) {
  const [post, setPost] = useState(false)
  const embedded = window.location.pathname.startsWith('/embed/')
  return (
    <header className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-2xl leading-tight font-semibold tracking-tight text-balance">{title}</h1>
        <BoardName />
      </div>
      {!embedded && (
        <>
          <Button onClick={() => setPost(true)} aria-haspopup="dialog">
            <Plus aria-hidden />
            Post a job
          </Button>
          <PostJobSheet open={post} onClose={() => setPost(false)} />
        </>
      )}
    </header>
  )
}

/** Tenant policy remains visible on its scoped page; public discovery needs no board switcher. */
function BoardName() {
  const { boardId } = boardRoutes()
  const boards = useBoards()
  if (boardId === 'public') return null
  return (
    <span className="rounded-full bg-muted px-2.5 py-1 text-ui text-muted-foreground">
      {boards.data?.boards.find((board) => board.id === boardId)?.name ?? boardId}
    </span>
  )
}
