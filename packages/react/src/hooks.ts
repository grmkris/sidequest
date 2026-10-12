import { boardQueryRoot, boardViewer } from './query.ts'
/**
 * Headless hooks over one board: read (board, tasks, a task, applications) and act (sign in, publish a hire, select a
 * worker, approve or reject). Every action returns what the board returned plus the hashes sent; the host renders
 * whatever it likes.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Hex } from 'viem'
import { signTypedDataWith } from './client.ts'
import { useSidequest } from './provider.tsx'
import type { SendProgress } from './send.ts'
import type {
  BoardInfo,
  ChainJob,
  CreatedTask,
  DeliverableSpec,
  SignRequest,
  TaskIndexEntry,
  TxRequest,
} from './types.ts'

function useReadIdentity() {
  const { api, chain, address } = useSidequest()
  const revision = useSyncExternalStore(api.subscribeSession, api.sessionRevision, api.sessionRevision)
  return { api, root: boardQueryRoot(api, chain.id), viewer: boardViewer(address, revision) }
}

export function useBoard() {
  const { api, root } = useReadIdentity()
  return useQuery({
    queryKey: [...root, 'board'],
    queryFn: async () => (await api.tool<{ board: BoardInfo }>('get_board')).board,
    staleTime: 60_000,
  })
}

/** SIWE sign-in with the host's wallet; the token lives in the client's storage and is valid on every board. */
export function useSession() {
  const { api, provider, address } = useSidequest()
  const [token, setToken] = useState<string | null>(() => api.session())
  useEffect(() => setToken(api.session()), [api])
  const signIn = useCallback(async () => {
    if (provider === null || address === null) throw new Error('connect a wallet first')
    const r = await api.signInWith(provider, address)
    setToken(r.session)
    return r
  }, [api, provider, address])
  const signOut = useCallback(() => {
    api.signOut()
    setToken(null)
  }, [api])
  return { address, token, signedIn: token !== null && address !== null, signIn, signOut }
}

export interface TaskListItem {
  jobId: string | null
  task: TaskIndexEntry | undefined
  chain: ChainJob | undefined
}

/** The board's tasks: the board's records merged with the indexed chain facts (drafts and not-yet-indexed jobs included). */
export function useTasks(refetchInterval = 20_000) {
  const { api, root } = useReadIdentity()
  const tasks = useQuery({
    queryKey: [...root, 'task_index'],
    queryFn: () => api.tool<TaskIndexEntry[]>('task_index'),
    refetchInterval,
  })
  const chain = useQuery({
    queryKey: [...root, 'jobs'],
    queryFn: () => api.jobs<{ jobs: ChainJob[]; index: { next_block: number; updated_at: number } | null }>(),
    refetchInterval,
  })
  const items = useMemo(() => {
    const byJob = new Map<string, TaskListItem>()
    for (const c of chain.data?.jobs ?? []) byJob.set(c.job_id, { jobId: c.job_id, chain: c, task: undefined })
    const out: TaskListItem[] = []
    for (const t of tasks.data ?? []) {
      if (t.jobId !== null && byJob.has(t.jobId)) (byJob.get(t.jobId) as TaskListItem).task = t
      else out.push({ jobId: t.jobId, task: t, chain: undefined })
    }
    return [...byJob.values(), ...out].toSorted((a, b) => Number(b.jobId ?? 1e9) - Number(a.jobId ?? 1e9))
  }, [tasks.data, chain.data])
  return {
    items,
    index: chain.data?.index ?? null,
    isLoading: tasks.isLoading || chain.isLoading,
    error: tasks.error ?? chain.error,
    refetch: () => Promise.all([tasks.refetch(), chain.refetch()]),
  }
}

export function useTask<T = Record<string, unknown>>(taskId: string | undefined, refetchInterval = 15_000) {
  const { api, root, viewer } = useReadIdentity()
  return useQuery({
    queryKey: [...root, 'task', taskId, viewer],
    queryFn: () => api.tool<T>('get_task', { taskId }),
    enabled: taskId !== undefined,
    refetchInterval,
  })
}

export function useApplications<T = Array<{ id: string; worker: string; agentId: string; note: string }>>(
  taskId: string | undefined,
) {
  const { api, root, viewer } = useReadIdentity()
  return useQuery({
    queryKey: [...root, 'applications', taskId, viewer],
    queryFn: () => api.tool<T>('list_applications', { taskId }),
    enabled: taskId !== undefined,
    refetchInterval: 15_000,
  })
}

/** The sender for this wallet, or null until one is connected. */
export function useTxSender() {
  return useSidequest().sender
}

