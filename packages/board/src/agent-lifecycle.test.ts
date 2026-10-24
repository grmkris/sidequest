import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentLifecycle } from './agent-lifecycle.ts'
import { SponsorDesk } from './sponsor.ts'
import { fromNodeSqlite } from './store.ts'

const operator = '0x1111111111111111111111111111111111111111' as const
const now = 1_800_000_000
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  const context = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const sponsor = new SponsorDesk({ sql, ctx: context, now: () => now, fail: (_code, message) => new Error(message) })
  const lifecycle = new AgentLifecycle({ sql, context, sponsor, now: () => now })
  lifecycle.agents.create({
    id: 'agent',
    operator,
    privyUserId: 'did:privy:test',
    name: 'Test',
    registry: context.deployment.identity,
    chainId: 10143,
  })
  sql.run("UPDATE agents SET state='active' WHERE id='agent'")
  const family = (id = 'family', agent = 'agent', revoked: number | null = null) =>
    sql.run(
      'INSERT INTO agent_oauth_families (id,client_id,agent_id,board_id,scopes_json,resource,created_at,revoked_at) VALUES (?,?,?,?,?,?,?,?)',
      id,
      'client',
      agent,
      'public',
      '["sidequest:read"]',
      'https://fixture.test/mcp',
      now,
      revoked,
    )
  const token = (kind: 'access' | 'refresh', expires = now + 60, consumed: number | null = null, familyId = 'family') =>
    sql.run(
      'INSERT INTO agent_oauth_tokens (hash,family_id,kind,expires_at,consumed_at) VALUES (?,?,?,?,?)',
      `${kind}:${familyId}`,
      familyId,
      kind,
      expires,
      consumed,
    )
  return { lifecycle, sql, family, token, status: () => lifecycle.status('agent', operator) }
}

describe('authoritative coding-agent connection status', () => {
  it('does not confuse operator activity or another agent’s connection with this agent’s OAuth', async () => {
    const f = fixture()
    f.lifecycle.agents.touch('agent')
    expect((await f.status()).connected).toBe(false)
    f.family('other', 'another-agent')
    f.token('access', now + 60, null, 'other')
    expect((await f.status()).connected).toBe(false)
    f.family()
    f.token('access')
    expect((await f.status()).connected).toBe(true)
  })

  it('stays connected while an unconsumed refresh token can renew expired access', async () => {
    const f = fixture()
    f.family()
    f.token('access', now)
    expect((await f.status()).connected).toBe(false)
    f.token('refresh')
    expect((await f.status()).connected).toBe(true)
    f.sql.run("UPDATE agent_oauth_tokens SET consumed_at=? WHERE kind='refresh'", now - 1)
    expect((await f.status()).connected).toBe(false)
  })

  it('does not report expired, revoked, or inactive connections', async () => {
    const f = fixture()
    f.family()
    f.token('refresh', now)
    expect((await f.status()).connected).toBe(false)
    f.sql.run('UPDATE agent_oauth_tokens SET expires_at=?', now + 60)
    expect((await f.status()).connected).toBe(true)
    f.sql.run('UPDATE agent_oauth_families SET revoked_at=?', now)
    expect((await f.status()).connected).toBe(false)
    f.sql.run('UPDATE agent_oauth_families SET revoked_at=NULL')
    f.sql.run("UPDATE agents SET state='revoked' WHERE id='agent'")
    expect((await f.status()).connected).toBe(false)
  })

  it('reports a live grant past its expiry as expired, and leaves the others as stored (dev gap 25)', async () => {
    const f = fixture()
    // The agent's own grants are listed by its wallet; the operator's (with templates) are not involved.
    const wallet = '0x2222222222222222222222222222222222222222'
    f.lifecycle.agents.bindWallet('agent', 'wallet', wallet)
    const grant = (hash: string, kind: string, status: string, expiresAt: number) =>
      f.sql.run(
        `INSERT INTO grants (delegation_hash,kind,delegator,delegate,owner,delegation_json,signature,status,expires_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        hash,
        kind,
        wallet,
        operator.toLowerCase(),
        wallet,
        '{}',
        null,
        status,
        expiresAt,
      )
    grant('0x01', 'agent-work', 'live', now - 1)
    grant('0x02', 'agent-approve', 'live', now + 3600)
    grant('0x03', 'agent-sweep', 'revoked', now - 1)
    const grants = (await f.status()).grants
    expect(Object.fromEntries(grants.map((g) => [g.kind, g.status]))).toEqual({
      'agent-work': 'expired',
      'agent-approve': 'live',
      'agent-sweep': 'revoked',
    })
  })
})
