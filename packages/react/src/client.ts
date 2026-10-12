/**
 * The board client a host embeds: one board's REST tools (`POST <base>/b/<slug>/api/<tool>`, or the public board's
 * `/api/<tool>`), the chain facts (`GET <base>/data/...`), and the session token from SIWE sign-in kept in the
 * storage the host chooses (sessionStorage by default; null keeps it in memory).
 */
import { type Hex, stringToHex } from 'viem'

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Why a refusal happened, when the board says (sponsorship: policy, simulation, cap, floor, rate, unavailable, pending). */
    readonly reason?: string,
  ) {
    super(message)
  }
}

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface BoardApiOptions {
  /** The API origin, e.g. `https://sidequest-api-dev.….workers.dev`; empty for same-origin (Explore proxies it). */
  readonly baseUrl: string
  /** The board slug; default `public`. */
  readonly boardId?: string
  /** Where the session token lives; default the browser's sessionStorage, `null` for memory only. */
  readonly storage?: KeyValueStorage | null
  readonly fetch?: typeof fetch
}

export const SESSION_KEY = 'sidequest.session'
export const PUBLIC_BOARD_ID = 'public'

/** Any EIP-1193 provider: a browser wallet, Privy's embedded wallet, a wagmi connector's provider. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
}

export interface SignInResult {
  session: string
  address: `0x${string}`
  expiresAt: number
  boardId: string
  /** The testnet drip a board may send on first sign-in (ADR-0008). */
  drip?: { status: string; txHash?: string; reason?: string }
}

function memoryStorage(): KeyValueStorage {
  const m = new Map<string, string>()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }
}

export function createBoardApi(options: BoardApiOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, '')
  const boardId = options.boardId ?? PUBLIC_BOARD_ID
  const apiBase = boardId === PUBLIC_BOARD_ID ? baseUrl : `${baseUrl}/b/${boardId}`
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init))
  const storage: KeyValueStorage =
    options.storage === null
      ? memoryStorage()
      : (options.storage ?? (typeof sessionStorage === 'undefined' ? memoryStorage() : sessionStorage))
  const session = () => storage.getItem(SESSION_KEY)
  let revision = 0
  const listeners = new Set<() => void>()
  const subscribeSession = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const sessionRevision = () => revision
  const setSession = (token: string | null) => {
    if (token === session()) return
    if (token === null) storage.removeItem(SESSION_KEY)
    else storage.setItem(SESSION_KEY, token)
    revision++
    for (const listener of listeners) listener()
  }
  const tool = async <T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const token = session()
    const res = await doFetch(`${apiBase}/api/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(args),
    })
    const body = (await res.json()) as { ok: boolean; result?: T; code?: string; message?: string; reason?: string }
    if (!body.ok) {
      if (body.code === 'unauthenticated') setSession(null)
      throw new ApiError(
        body.code ?? String(res.status),
        body.message ?? 'request failed',
        typeof body.reason === 'string' ? body.reason : undefined,
      )
    }
    return body.result as T
  }
  const data = async <T = unknown>(path: string): Promise<T> => {
    const res = await doFetch(`${baseUrl}/data/${path}`)
    const body = (await res.json()) as T & { ok: boolean; message?: string }
    if (!body.ok) throw new ApiError('data', body.message ?? 'not available')
    return body
  }
  return {
    baseUrl,
    boardId,
    apiBase,
    subscribeSession,
    sessionRevision,
    tool,
    data,
    session,
    setSession,
    /** The board's chain jobs, scoped to this board unless it is the public one. */
    jobs: <T = unknown>() =>
      data<T>(boardId === PUBLIC_BOARD_ID ? 'jobs' : `jobs?board=${encodeURIComponent(boardId)}`),
    /** SIWE sign-in with any signer of a plain message (a wallet's `personal_sign`, viem's `signMessage`). */
    async signIn(address: string, signMessage: (message: string) => Promise<Hex>): Promise<SignInResult> {
      const { message } = await tool<{ message: string }>('auth_challenge', { address })
      const signature = await signMessage(message)
      const result = await tool<SignInResult>('auth_login', { message, signature })
      setSession(result.session)
      return result
    },
    /** SIWE sign-in through an EIP-1193 provider (`personal_sign`). */
    signInWith(provider: Eip1193Provider, address: string) {
      return this.signIn(
        address,
        async (message) =>
          (await provider.request({ method: 'personal_sign', params: [stringToHex(message), address] })) as Hex,
      )
    },
    signOut: () => setSession(null),
  }
}

export type BoardApi = ReturnType<typeof createBoardApi>

/** Signs the `eth_signTypedData_v4` JSON a board tool returned, through an EIP-1193 provider. */
export async function signTypedDataWith(
  provider: Eip1193Provider,
  address: string,
  typedDataJson: string,
): Promise<Hex> {
  return (await provider.request({ method: 'eth_signTypedData_v4', params: [address, typedDataJson] })) as Hex
}