function useInvalidate() {
  const qc = useQueryClient()
  const { root } = useReadIdentity()
  return () => qc.invalidateQueries({ queryKey: root })
}

export interface PublishInput {
  title: string
  brief: string
  acceptanceCriteria: string[]
  token: string
  reward: string
  creatorBond: string
  workerBond: string
  deliveryDeadline: number
  mode: 'hire'
  approver?: string
  /** The offer's review, dispute and arbitration windows, in seconds (ADR-0011). */
  windows?: { reviewSeconds: number; disputeSeconds: number; arbitrationSeconds: number }
  /** A named arbitrator; omitted, Sidequest's arbiter. */
  arbitrator?: string
  requiredChecks?: string[]
  deliverable?: DeliverableSpec
  executionBudget?: Record<string, unknown>
  /** A direct hire (decision D3): the agent invited, selected as soon as the offer is published. */
  invite?: { agentId: string }
}

export interface PublishOutcome extends CreatedTask {
  jobId: string | null
  hashes: Hex[]
}

/** Freeze an offer, send its approvals and publish, report, and (for a direct hire) sign the selection. */
export function usePublish() {
  const { api, sender, provider, address } = useSidequest()
  const invalidate = useInvalidate()
  const publish = useCallback((input: PublishInput) => api.tool<CreatedTask>('create_task', { ...input }), [api])
  const publishAndSend = useCallback(
    async (input: PublishInput, onProgress?: (p: SendProgress) => void): Promise<PublishOutcome> => {
      if (sender === null || provider === null || address === null) throw new Error('connect a wallet first')
      const created = await api.tool<CreatedTask & { applicationId?: string }>('create_task', { ...input })
      const hashes = await sender.send(created.taskId, created.transactions, onProgress)
      const task = await api.tool<{ jobId: string | null }>('get_task', { taskId: created.taskId })
      if (input.invite !== undefined && created.applicationId !== undefined) {
        const sel = await api.tool<{ nonce: string; sign: SignRequest }>('select_worker', {
          taskId: created.taskId,
          applicationId: created.applicationId,
        })
        const signature = await signTypedDataWith(provider, address, sel.sign.typedData)
        await api.tool('submit_selection', { taskId: created.taskId, nonce: sel.nonce, signature })
      }
      await invalidate()
      return { ...created, jobId: task.jobId, hashes }
    },
    [api, sender, provider, address, invalidate],
  )
  return { publish, publishAndSend, ready: sender !== null }
}

/** A tool that returns transactions, sent and reported for the task. */
function useTxAction(tool: string) {
  const { api, sender } = useSidequest()
  const invalidate = useInvalidate()
  return useCallback(
    async (args: { taskId: string } & Record<string, unknown>, onProgress?: (p: SendProgress) => void) => {
      if (sender === null) throw new Error('connect a wallet first')
      const r = await api.tool<{ transactions: TxRequest[] }>(tool, args)
      const hashes = await sender.send(args.taskId, r.transactions, onProgress)
      await invalidate()
      return { ...r, hashes }
    },
    [api, sender, invalidate, tool],
  )
}

export function useApprove() {
  const act = useTxAction('approve_work')
  return useCallback((taskId: string, onProgress?: (p: SendProgress) => void) => act({ taskId }, onProgress), [act])
}

export function useReject() {
  const act = useTxAction('reject_work')
  return useCallback(
    (
      input: { taskId: string; violation: 'None' | 'Quality' | 'Falsified'; reason: string },
      onProgress?: (p: SendProgress) => void,
    ) => act(input, onProgress),
    [act],
  )
}

export function useCancel() {
  const act = useTxAction('cancel_task')
  return useCallback((taskId: string, onProgress?: (p: SendProgress) => void) => act({ taskId }, onProgress), [act])
}

/** Hire creator: pick an applicant by signing the Selection (nothing on-chain until the worker activates). */
export function useSelect() {
  const { api, provider, address } = useSidequest()
  const invalidate = useInvalidate()
  return useCallback(
    async (input: { taskId: string; applicationId: string; activateBy?: number }) => {
      if (provider === null || address === null) throw new Error('connect a wallet first')
      const sel = await api.tool<{ nonce: string; sign: SignRequest }>('select_worker', input)
      const signature = await signTypedDataWith(provider, address, sel.sign.typedData)
      const r = await api.tool('submit_selection', { taskId: input.taskId, nonce: sel.nonce, signature })
      await invalidate()
      return r
    },
    [api, provider, address, invalidate],
  )
}
