import { DatabaseSync } from 'node:sqlite'
import { fromNodeSqlite, migrate } from '@sidequest/indexer'
import * as sdk from '@sidequest/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { collectSnapshot } from '../src/collect-index.ts'

const dbs: DatabaseSync[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})
async function fixture() {
  const db = new DatabaseSync(':memory:')
  dbs.push(db)
  const sql = fromNodeSqlite(db)
  await migrate(sql)
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const hash = `0x${'a'.repeat(64)}`
  const getBlock = vi.fn(async () => ({ hash, timestamp: 1000n }))
  const ctx = {
    ...base,
    deployment: { ...base.deployment, deployBlock: 0n },
    publicClient: { ...base.publicClient, getBlock },
  } as unknown as sdk.Ctx
  db.prepare('INSERT INTO checkpoint (chain_id,next_block,block_hash,updated_at) VALUES (?,?,?,?)').run(
    base.deployment.chainId,
    11,
    hash,
    1000,
  )
  return { db, sql, ctx, getBlock }
}
const wallet = `0x${'b'.repeat(40)}` as const
it('a canonical recent complete index may return an empty list', async () => {
  const f = await fixture()
  expect(await collectSnapshot(f.sql, f.ctx, wallet, 1000)).toEqual({ jobs: [], tokens: [], positions: [] })
})
it('a partial RPC read fails the entire snapshot', async () => {
  const f = await fixture()
  f.getBlock.mockRejectedValueOnce(new Error('RPC unavailable'))
  await expect(collectSnapshot(f.sql, f.ctx, wallet, 1000)).rejects.toThrow('RPC unavailable')
})
it('a changing checkpoint or a lagging finalized block refuses discovery', async () => {
  const f = await fixture()
  f.getBlock.mockImplementationOnce(async () => {
    f.db.prepare('UPDATE checkpoint SET next_block=12').run()
    return { hash: `0x${'a'.repeat(64)}`, timestamp: 1000n }
  })
  await expect(collectSnapshot(f.sql, f.ctx, wallet, 1000)).rejects.toThrow('changed')
  f.getBlock.mockResolvedValueOnce({ hash: `0x${'a'.repeat(64)}`, timestamp: 1121n })
  await expect(collectSnapshot(f.sql, f.ctx, wallet, 1000)).rejects.toThrow('behind')
})

it('excludes retired Holding jobs and owed tokens without deleting their historical rows', async () => {
  const f = await fixture(),
    retired = `0x${'d'.repeat(40)}`,
    holding = f.ctx.stack.holding
  for (const [id, contract] of [
    ['62', retired],
    ['80', holding],
  ] as const) {
    f.db
      .prepare(
        "INSERT INTO jobs (chain_id,job_id,creator,stack,status,updated_block) VALUES (?,?,?,'main','submitted',1)",
      )
      .run(10143, id, wallet)
    f.db
      .prepare("INSERT INTO events VALUES (?,?,1,?,?,?,'Published','{}')")
      .run(10143, contract, Number(id), `publish-${id}`, id)
    f.db
      .prepare("INSERT INTO events VALUES (?,?,2,?,?,?,'PayoutOwed','{}')")
      .run(10143, contract, Number(id), `owed-${id}`, id)
    f.db
      .prepare(
        'INSERT INTO payout_owed (chain_id,job_id,block,log_index,recipient,token,amount,tx_hash) VALUES (?,?,2,?,?,?,?,?)',
      )
      .run(10143, id, Number(id), wallet, wallet, '1', `owed-${id}`)
  }
  expect(await collectSnapshot(f.sql, f.ctx, wallet, 1000)).toEqual({
    jobs: [{ jobId: '80', holding }],
    tokens: [{ holding, token: wallet }],
    positions: [],
  })
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 2 })
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM payout_owed').get()).toEqual({ n: 2 })
})
