import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardError } from '@sidequest/board'
import { fromNodeSqlite, type AsyncSql } from '@sidequest/indexer'
import { migrateMedia } from '@sidequest/indexer/media-schema'
import type { StageMedia } from '../../../infra/stage.ts'
import { agentActor, walletActor, type MediaActor } from '../src/media/access.ts'
import { MEDIA_SCOPE } from '../src/oauth-validation.ts'
import * as store from '../src/media/store.ts'

const OPERATOR = '0x1111111111111111111111111111111111111111'
const MEMBER = '0x2222222222222222222222222222222222222222'
const STRANGER = '0x3333333333333333333333333333333333333333'
const media: StageMedia = {
  team: [
    { wallet: OPERATOR, role: 'operator' },
    { wallet: MEMBER, role: 'member' },
  ],
  timezone: 'Europe/Ljubljana',
  pullHosts: [],
}
const operator = walletActor(media, OPERATOR)
const member = walletActor(media, MEMBER)
const stranger = walletActor(media, STRANGER)
const anyone: MediaActor = { kind: 'public' }
const link: store.FileLink = async (asset) => (asset.public ? 'public-url' : 'preview-url')
const sha = (n: number) => n.toString(16).padStart(64, '0')
const file = (n: number, role: store.FileRole = 'main'): store.NewFile => ({
  name: `file-${n}.mp4`,
  role,
  bytes: 100 + n,
  type: 'video/mp4',
  sha256: sha(n),
})

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

async function database(): Promise<AsyncSql> {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  await migrateMedia(sql)
  return sql
}

let keys = 0
const ctx = (actor: MediaActor, tool = 'test', args: Record<string, unknown> = { n: ++keys }, key = `k-${++keys}`) => ({
  actor,
  operationKey: key,
  tool,
  args,
  now: 1_800_000_000,
})

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    if (error instanceof BoardError) return error.code
    throw error
  }
  return 'ran'
}

async function seed(sql: AsyncSql) {
  await store.saveGroup(sql, ctx(operator), {
    id: 'launch',
    fields: { kind: 'section', title: 'Launch', level: 'public' },
  })
  await store.saveGroup(sql, ctx(operator), { id: 'drafts', fields: { kind: 'section', title: 'Drafts' } })
  await store.saveGroup(sql, ctx(member), { id: 'since-launch', fields: { kind: 'campaign', title: 'Since launch' } })
  await store.addAsset(sql, ctx(member), {
    id: 'cut-a',
    fields: { title: 'Cut A', kind: 'video', section: 'launch', campaign: 'since-launch', batch: 'main' },
    files: [file(1), file(2, 'poster')],
  })
  await store.addAsset(sql, ctx(member), {
    id: 'cut-b',
    fields: { title: 'Cut B', kind: 'video', section: 'launch', campaign: 'since-launch', batch: 'main' },
    files: [file(3)],
  })
}

