/**
 * The board's REST API and the indexer's chain facts, same-origin through the Explore Worker, for the board the
 * current route is on: `/b/<slug>/…` and `/embed/<slug>` address that board, everything else the public one
 * (ADR-0008). The client, the session and the result types come from `@sidequest/react`; the session token is
 * kept in localStorage (so a new tab stays signed in until it expires) and is valid on every board. Which address it
 * belongs to is kept beside it (`Wallet.tsx`), so another wallet never inherits it.
 */
import {
  ApiError,
  type BoardApi,
  type ChainJob as BaseChainJob,
  PUBLIC_BOARD_ID,
  type TaskIndexEntry,
  createBoardApi,
} from '@sidequest/react'
import type { ForeignOffer } from './job-offer.tsx'
import type { DirectoryAgent } from '@sidequest/sdk'
import { LAUNCH_MESSAGE, toolAllowed } from './launch.ts'
import { writesOpen } from './wallet.ts'

export {
  ApiError,
  DELIVERABLE_KINDS,
  type AdvanceBudgetTerms,
  type Budget,
  type CallBudgetTerms,
  type Deliverable,
  type DeliverableCheck,
  type DeliverableKind,
  type DeliverableSpec,
  type Quote,
  type QuoteRequest,
  type TaskIndexEntry,
  type TxRequest,
  type BoardInfo,
} from '@sidequest/react'

export type ChainJob = BaseChainJob & { foreign_offer?: ForeignOffer | undefined }

/** The board slug of the current URL (`/b/<slug>`, `/embed/<slug>`), or `public`. */
export function currentBoardId(): string {
  const m = /^\/(?:b|embed)\/([a-z0-9-]{3,32})(?:\/|$)/.exec(window.location.pathname)
  return m?.[1] ?? PUBLIC_BOARD_ID
}

/** `/b/<slug>` on a board route, empty on the public board: what every in-app link is prefixed with. */
export function boardPrefix(): string {
  const b = currentBoardId()
  return b === PUBLIC_BOARD_ID ? '' : `/b/${b}`
}

const apis = new Map<string, BoardApi>()

/**
 * localStorage where the browser allows it (private windows and blocked storage can throw), else this tab only, else
 * this page: a session set when both stores refuse still signs this page's requests, and is gone on reload.
 */
const inPage = new Map<string, string>()
const readFrom = (store: () => Storage, k: string) => {
  try {
    return store().getItem(k)
  } catch {
    return null
  }
}
const persistent = {
  // The page's copy is the newest: it exists only after both stores refused a later write.
  getItem: (k: string) => inPage.get(k) ?? readFrom(() => localStorage, k) ?? readFrom(() => sessionStorage, k),
  setItem: (k: string, v: string) => {
    inPage.delete(k)
    try {
      localStorage.setItem(k, v)
    } catch {
      try {
        sessionStorage.setItem(k, v)
      } catch {
        inPage.set(k, v)
      }
    }
  },
  removeItem: (k: string) => {
    inPage.delete(k)
    for (const store of [() => localStorage, () => sessionStorage])
      try {
        store().removeItem(k)
      } catch {
        // A store that refuses writes holds nothing of ours to remove.
      }
  },
}

export function boardApi(id = currentBoardId()): BoardApi {
  let api = apis.get(id)
  if (api === undefined) {
    const client = createBoardApi({ baseUrl: '', boardId: id, storage: persistent })
    // Mainnet before launch (D16): only the board's read tools leave the browser, whatever page asks.
    api = writesOpen
      ? client
      : {
          ...client,
          tool: <T>(name: string, args?: Record<string, unknown>) =>
            toolAllowed(name, false)
              ? client.tool<T>(name, args)
              : Promise.reject(new ApiError('launching', LAUNCH_MESSAGE)),
        }
    apis.set(id, api)
  }
  return api
}

export const session = (): string | null => boardApi().session()
export const setSession = (token: string | null): void => boardApi().setSession(token)
export const tool = <T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> =>
  boardApi().tool<T>(name, args)
