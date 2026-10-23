/**
 * The media library's reads and writes (ADR-0029). Reads go through `/api/<tool>` with the session when there is one,
 * so the team sees internal media and everyone else the public kit; a write signs in first and carries its own
 * operationKey, then refreshes every media query.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { tool } from './api.ts'
import { useAuth } from './components/Wallet.tsx'
import { type MediaAsset, type MediaGroup, type MediaLibrary, type MediaPost, newOperationKey } from './media.ts'

const mediaKeys = {
  all: ['media'] as const,
  library: (filter: Record<string, string>, viewer: string) => ['media', 'library', filter, viewer] as const,
  asset: (id: string, viewer: string) => ['media', 'asset', id, viewer] as const,
  share: (token: string) => ['media', 'share', token] as const,
  shares: (viewer: string) => ['media', 'shares', viewer] as const,
}

/** The viewer in a query key: a signed-in wallet sees its own view (internal media for the team). */
function useViewer(): string {
  const auth = useAuth()
  return auth.signedIn ? (auth.address?.toLowerCase() ?? '') : ''
}

export function useMediaLibrary(filter: Record<string, string> = {}) {
  const viewer = useViewer()
  return useQuery({
    queryKey: mediaKeys.library(filter, viewer),
    queryFn: () => tool<MediaLibrary>('list_media', filter),
    staleTime: 30_000,
  })
}

export interface MediaAssetPage {
  readonly viewer: { readonly role: MediaLibrary['viewer']['role'] }
  readonly asset: MediaAsset
  readonly section?: MediaGroup
  readonly posts: readonly MediaPost[]
}

export function useMediaAsset(id: string) {
  const viewer = useViewer()
  return useQuery({
    queryKey: mediaKeys.asset(id, viewer),
    queryFn: () => tool<MediaAssetPage>('get_media', { id }),
    retry: false,
  })
}

export interface MediaShare {
  readonly label?: string
  readonly expiresAt: number
  readonly assets: readonly MediaAsset[]
}

export function useMediaShare(token: string) {
  return useQuery({
    queryKey: mediaKeys.share(token),
    queryFn: () => tool<MediaShare>('get_media_share', { token }),
    retry: false,
  })
}

export interface MediaShareRecord {
  readonly id: string
  readonly label?: string
  readonly assets: readonly string[]
  readonly expiresAt: number
  readonly live: boolean
  readonly createdBy: string
  readonly createdAt: number
}

export function useMediaShares(enabled: boolean) {
  const viewer = useViewer()
  return useQuery({
    queryKey: mediaKeys.shares(viewer),
    queryFn: () => tool<{ shares: MediaShareRecord[] }>('list_media_shares'),
    enabled,
  })
}

/** One media write: sign in if needed, send it with a fresh operationKey, then refresh every media query. */
export function useMediaWrite<A extends Record<string, unknown>, R = Record<string, unknown>>(name: string) {
  const auth = useAuth()
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (args: A) => {
      if (!auth.signedIn) await auth.signIn()
      return tool<R>(name, { operationKey: newOperationKey(), ...args })
    },
    onSuccess: () => client.invalidateQueries({ queryKey: mediaKeys.all }),
  })
}