describe('the media library', () => {
  it('lets the team add internal assets and only operators publish them; the public sees only what is public', async () => {
    const sql = await database()
    await seed(sql)
    expect(
      await refusal(
        store.addAsset(sql, ctx(stranger), { id: 'x', fields: { title: 'X', kind: 'file' }, files: [file(9)] }),
      ),
    ).toBe('forbidden')
    expect(await refusal(store.setAssetLevel(sql, ctx(member), { id: 'cut-a', level: 'public' }))).toBe('forbidden')
    expect((await store.listMedia(sql, anyone, {}, link)).assets).toEqual([])
    await store.setAssetLevel(sql, ctx(operator), { id: 'cut-a', level: 'public' })
    const shown = await store.listMedia(sql, anyone, {}, link)
    expect(shown.assets.map((asset) => asset.id)).toEqual(['cut-a'])
    expect(shown.assets[0]!.files.map((f) => [f.role, f.url])).toEqual([
      ['main', 'public-url'],
      ['poster', 'public-url'],
    ])
    // Campaigns and internal sections stay with the team.
    expect(shown.groups.map((group) => group.id)).toEqual(['launch'])
    const team = await store.listMedia(sql, member, { campaign: 'since-launch' }, link)
    expect(team.viewer.role).toBe('member')
    expect(team.assets.map((asset) => [asset.id, asset.public])).toEqual([
      ['cut-a', true],
      ['cut-b', false],
    ])
    expect(await refusal(store.getMedia(sql, anyone, 'cut-b', link))).toBe('not-found')
  })

  it('keeps a public asset off the public library while its section is internal', async () => {
    const sql = await database()
    await seed(sql)
    const asset = await store.getMedia(sql, member, 'cut-a', link)
    await store.updateAsset(sql, ctx(member), {
      id: 'cut-a',
      revision: asset.asset.revision,
      fields: { section: 'drafts' },
    })
    await store.setAssetLevel(sql, ctx(operator), { id: 'cut-a', level: 'public' })
    expect((await store.listMedia(sql, anyone, {}, link)).assets).toEqual([])
    expect((await store.fileForServing(sql, 'cut-a', 'file-1.mp4'))?.public).toBe(false)
  })

  it('refuses a stale revision and rolls the whole change back', async () => {
    const sql = await database()
    await seed(sql)
    await store.updateAsset(sql, ctx(member), { id: 'cut-b', revision: 1, fields: { title: 'Cut B, v2' } })
    expect(
      await refusal(store.updateAsset(sql, ctx(member), { id: 'cut-b', revision: 1, fields: { title: 'Lost' } })),
    ).toBe('conflict')
    expect(
      await refusal(store.addAsset(sql, ctx(member), { id: 'cut-b', revision: 1, fields: {}, files: [file(7)] })),
    ).toBe('conflict')
    const after = await store.getMedia(sql, member, 'cut-b', link)
    expect(after.asset.title).toBe('Cut B, v2')
    expect(after.asset.files.map((f) => f.name)).toEqual(['file-3.mp4'])
    // Nothing of the refused changes reached the log.
    expect(
      (await sql.all<{ n: number }>("SELECT COUNT(*) n FROM media_log WHERE action = 'asset.replace'"))[0]?.n,
    ).toBe(0)
  })

  it('answers a retried key with its first result, and refuses the key with other arguments', async () => {
    const sql = await database()
    await seed(sql)
    const first = await store.updateAsset(sql, ctx(member, 'update_media', { id: 'cut-b', title: 'Again' }, 'same'), {
      id: 'cut-b',
      revision: 1,
      fields: { title: 'Again' },
    })
    const again = await store.updateAsset(sql, ctx(member, 'update_media', { id: 'cut-b', title: 'Again' }, 'same'), {
      id: 'cut-b',
      revision: 1,
      fields: { title: 'Again' },
    })
    expect(again).toEqual(first)
    expect(
      await refusal(
        store.updateAsset(sql, ctx(member, 'update_media', { id: 'cut-b', title: 'Other' }, 'same'), {
          id: 'cut-b',
          revision: 2,
          fields: { title: 'Other' },
        }),
      ),
    ).toBe('conflict')
    expect((await store.getMedia(sql, member, 'cut-b', link)).asset.revision).toBe(2)
  })

  it('gives an agent its operator’s role only on a connection granted the media scope', async () => {
    const sql = await database()
    await seed(sql)
    const scoped = agentActor(media, { owner: OPERATOR, scopes: ['sidequest:read', MEDIA_SCOPE] }, 'agent-1')
    const unscoped = agentActor(media, { owner: OPERATOR, scopes: ['sidequest:read'] }, 'agent-1')
    const strangerAgent = agentActor(media, { owner: STRANGER, scopes: [MEDIA_SCOPE] }, 'agent-2')
    expect(await refusal(store.setAssetLevel(sql, ctx(unscoped), { id: 'cut-b', level: 'public' }))).toBe('forbidden')
    expect(await refusal(store.setAssetLevel(sql, ctx(strangerAgent), { id: 'cut-b', level: 'public' }))).toBe(
      'forbidden',
    )
    await store.setAssetLevel(sql, ctx(scoped), { id: 'cut-b', level: 'public' })
    const [row] = await sql.all<{ actor: string; operator: string }>(
      "SELECT actor, operator FROM media_log WHERE action = 'asset.publish'",
    )
    expect(row).toEqual({ actor: 'agent:agent-1', operator: OPERATOR })
    // The digest's "what agents did" reads these rows.
    expect(
      await sql.all<{ action: string; target: string }>(
        "SELECT action, target FROM media_log WHERE actor_kind = 'agent'",
      ),
    ).toEqual([{ action: 'asset.publish', target: 'cut-b' }])
  })
})