export const data = <T = any>(path: string): Promise<T> => boardApi().data<T>(path)

interface JobsPage {
  jobs: ChainJob[]
  index: { next_block: number; updated_at: number } | null
  nextCursor?: string | null
}

/** How many pages of 500 jobs a list reads at most: a ceiling on a runaway cursor, far above any board today. */
const JOB_PAGES = 20

/**
 * A board's chain jobs on Sidequest v1, newest first, every page of them, and how far the index has read. Explore
 * serves v1 only: jobs on earlier pairs are not shown anywhere.
 */
export async function chainJobs(
  boardId = currentBoardId(),
): Promise<{ jobs: ChainJob[]; index: { next_block: number; updated_at: number } | null }> {
  const api = boardApi(boardId)
  const base = boardId === PUBLIC_BOARD_ID ? 'jobs?limit=500' : `jobs?board=${encodeURIComponent(boardId)}&limit=500`
  const first = await api.data<JobsPage>(base)
  const jobs = [...first.jobs]
  let cursor = first.nextCursor ?? null
  for (let page = 1; cursor !== null && page < JOB_PAGES; page++) {
    const next = await api.data<JobsPage>(`${base}&cursor=${encodeURIComponent(cursor)}`)
    jobs.push(...next.jobs)
    cursor = next.nextCursor ?? null
  }
  return { jobs: jobs.filter((j) => j.kind === 'sidequest-v1'), index: first.index }
}

/** A board's offers frozen on Sidequest v1 (its `task_index`), drafts included. */
export async function taskIndex(boardId = currentBoardId()): Promise<TaskIndexEntry[]> {
  return (await boardApi(boardId).tool<TaskIndexEntry[]>('task_index')).filter((t) => t.kind === 'sidequest-v1')
}

export interface DirectoryPage {
  agents: DirectoryAgent[]
  nextCursor: string | null
  observedAt: number
  chainId: number
  identityRegistry: string
  scope: string
}

export const fetchDirectory = (after?: string) =>
  data<DirectoryPage>(`directory${after === undefined ? '' : `?after=${encodeURIComponent(after)}`}`)

export const fetchDirectoryAgent = (agentId: string) =>
  data<{ agent: DirectoryAgent }>(`directory/${encodeURIComponent(agentId)}`)

/** An agent's directory listing, or null when it is not listed; any other failure throws. */
export async function directoryListing(agentId: string): Promise<DirectoryAgent | null> {
  const response = await fetch(`/data/directory/${encodeURIComponent(agentId)}`)
  if (response.status === 404) return null
  const body = (await response.json()) as { ok?: boolean; agent?: DirectoryAgent; message?: string }
  if (!response.ok || body.ok !== true || body.agent === undefined)
    throw new ApiError('data', body.message ?? 'The directory is unavailable')
  return body.agent
}

export interface ManagedAgent {
  id: string
  name: string
  address: string | null
  agent_id: string | null
  state: string
  last_activity_at: number | null
  revoke_json: string
  /** What its operator lets it do (ADR-0021); a connection's scope only bounds it. */
  roles?: readonly ('work' | 'hire')[]
}

export async function agentEndpoint<T>(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: Record<string, unknown>,
  privyToken?: string,
  signal?: AbortSignal,
): Promise<T> {
  if (method === 'POST' && !writesOpen) throw new ApiError('launching', LAUNCH_MESSAGE)
  const response = await fetch(boardPrefix() + path, {
    method,
    ...(signal === undefined ? {} : { signal }),
    headers: {
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...(session() === null ? {} : { authorization: 'Bearer ' + session() }),
      ...(privyToken === undefined ? {} : { 'x-privy-token': privyToken }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = (await response.json()) as { ok?: boolean; result?: T; code?: string; message?: string }
  if (!response.ok || json.ok === false)
    throw new ApiError(json.code ?? 'error', json.message ?? 'Agent request failed')
  return (json.result ?? json) as T
}
