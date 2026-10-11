import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import type { AsyncSql } from '@sidequest/indexer'
import { deployment, type DirectoryAgent } from '@sidequest/sdk'
import { zeroAddress } from 'viem'
import { fromNodeSqlite } from '@sidequest/board'
import { DirectoryProjectionJournal } from '../src/directory-projection.ts'
import { directoryPage, migrateDirectory, projectDirectory, runDirectoryTool } from '../src/directory.ts'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function fixture() {
  const database = new DatabaseSync(':memory:')
  databases.push(database)
  const sql: AsyncSql = {
    all: async <Result>(query: string, ...params: Array<string | number | null>) =>
      database.prepare(query).all(...params) as Result[],
    batch: async (statements) => {
      database.exec('BEGIN')
      try {
        for (const statement of statements) database.prepare(statement.query).run(...statement.params)
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
  }
  const config = deployment('monad-testnet')
  const agent = (id: string, revision = 1): DirectoryAgent => ({
    chainId: config.chainId,
    identityRegistry: config.identity,
    agentId: id,
    wallet: zeroAddress,
    profile: { name: `Worker ${id}`, description: '', services: [] },
    profileSource: 'operator-supplied',
    agentURI: '',
    enrolled: true,
    ownership: 'verified',
    presence: { freshness: 'unknown', state: null, accepting: false, lastSeenBucket: null },
    ads: [],
    observedAt: 100,
    projectionAt: 100,
    revision,
  })
  return { sql, agent, database }
}

it('paginates every enrollment beyond the old history limit, ordered by uint256 IDs', async () => {
  const context = fixture()
  await migrateDirectory(context.sql)
  for (let index = 1; index <= 205; index++)
    await projectDirectory(context.sql, context.agent(String(index)), 'https://testnet.example')
  let after: string | undefined
  const ids: string[] = []
  do {
    const page = await directoryPage(context.sql, {
      network: 'monad-testnet',
      audience: 'https://testnet.example',
      limit: 50,
      ...(after === undefined ? {} : { after }),
    })
    ids.push(...page.agents.map((agent) => agent.agentId))
    after = page.nextCursor ?? undefined
  } while (after !== undefined)
  expect(ids).toHaveLength(205)
  expect(ids[0]).toBe('1')
  expect(ids.at(-1)).toBe('205')
  expect(new Set(ids).size).toBe(205)
})

it('does not let an older projection overwrite a newer revocation', async () => {
  const context = fixture()
  await migrateDirectory(context.sql)
  await projectDirectory(context.sql, { ...context.agent('7', 3), enrolled: false }, 'https://testnet.example')
  await projectDirectory(context.sql, context.agent('7', 2), 'https://testnet.example')
  expect(
    (await directoryPage(context.sql, { network: 'monad-testnet', audience: 'https://testnet.example' })).agents,
  ).toHaveLength(0)
})

it('keeps directory discovery independent of an absent job index and fail-closes enrollment on DO outage', async () => {
  const context = fixture()
  await migrateDirectory(context.sql)
  await projectDirectory(context.sql, context.agent('99'), 'https://testnet.example')
  const result = (await runDirectoryTool(
    {
      sql: context.sql,
      network: 'monad-testnet',
      rpcUrl: '',
      audience: 'https://testnet.example',
      call: async () => {
        throw new Error('directory owner unavailable')
      },
    },
    'list_directory',
    {},
  )) as { agents: DirectoryAgent[] }
  expect(result.agents).toEqual([])
})

it('durably retries failed enrollment and opt-out projections after owner recreation', async () => {
  const context = fixture()
  const journal = new DirectoryProjectionJournal(fromNodeSqlite(context.database))
  const scope = { network: 'monad-testnet' as const, audience: 'https://testnet.example', agentId: '99' }
  journal.prepare(scope)
  const unavailable: AsyncSql = {
    all: context.sql.all,
    batch: async () => {
      throw new Error('D1 unavailable')
    },
  }
  await expect(journal.flush(unavailable, context.agent('99'))).rejects.toThrow(/D1 unavailable/)
  await new DirectoryProjectionJournal(fromNodeSqlite(context.database)).flush(context.sql, context.agent('99'))
  expect((await directoryPage(context.sql, scope)).agents).toHaveLength(1)
  const optedOut = { ...context.agent('99', 2), enrolled: false }
  await expect(journal.flush(unavailable, optedOut)).rejects.toThrow(/D1 unavailable/)
  const result = (await runDirectoryTool(
    {
      sql: context.sql,
      ...scope,
      rpcUrl: '',
      call: async () => {
        throw new Error('DO unavailable')
      },
    },
    'list_directory',
    {},
  )) as { agents: DirectoryAgent[] }
  expect(result.agents).toEqual([])
  await new DirectoryProjectionJournal(fromNodeSqlite(context.database)).flush(context.sql, optedOut)
  expect((await directoryPage(context.sql, scope)).agents).toHaveLength(0)
  expect(() => journal.prepare({ ...scope, audience: 'https://evil.example' })).toThrow(/scope cannot change/)
})

it.each([
  ['prepare_directory_enrollment', { agentId: '1', payload: {} }],
  ['enroll_directory', { record: { kind: 'Enrollment', agentId: '1' }, signature: '0x' }],
  ['prepare_service_ad', { agentId: '1', payload: {} }],
  ['publish_service_ad', { record: { kind: 'ServiceAd', agentId: '1' }, signature: '0x' }],
  ['prepare_heartbeat', { agentId: '1', payload: {} }],
  ['post_heartbeat', { record: { kind: 'Heartbeat', agentId: '1' }, signature: '0x' }],
  ['prepare_revoke_service_ad', { agentId: '1', payload: {} }],
  ['revoke_service_ad', { record: { kind: 'RevokeAd', agentId: '1' }, signature: '0x' }],
] as const)('dispatches %s on mainnet through directory RPC for object admission', async (name, args) => {
  const context = fixture()
  let called = false
  const result = await runDirectoryTool(
    {
      sql: context.sql,
      network: 'monad-mainnet',
      audience: 'https://sidequest.exchange',
      rpcUrl: '',
      call: async () => {
        called = true
        return {
          ok: true,
          result: name.startsWith('prepare_') ? {} : { agent: context.agent('1'), projection: null, idempotent: false },
        }
      },
    },
    name,
    args,
  )
  if (name.startsWith('prepare_')) expect(result).toEqual({})
  else expect(result).toMatchObject({ scope: 'directory only; no job or money authority' })
  expect(called).toBe(true)
})

it('binds discovery to the complete deployment and audience and bounds pagination inputs', async () => {
  const context = fixture()
  await migrateDirectory(context.sql)
  await projectDirectory(context.sql, context.agent('99'), 'https://testnet.example')
  expect(
    (await directoryPage(context.sql, { network: 'monad-testnet', audience: 'https://other.example' })).agents,
  ).toEqual([])
  await expect(
    directoryPage(context.sql, { network: 'monad-testnet', audience: 'https://testnet.example', limit: 101 }),
  ).rejects.toThrow(/limit/)
  await expect(
    directoryPage(context.sql, { network: 'monad-testnet', audience: 'https://testnet.example', after: '01' }),
  ).rejects.toThrow(/agentId/)
})

it('preserves rate-limit retry metadata from the directory owner for REST and MCP', async () => {
  const { sql } = fixture()
  await expect(
    runDirectoryTool(
      {
        sql,
        network: 'monad-mainnet',
        audience: 'https://sidequest.exchange',
        rpcUrl: '',
        call: async () => ({ ok: false, code: 'rate-limited', message: 'wallet write limit reached', retryAfter: 42 }),
      },
      'prepare_directory_enrollment',
      { agentId: '1', payload: {} },
    ),
  ).rejects.toMatchObject({ code: 'rate-limited', retryAfter: 42 })
})

it('shows a hosted agent active via MCP to five minutes, only while its hosted wallet is still the agent wallet', async () => {
  const context = fixture()
  await migrateDirectory(context.sql)
  const hosted = '0x1111111111111111111111111111111111111111'
  for (const id of ['1', '2', '3'])
    await projectDirectory(context.sql, { ...context.agent(id), wallet: hosted }, 'https://testnet.example')
  const asked: string[][] = []
  const deps = {
    sql: context.sql,
    network: 'monad-testnet' as const,
    rpcUrl: '',
    audience: 'https://testnet.example',
    call: async (id: string) => ({ ok: true as const, result: { ...context.agent(id), wallet: hosted } }),
    activity: async (ids: string[]) => {
      asked.push(ids)
      // Agent 2's hosted wallet was replaced on chain; agent 3 is self-run.
      return [
        { agent_id: '1', address: hosted.toUpperCase().replace('0X', '0x'), last_activity_at: 1_800_000_599 },
        { agent_id: '2', address: '0x2222222222222222222222222222222222222222', last_activity_at: 1_800_000_000 },
      ]
    },
  }
  const list = (await runDirectoryTool(deps, 'list_directory', {})) as { agents: DirectoryAgent[] }
  expect(asked).toEqual([['1', '2', '3']])
  expect(list.agents.map((agent) => agent.activity)).toEqual([{ lastMcpCallAt: 1_800_000_300 }, undefined, undefined])
  expect(await runDirectoryTool(deps, 'get_directory_agent', { agentId: '1' })).toMatchObject({
    agent: { activity: { lastMcpCallAt: 1_800_000_300 } },
  })
  // A management object that cannot answer adds nothing and fails nothing.
  const quiet = (await runDirectoryTool(
    {
      ...deps,
      activity: async () => {
        throw new Error('management object unavailable')
      },
    },
    'list_directory',
    {},
  )) as { agents: DirectoryAgent[] }
  expect(quiet.agents.every((agent) => agent.activity === undefined)).toBe(true)
})
