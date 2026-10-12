import { boardKey, viewerKey } from './queries.ts'
import { currentBoardId } from './api.ts'
/**
 * What a wallet can close or claim (U3), from the board's `collect_actions(wallet)` (B4): settlements, top-up refunds,
 * payments held as `owed`, core refunds and unstaked SIDE, each with the transactions that collect it. Read here
 * only, so the page and the tab badge share one query.
 */
import { useQuery } from '@tanstack/react-query'
import { type TxRequest, tool } from './api.ts'

export type CollectKind = 'settle' | 'claimTopUpRefund' | 'withdraw' | 'claimRefund' | 'stakeWithdraw'

export interface CollectAction {
  kind: CollectKind
  /** The job a job action is about. */
  jobId?: string | null
  /** What the wallet receives, when known: the token and its base units. */
  token?: string | null
  amount?: string | null
  /** One sentence about what collecting does. */
  description: string
  transactions: TxRequest[]
}

export function useCollectActions(wallet: string | undefined, signedIn: boolean) {
  return useQuery({
    queryKey: boardKey(currentBoardId(), 'collect_actions', viewerKey(wallet, signedIn)),
    queryFn: () => tool<CollectAction[]>('collect_actions', { wallet }),
    enabled: wallet !== undefined && signedIn,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  })
}
