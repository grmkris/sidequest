import { useQuery } from '@tanstack/react-query'
import { useParams, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { boardApi, currentBoardId } from '../api.ts'
import { boardKey } from '../queries.ts'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { LoadingRows, PageTitle } from '../components/kit.tsx'
import type { useSignedIn } from '../components/Wallet.tsx'
import { JobPage } from './Job.tsx'

/** Old notices used board task IDs in /job links. Resolve them on that board before opening the chain job. */
export function JobLinkPage({ auth }: { auth: ReturnType<typeof useSignedIn> }) {
  const { jobId } = useParams({ strict: false })
  const id = jobId ?? ''
  return /^\d+$/.test(id) ? <JobPage auth={auth} jobId={id} /> : <LegacyTaskLink taskId={id} />
}

function LegacyTaskLink({ taskId }: { taskId: string }) {
  const boardId = currentBoardId()
  const navigate = useNavigate()
  const validTaskId = /^[A-Za-z0-9_-]{1,64}$/.test(taskId)
  const read = useQuery({
    queryKey: boardKey(boardId, 'task-link', boardId, taskId),
    queryFn: async () => {
      const { jobId } = await boardApi(boardId).tool<{ jobId: string | null }>('get_task', { taskId })
      return { jobId }
    },
    enabled: validTaskId,
    retry: false,
  })
  useEffect(() => {
    if (read.data === undefined) return
    if (read.data.jobId === null) {
      void navigate({ to: '/account', search: { resume: taskId, board: boardId }, replace: true })
    } else if (boardId === 'public')
      void navigate({ to: '/job/$jobId', params: { jobId: read.data.jobId }, replace: true })
    else void navigate({ to: '/b/$boardId/job/$jobId', params: { boardId, jobId: read.data.jobId }, replace: true })
  }, [read.data, boardId, taskId, navigate])
  if (read.isLoading || read.data !== undefined)
    return (
      <>
        <PageTitle>Opening job</PageTitle>
        <LoadingRows rows={3} />
      </>
    )
  return (
    <>
      <PageTitle>{validTaskId ? 'Job link unavailable' : 'That job link is not valid'}</PageTitle>
      <Alert variant="destructive">
        <AlertDescription>
          This job link could not be resolved: {read.error?.message ?? 'invalid task ID'}.{' '}
          {validTaskId && (
            <Button variant="link" onClick={() => void read.refetch()}>
              Retry
            </Button>
          )}
        </AlertDescription>
      </Alert>
    </>
  )
}
