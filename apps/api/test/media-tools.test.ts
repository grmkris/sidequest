import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { fromNodeSqlite } from '@sidequest/indexer'
import { migrateMedia } from '@sidequest/indexer/media-schema'
import type { StageMedia } from '../../../infra/stage.ts'
import { agentActor, walletActor } from '../src/media/access.ts'
import { type MediaDeps, mediaTools, runMediaTool } from '../src/media/tools.ts'
import { mcpRoute } from '../src/mcp.ts'
import type { OAuthGrant } from '../src/oauth.ts'

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

const MEMBER = '0x2222222222222222222222222222222222222222'
const team: StageMedia = {
  team: [
    { wallet: OPERATOR, role: 'operator' },
    { wallet: MEMBER, role: 'member' },
  ],
  timezone: 'Europe/Ljubljana',
  pullHosts: [],
}
const grantOf = (owner: string, scopes: string[]): OAuthGrant => ({
  owner,
  address: '0x3333333333333333333333333333333333333333',
  chainId: 143,
  scopes,
  agentIds: ['agent-1'],
  registryAgentId: '10',
  clientId: 'client',
  resource: 'https://sidequest.example/mcp',
})

/** Hosted MCP as the Worker runs it for media: the grant's operator is the actor, with the connection's scopes. */
async function mcp(context: MediaDeps, grant: OAuthGrant, method: string, params: Record<string, unknown> = {}) {
  const reply = await mcpRoute({
    method: 'POST',
    pathname: '/mcp',
    origin: 'https://sidequest.example',
    headers: {},
    body: { jsonrpc: '2.0', id: 1, method, params },
    grant,
    tools: mediaTools,
    call: (tool, args, agentId) =>
      runMediaTool({ ...context, media: team }, agentActor(team, grant, agentId), tool, args),
  })
  // SAFETY: a JSON-RPC result reply from mcpRoute.
  return (reply.body as { result: { tools?: { name: string }[]; structuredContent?: any } }).result
}

it("lets an operator's agent do over MCP what the operator does in the browser, once the connection holds sidequest:media", async () => {
  const context = { ...(await deps()), media: team }
  const owner = walletActor(team, OPERATOR)
  await runMediaTool(context, owner, 'save_media_group', { operationKey: 'g', kind: 'campaign', title: 'Drafts' })
  const withMedia = grantOf(OPERATOR, ['sidequest:read', 'sidequest:media'])
  const without = grantOf(OPERATOR, ['sidequest:read'])
  const listed = (grant: OAuthGrant) => mcp(context, grant, 'tools/list').then((r) => r.tools!.map((t) => t.name))
  expect(await listed(withMedia)).toEqual(
    expect.arrayContaining(['publish_media', 'save_media_post', 'add_media', 'list_media']),
  )
  expect(await listed(without)).toEqual(expect.arrayContaining(['list_media', 'get_media', 'list_media_posts']))
  expect(await listed(without)).not.toContain('publish_media')
  // With the scope the agent sees the team's view and plans and approves like its operator.
  const seen = await mcp(context, withMedia, 'tools/call', { name: 'list_media', arguments: {} })
  expect(seen.structuredContent.result.viewer.role).toBe('operator')
  expect(seen.structuredContent.result.groups.map((g: { id: string }) => g.id)).toEqual(['drafts'])
  const planned = await mcp(context, withMedia, 'tools/call', {
    name: 'save_media_post',
    arguments: { operationKey: 'p', channel: 'x', text: 'Ten days after launch.', status: 'approved' },
  })
  expect(planned.structuredContent.result).toMatchObject({ status: 'approved', revision: 1 })
  // Without it, the same operator's agent reads only what is public, like any agent.
  const publicView = await mcp(context, without, 'tools/call', { name: 'list_media', arguments: {} })
  expect(publicView.structuredContent.result).toMatchObject({ viewer: { role: null }, groups: [] })
  const refused = await mcp(context, without, 'tools/call', {
    name: 'publish_media',
    arguments: { id: 'x', public: true },
  })
  expect(refused.structuredContent).toMatchObject({ code: 'scope-required', scope: 'sidequest:media' })
  // A member's agent plans but cannot approve.
  const member = grantOf(MEMBER, ['sidequest:read', 'sidequest:media'])
  const approval = await mcp(context, member, 'tools/call', {
    name: 'save_media_post',
    arguments: { operationKey: 'm', channel: 'x', text: 'Hi', status: 'approved' },
  })
  expect(approval.structuredContent).toMatchObject({ ok: false, code: 'forbidden' })
})