describe('the post plan', () => {
  it('approves a post only with its files public, and publishAssets publishes them in the same change', async () => {
    const sql = await database()
    await seed(sql)
    const fields = { channel: 'x', text: 'Ten days after launch.', day: '2026-10-24', assets: ['cut-a'] }
    await store.savePost(sql, ctx(member), { id: 'p1', fields })
    expect(await refusal(store.savePost(sql, ctx(member), { id: 'p1', revision: 1, fields, status: 'approved' }))).toBe(
      'forbidden',
    )
    expect(
      await refusal(store.savePost(sql, ctx(operator), { id: 'p1', revision: 1, fields, status: 'approved' })),
    ).toBe('invalid')
    const approved = await store.savePost(sql, ctx(operator), {
      id: 'p1',
      revision: 1,
      fields,
      status: 'approved',
      publishAssets: true,
    })
    expect(approved).toMatchObject({ status: 'approved', revision: 2, published: 1 })
    expect((await store.getMedia(sql, anyone, 'cut-a', link)).asset.public).toBe(true)
    const plan = await store.listPosts(sql, member, { from: '2026-10-24', to: '2026-10-24' })
    expect(plan.posts).toMatchObject([{ id: 'p1', status: 'approved', approvedBy: `wallet:${OPERATOR}` }])
    // Changing what an approved post says sends it back to draft.
    await store.savePost(sql, ctx(member), { id: 'p1', revision: 2, fields: { ...fields, text: 'Ten days in.' } })
    expect((await store.listPosts(sql, member, {})).posts[0]).toMatchObject({ status: 'draft', revision: 3 })
    expect((await store.listPosts(sql, anyone, {})).posts).toEqual([])
  })

  it('records an approved post by its cleaned URL, never publishing a file, and keeps one record per URL', async () => {
    const sql = await database()
    await seed(sql)
    await store.setAssetLevel(sql, ctx(operator), { id: 'cut-a', level: 'public' })
    const fields = { channel: 'x', text: 'Out now.', assets: ['cut-a', 'cut-b'] }
    await store.savePost(sql, ctx(member), { id: 'p2', fields })
    const url = 'https://x.com/sidequest/status/42?s=20&t=abc&utm_source=share'
    expect(await refusal(store.recordPost(sql, ctx(member), { id: 'p2', url, postedAt: 1, planned: true }))).toBe(
      'invalid',
    )
    await store.setAssetLevel(sql, ctx(operator), { id: 'cut-b', level: 'public' })
    await store.savePost(sql, ctx(operator), { id: 'p2', revision: 1, fields, status: 'approved' })
    await store.setAssetLevel(sql, ctx(operator), { id: 'cut-b', level: 'internal' })
    const recorded = await store.recordPost(sql, ctx(member), { id: 'p2', url, postedAt: 1_800_000_100, planned: true })
    expect(recorded).toEqual({ id: 'p2', status: 'posted', url: 'https://x.com/sidequest/status/42' })
    expect((await store.listMedia(sql, anyone, {}, link)).assets.map((asset) => asset.id)).toEqual(['cut-a'])
    expect((await store.listPosts(sql, anyone, {})).posts.map((post) => post.url)).toEqual([recorded.url])
    expect(
      await refusal(
        store.recordPost(sql, ctx(operator), {
          id: 'p3',
          url: 'https://x.com/sidequest/status/42',
          postedAt: 1,
          planned: false,
        }),
      ),
    ).toBe('conflict')
    // A link nobody planned, or a new link for a post that is out, goes on /media only by an operator.
    const elsewhere = { id: 'p5', url: 'https://x.com/sidequest/status/99', postedAt: 1, planned: false }
    expect(await refusal(store.recordPost(sql, ctx(member), elsewhere))).toBe('forbidden')
    expect(
      await refusal(
        store.recordPost(sql, ctx(member), {
          id: 'p2',
          url: 'https://x.com/other/status/1',
          postedAt: 1,
          planned: true,
        }),
      ),
    ).toBe('forbidden')
    const outside = await store.recordPost(sql, ctx(operator), {
      id: 'p4',
      url: 'https://www.instagram.com/reel/abc/?igsh=xyz',
      postedAt: 1,
      planned: false,
      fields: { assets: ['cut-a'] },
    })
    expect(outside.url).toBe('https://www.instagram.com/reel/abc/')
    expect(
      (await store.listPosts(sql, anyone, { asset: 'cut-a' })).posts.map((post) => [post.id, post.channel]),
    ).toEqual([
      ['p2', 'x'],
      ['p4', 'instagram'],
    ])
  })
})

