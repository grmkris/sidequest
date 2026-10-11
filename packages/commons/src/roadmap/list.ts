import { Effect } from 'effect'
import { CommonsSql } from '../services.ts'
import type { Address } from '../schema/ids.ts'
import { ListRoadmapOutput, RoadmapItem, type ListRoadmapInput } from '../schema/roadmap.ts'
import { Minimums } from '../stake.ts'
import { enabled } from '../roles/holders.ts'
import { activeSupports, itemOf, type ItemRow, type SupportRow } from './common.ts'
import { roadmapWeights } from './weights.ts'

function rank(a: RoadmapItem, b: RoadmapItem): number {
  const lastA = a.hidden !== null || a.mergedInto !== null
  const lastB = b.hidden !== null || b.mergedInto !== null
  if (lastA !== lastB) return lastA ? 1 : -1
  const wa = BigInt(a.weight)
  const wb = BigInt(b.weight)
  return (wa === wb ? 0 : wa > wb ? -1 : 1) || b.supporters - a.supporters || a.createdAt - b.createdAt || a.id - b.id
}
export const listRoadmap = Effect.fnUntraced(function* (
  caller: Address | undefined,
  input: typeof ListRoadmapInput.Type,
) {
  yield* enabled()
  const sql = yield* CommonsSql
  const rows =
    input.status === undefined || input.status === 'all'
      ? sql.all<ItemRow>('SELECT * FROM commons_items ORDER BY id')
      : sql.all<ItemRow>('SELECT * FROM commons_items WHERE status=? ORDER BY id', input.status)
  const supports = sql.all<SupportRow>('SELECT item_id,voter FROM commons_supports WHERE withdrawn_at IS NULL')
  const voters = supports.filter((s) => rows.some((r) => r.id === s.item_id)).map((s) => s.voter)
  const snapshot = yield* roadmapWeights(caller === undefined ? voters : [...voters, caller]).pipe(
    Effect.catch(() => Effect.succeed(null)),
  )
  const items = rows
    .map((row) => {
      const weight =
        snapshot === null
          ? 0n
          : supports
              .filter((s) => s.item_id === row.id)
              .reduce((sum, support) => sum + (snapshot.stake.get(support.voter) ?? 0n), 0n)
      return RoadmapItem.make(itemOf(sql, row, weight, caller))
    })
    .toSorted(rank)
    .slice(0, input.limit ?? 50)
  const own = caller === undefined ? 0n : (snapshot?.stake.get(caller) ?? 0n)
  const { propose } = yield* Minimums
  const result: typeof ListRoadmapOutput.Type = {
    block: snapshot?.block.toString() ?? null,
    weightsAvailable: snapshot !== null,
    items,
    viewer:
      caller === undefined
        ? null
        : {
            activeSupports: activeSupports(sql, caller),
            limit: 5,
            canPropose: own >= propose,
            canVote: own > 0n,
          },
  }
  return result
})
