import { createBoardApi, type BoardApi } from '@sidequest/react'
import type { QueryClient } from '@tanstack/react-query'

const anonymous = new Map<string, BoardApi>()

/** A public read must never inherit a stored session belonging to a disconnected or different wallet. */
export function anonymousCommonsTool<T>(boardId: string, name: string, args: Record<string, unknown>): Promise<T> {
  let api = anonymous.get(boardId)
  if (api === undefined) {
    api = createBoardApi({ baseUrl: '', boardId, storage: null })
    anonymous.set(boardId, api)
  }
  return api.tool<T>(name, args)
}

/** Cancel and forget private bodies and permissions when their viewer leaves, including unfinished reads. */
export function forgetCommonsViewer(client: QueryClient, viewer: string): void {
  const filters = {
    predicate: (query: { queryKey: readonly unknown[] }) =>
      query.queryKey[0] === 'commons' && query.queryKey.at(-1) === viewer,
  }
  void client.cancelQueries(filters)
  client.removeQueries(filters)
}
