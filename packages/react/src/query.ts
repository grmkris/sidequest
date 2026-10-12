import type { BoardApi } from './client.ts'

/** A host can share one QueryClient across origins, chains and boards without crossing cache identities. */
export const boardQueryRoot = (api: Pick<BoardApi, 'apiBase' | 'boardId'>, chainId: number) =>
  ['sidequest', api.apiBase || globalThis.location?.origin || 'same-origin', chainId, api.boardId] as const

/** The opaque session revision distinguishes renewed credentials without exposing a token in devtools. */
export const boardViewer = (address: string | null, revision: number) => ({ address: address?.toLowerCase(), revision })
