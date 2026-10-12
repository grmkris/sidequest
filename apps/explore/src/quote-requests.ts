import { boardKey } from './queries.ts'
import { useQuery } from '@tanstack/react-query'
import { type QuoteRequest, currentBoardId, tool } from './api.ts'

/**
 * The board's quote requests for the Jobs list: open ones, plus those closed or picked in the last week. A picked
 * request is shown as its job, so the list drops it; its page still finds it here.
 */
export function useQuoteRequests() {
  const boardId = currentBoardId()
  return useQuery({
    queryKey: boardKey(boardId, 'list_quote_requests', boardId, 'recent'),
    queryFn: () => tool<QuoteRequest[]>('list_quote_requests', { recent: true }),
    refetchInterval: 20_000,
    refetchIntervalInBackground: false,
  })
}
