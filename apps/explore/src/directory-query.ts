import { publicKey } from './queries.ts'
import { useInfiniteQuery } from '@tanstack/react-query'
import { fetchDirectory } from './api.ts'

export function useDirectory() {
  const query = useInfiniteQuery({
    queryKey: publicKey('data-directory'),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchDirectory(pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 20_000,
  })
  return {
    ...query,
    data:
      query.data === undefined
        ? undefined
        : { ...query.data.pages[0]!, agents: query.data.pages.flatMap((page) => page.agents) },
  }
}
