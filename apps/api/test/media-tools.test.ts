import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { fromNodeSqlite } from '@sidequest/indexer'
import { migrateMedia } from '@sidequest/indexer/media-schema'
import type { StageMedia } from '../../../infra/stage.ts'
import { walletActor } from '../src/media/access.ts'
import { type MediaDeps, runMediaTool } from '../src/media/tools.ts'

const OPERATOR = '0x1111111111111111111111111111111111111111'
const media: StageMedia = {
  team: [{ wallet: OPERATOR, role: 'operator' }],
  timezone: 'Europe/Ljubljana',
  pullHosts: [],
}
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

async function deps(): Promise<MediaDeps> {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  await migrateMedia(sql)
  return {
    sql,
    bucket: undefined,
    media,
    signingKey: '',
    origin: 'https://sidequest.example',
    now: () => 1_800_000_000,
    fetch,
  }
}

// A retry after a lost reply must answer the first result, not refuse what the first call created.
it('answers a retried create or record with its first result, before any check the retry would fail', async () => {
  const context = await deps()
  const actor = walletActor(media, OPERATOR)
  const group = { operationKey: 'k-group', kind: 'campaign', title: 'Since launch' }
  const first = await runMediaTool(context, actor, 'save_media_group', group)
  expect(first).toEqual({ ok: true, result: { id: 'since-launch', kind: 'campaign', revision: 1 } })
  expect(await runMediaTool(context, actor, 'save_media_group', group)).toEqual(first)
  expect(await runMediaTool(context, actor, 'save_media_group', { ...group, operationKey: 'k-other' })).toMatchObject({
    ok: false,
    code: 'conflict',
  })
  const record = { operationKey: 'k-post', url: 'https://www.instagram.com/reel/abc/', text: 'Out' }
  const recorded = await runMediaTool(context, actor, 'record_media_post', record)
  expect(recorded).toMatchObject({ ok: true, result: { status: 'posted' } })
  expect(await runMediaTool(context, actor, 'record_media_post', record)).toEqual(recorded)
  expect(await runMediaTool(context, actor, 'record_media_post', { ...record, text: 'Changed' })).toMatchObject({
    ok: false,
    code: 'conflict',
  })
})
