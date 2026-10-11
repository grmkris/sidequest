/** All-board Collect discovery. Normal cron lag is bounded; stale or divergent discovery refuses the whole read. */
import { BoardError, type CollectSnapshot } from '@sidequest/board'
import { type AsyncSql, indexStatus, delegationsOf } from '@sidequest/indexer'
import * as sdk from '@sidequest/sdk'
import type { Address } from 'viem'

/** Two cron intervals, also checked against the canonical block's timestamp. */
export const COLLECT_INDEX_MAX_AGE = 120
export async function collectSnapshot(
  sql: AsyncSql,
  ctx: sdk.Ctx,
  wallet: Address,
  now: number,
): Promise<CollectSnapshot> {
  const cp = await indexStatus(sql, ctx.deployment.chainId)
  if (
    cp === null ||
    now - cp.updated_at > COLLECT_INDEX_MAX_AGE ||
    cp.updated_at > now + 5 ||
    cp.next_block <= Number(ctx.deployment.deployBlock)
  )
    throw new BoardError('chain', 'the collect index is unavailable or behind; retry after the indexer catches up')
  const [finalized, indexed] = await Promise.all([
    ctx.publicClient.getBlock({ blockTag: 'finalized' }),
    ctx.publicClient.getBlock({ blockNumber: BigInt(cp.next_block - 1) }),
  ])
  const [hash] = await sql.all<{ block_hash: string | null }>(
    'SELECT block_hash FROM checkpoint WHERE chain_id=?',
    ctx.deployment.chainId,
  )
  if (
    hash?.block_hash === null ||
    hash === undefined ||
    indexed.hash?.toLowerCase() !== hash.block_hash.toLowerCase() ||
    Number(finalized.timestamp - indexed.timestamp) > COLLECT_INDEX_MAX_AGE
  )
    throw new BoardError('chain', 'the collect index is behind or divergent; retry after the indexer catches up')
  const jobs = await sql.all<{ jobId: string; holding: string }>(
    `SELECT DISTINCT e.job_id AS jobId, e.contract AS holding FROM events e JOIN jobs j ON j.chain_id=e.chain_id AND j.job_id=e.job_id
     WHERE e.chain_id=? AND e.name='Published' AND (lower(j.creator)=lower(?) OR lower(j.approver)=lower(?) OR lower(j.worker)=lower(?)
       OR EXISTS(SELECT 1 FROM top_ups t WHERE t.chain_id=j.chain_id AND t.job_id=j.job_id AND lower(t.contributor)=lower(?)))
     ORDER BY CAST(e.job_id AS INTEGER)`,
    ctx.deployment.chainId,
    wallet,
    wallet,
    wallet,
    wallet,
  )
  const tokens = await sql.all<{ holding: string; token: string }>(
    `SELECT DISTINCT e.contract AS holding, p.token FROM payout_owed p JOIN events e
     ON e.chain_id=p.chain_id AND e.job_id=p.job_id AND e.block=p.block AND e.log_index=p.log_index
     WHERE p.chain_id=? AND lower(p.recipient)=lower(?)`,
    ctx.deployment.chainId,
    wallet,
  )
  const positions =
    ctx.deployment.sidequest === null
      ? []
      : await delegationsOf(sql, ctx.deployment.chainId, ctx.deployment.sidequest.vault, wallet, cp.next_block)
  const after = await indexStatus(sql, ctx.deployment.chainId)
  if (after === null || after.next_block !== cp.next_block || after.updated_at !== cp.updated_at)
    throw new BoardError('chain', 'the collect index changed during discovery; retry shortly')
  const configured = (holding: string) => sdk.stackByHolding(ctx.deployment, holding) !== undefined
  return {
    jobs: jobs.filter((job) => configured(job.holding)),
    tokens: tokens.filter((token) => configured(token.holding)),
    ...(ctx.deployment.sidequest === null ? {} : { positions }),
  }
}