describe('shares', () => {
  it('hands internal assets out by token hash until revoked or expired', async () => {
    const sql = await database()
    await seed(sql)
    await store.createShare(sql, ctx(member), { id: 'sh1', hash: 'h1', assets: ['cut-b'], expires: 1_800_000_500 })
    expect((await store.liveShare(sql, 'h1', 1_800_000_000))?.assets).toEqual(['cut-b'])
    expect(await store.liveShare(sql, 'h1', 1_800_000_500)).toBeUndefined()
    expect(await refusal(store.listShares(sql, stranger, 0))).toBe('forbidden')
    await store.revokeShare(sql, ctx(member), { id: 'sh1' })
    expect(await store.liveShare(sql, 'h1', 1_800_000_000)).toBeUndefined()
    expect((await store.listShares(sql, operator, 1_800_000_000)).shares[0]).toMatchObject({ id: 'sh1', live: false })
    expect(await refusal(store.revokeShare(sql, ctx(member), { id: 'sh1' }))).toBe('not-found')
  })
})

describe('what the public sees', () => {
  it('keeps team wallets, agent ids, campaigns, batches, notes and internal files out of public reads', async () => {
    const sql = await database()
    await seed(sql)
    await store.setAssetLevel(sql, ctx(operator), { id: 'cut-a', level: 'public' })
    const fields = { channel: 'x', text: 'Out', assets: ['cut-a', 'cut-b'], note: 'attach the 9:16 cut' }
    await store.savePost(sql, ctx(operator), { id: 'p1', fields, status: 'approved' }).catch(() => undefined)
    await store.recordPost(sql, ctx(operator), {
      id: 'p9',
      url: 'https://x.com/sidequest/status/7',
      postedAt: 1,
      planned: false,
      fields: { assets: ['cut-a', 'cut-b'] },
    })
    const asset = (await store.getMedia(sql, anyone, 'cut-a', link)).asset
    for (const key of ['createdBy', 'campaign', 'batch', 'picked']) expect(asset).not.toHaveProperty(key)
    const [post] = (await store.listPosts(sql, anyone, {})).posts
    for (const key of ['createdBy', 'approvedBy', 'recordedBy', 'note', 'campaign'])
      expect(post).not.toHaveProperty(key)
    expect(post?.assets).toEqual(['cut-a'])
    // The team still sees all of it.
    expect((await store.getMedia(sql, member, 'cut-a', link)).asset).toMatchObject({
      createdBy: `wallet:${MEMBER}`,
      batch: 'main',
    })
  })
})

describe('approvals and edits', () => {
  it('refuses to approve a post whose file sits on an internal section, and keeps the fields an edit leaves out', async () => {
    const sql = await database()
    await seed(sql)
    await store.updateAsset(sql, ctx(member), { id: 'cut-b', revision: 1, fields: { section: 'drafts' } })
    const fields = {
      channel: 'x',
      text: 'Soon',
      day: '2026-10-30',
      time: '10:00',
      account: '@sidequest',
      assets: ['cut-b'],
    }
    await store.savePost(sql, ctx(member), { id: 'p1', fields })
    expect(
      await refusal(
        store.savePost(sql, ctx(operator), { id: 'p1', revision: 1, fields, status: 'approved', publishAssets: true }),
      ),
    ).toBe('invalid')
    // An agent changing only the text keeps the day, time and account it did not send.
    await store.savePost(sql, ctx(member), { id: 'p1', revision: 1, fields: { channel: 'x', text: 'Sooner' } })
    expect((await store.listPosts(sql, member, {})).posts[0]).toMatchObject({
      text: 'Sooner',
      day: '2026-10-30',
      time: '10:00',
      account: '@sidequest',
      assets: ['cut-b'],
    })
    // null clears a field.
    await store.savePost(sql, ctx(member), {
      id: 'p1',
      revision: 2,
      fields: { channel: 'x', text: 'Sooner', time: null },
    })
    expect((await store.listPosts(sql, member, {})).posts[0]).not.toHaveProperty('time')
  })

  it('never answers one tool’s result to the same key on another tool', async () => {
    const sql = await database()
    await seed(sql)
    const args = { id: 'cut-b' }
    await store.setAssetLevel(sql, ctx(operator, 'publish_media', args, 'same'), { id: 'cut-b', level: 'public' })
    expect(
      await refusal(store.deleteAsset(sql, ctx(operator, 'delete_media', args, 'same'), { id: 'cut-b' })),
    ).not.toBe('ran-with-replay')
    expect((await store.getMedia(sql, operator, 'cut-b', link)).asset.public).toBe(true)
    expect(await sql.all<{ n: number }>("SELECT COUNT(*) n FROM media_log WHERE operation_key = 'same'")).toEqual([
      { n: 1 },
    ])
  })
})
