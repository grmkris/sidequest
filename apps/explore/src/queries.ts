/** Cache identity follows the endpoint and response shape; credentials never belong in a key. */
import { queryOptions } from '@tanstack/react-query'
import { type BoardInfo, boardApi, chainJobs, currentBoardId, data, fetchDirectory, taskIndex } from './api.ts'
import { chain } from './wallet.ts'

const queryScope = (boardId = 'public') => ({
  origin: boardApi(boardId).baseUrl || globalThis.location?.origin || 'same-origin',
  chainId: chain.id,
  boardId,
})

/** Root `/data` resources are network-wide even when the page is on a tenant board. */
export const publicKey = <T extends readonly unknown[]>(...parts: T) => [...parts, queryScope()] as const
export const boardKey = <T extends readonly unknown[]>(boardId: string, ...parts: T) =>
  [...parts, queryScope(boardId)] as const
export const viewerKey = (address: string | undefined, signedIn: boolean) => ({
  address: address?.toLowerCase() ?? null,
  signedIn,
})

export const boardsQuery = () =>
  queryOptions({
    queryKey: publicKey('boards'),
    queryFn: () => data<{ boards: BoardInfo[] }>('boards'),
    staleTime: 60_000,
  })

/** `/data/stats`, the board's record from chain facts: paid out per token in base units, jobs delivered, agents paid. */
export interface BoardStats {
  jobs: number
  completed: number
  agents: number
  paidOut: Record<string, string>
}

export const statsQuery = () =>
  queryOptions({
    queryKey: publicKey('data-stats'),
    queryFn: () => data<BoardStats>('stats'),
    refetchInterval: 30_000,
  })

/** This is a DirectoryPage; the infinite directory keeps its separate `data-directory` key. */
export const directoryFirstQuery = () =>
  queryOptions({
    queryKey: publicKey('directory-first'),
    queryFn: () => fetchDirectory(),
    staleTime: 60_000,
  })

export const chainJobsQuery = (boardId = currentBoardId()) =>
  queryOptions({
    queryKey: boardKey(boardId, 'chain-jobs', boardId),
    queryFn: () => chainJobs(boardId),
    staleTime: 10_000,
  })

export const taskIndexQuery = (boardId = currentBoardId()) =>
  queryOptions({
    queryKey: boardKey(boardId, 'task_index', boardId),
    queryFn: () => taskIndex(boardId),
    staleTime: 10_000,
  })

export const managedKey = (resource: string, address: string | undefined, signedIn: boolean, id?: string) =>
  publicKey(resource, address?.toLowerCase(), viewerKey(address, signedIn), id)
