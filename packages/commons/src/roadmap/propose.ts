import { nowSeconds } from '../time.ts'
import { Effect } from 'effect'
import { FeedSink, CommonsSql } from '../services.ts'
import type { ProposeItemInput } from '../schema/roadmap.ts'
import type { Address } from '../schema/ids.ts'
import { Minimums, ownStake } from '../stake.ts'
import { StakeRequired } from '../errors.ts'
import { authenticated, enabled } from '../roles/holders.ts'
import { takeRate } from '../rate.ts'
import { sqlEffect } from '../sql/effects.ts'
import { rootGap } from '../gaps/cluster.ts'
import { itemOf, requireItem } from './common.ts'
import { roleHolderEvents } from '../feed.ts'

export const proposeItem = Effect.fnUntraced(function* (
  caller: Address | undefined,
  input: typeof ProposeItemInput.Type,
) {
  const config = yield* enabled()
  const address = yield* authenticated(caller)
  const snapshot = yield* ownStake(address)
  const { propose } = yield* Minimums
  if (snapshot.stake < propose)
    return yield* new StakeRequired({
      minimum: propose.toString(),
      stake: snapshot.stake.toString(),
      backing: '0',
    })
  const now = yield* nowSeconds
  const sql = yield* CommonsSql
  const item = yield* sqlEffect(() =>
    sql.transaction((tx) => {
      const gapIds = [...new Set((input.gapIds ?? []).map((id) => rootGap(tx, id).id))]
      takeRate(tx, 'propose_item', address, now)
      tx.run(
        `INSERT INTO commons_items(title,problem,proposal,proposer,proposer_stake,proposer_block,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'open',?,?)`,
        input.title,
        input.problem,
        input.proposal,
        address,
        snapshot.stake.toString(),
        snapshot.block.toString(),
        now,
        now,
      )
      const id = tx.all<{ id: number }>('SELECT id FROM commons_items WHERE id=last_insert_rowid()')[0]!.id
      for (const gapId of gapIds)
        tx.run('INSERT OR IGNORE INTO commons_item_gaps(item_id,gap_id) VALUES(?,?)', id, gapId)
      return itemOf(tx, requireItem(tx, id))
    }),
  )
  yield* (yield* FeedSink).write(
    roleHolderEvents({ kind: 'roadmap.proposed', prefix: `commons:i${item.id}`, id: item.id, now }, config),
  )
  return { item, threadSubject: item.threadSubject }
})
