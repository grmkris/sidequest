import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { Schema } from 'effect'
import * as sdk from '@sidequest/sdk'
import { fromNodeSqlite, migrate as migrateIndex } from '@sidequest/indexer'
import { migrateRegistry } from '../src/registry.ts'
import { migrateDirectory } from '../src/directory.ts'
import { commonsHostFactory, type CommonsState } from '../src/commons/host.ts'
import type { BoardCall } from '../src/board.ts'
import { commonsRpcs } from '../src/commons/rpc.ts'
import { Effect } from 'effect'
import { COMMONS_OBJECT_NAME } from '@sidequest/commons'
import { stageProfile } from '../../../infra/stage.ts'

const maintainer = '0x5f3d114a607b5bbb71a2e11ba045fc9f4f239ce7'
const peer = '0x1111111111111111111111111111111111111111'
// The dev stage's moderators get a metadata row for every post, besides the people a post mentions.
const moderators = (stageProfile('dev')?.roles?.moderator ?? []).map((address) => address.toLowerCase())
const sorted = (list: readonly string[]) => list.toSorted((a, b) => a.localeCompare(b))
const env: BoardCall['env'] = {
  network: 'monad-testnet',
  boardId: 'public',
  rpcUrl: 'http://127.0.0.1:1',
  domain: 'test.invalid',
  uri: 'https://test.invalid',
  manifestBaseUrl: 'https://test.invalid/offers',
  screening: { baseUrl: '', apiKey: '', model: '' },
  attesterKey: '',
  relayKey: '',
  github: { appId: '', privateKeyPem: '', installationId: '' },
}
const handles: DatabaseSync[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of handles.splice(0)) db.close()
})

class Bound {
  constructor(
    readonly db: DatabaseSync,
    readonly query: string,
    readonly values: readonly (string | number | null)[],
  ) {}
  async all<T>(_decode?: (row: T) => T): Promise<{ results: T[] }> {
    // SAFETY: selected SQLite columns match the requesting adapter's generic query contract.
    return { results: this.db.prepare(this.query).all(...this.values) as T[] }
  }
  run() {
    this.db.prepare(this.query).run(...this.values)
  }
}
class D1 {
  constructor(readonly db: DatabaseSync) {}
  prepare(query: string) {
    return {
      bind: (...raw: unknown[]) =>
        new Bound(
          this.db,
          query,
          Schema.decodeUnknownSync(Schema.Array(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))))(raw),
        ),
    }
  }
  async batch(statements: unknown[]) {
    this.db.exec('BEGIN')
    try {
      for (const statement of statements) {
        if (!(statement instanceof Bound)) throw new Error('Unexpected D1 statement')
        statement.run()
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

async function fixture(stage = 'dev') {
  const db = new DatabaseSync(':memory:')
  handles.push(db)
  const index = new DatabaseSync(':memory:')
  handles.push(index)
  const d1 = fromNodeSqlite(index)
  await migrateIndex(d1)
  await migrateRegistry(d1)
  await migrateDirectory(d1)
  const state: CommonsState & { id: { toString(): string } } = {
    id: { toString: () => COMMONS_OBJECT_NAME },
    storage: {
      sql: {
        raw: {
          exec: (query, ...raw) => ({
            toArray: () =>
              db
                .prepare(query)
                .all(
                  ...Schema.decodeUnknownSync(
                    Schema.Array(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
                  )(raw),
                ),
          }),
        },
      },
    },
    raw: {
      storage: {
        transactionSync: <A>(f: () => A): A => {
          db.exec('SAVEPOINT host_write')
          try {
            const result = f()
            db.exec('RELEASE host_write')
            return result
          } catch (error) {
            db.exec('ROLLBACK TO host_write')
            db.exec('RELEASE host_write')
            throw error
          }
        },
      },
    },
  }
  const base = sdk.context(env.network, 'main', env.rpcUrl)
  const multicall = vi.fn(async (input: { contracts: readonly object[] }) => input.contracts.map(() => 0n))
  // SAFETY: the host unit double supplies stake reads; the empty checkpoint intentionally refuses backing reads.
  vi.spyOn(sdk, 'context').mockReturnValue({
    ...base,
    publicClient: { ...base.publicClient, getBlockNumber: async () => 42n, multicall },
  } as sdk.Ctx)
  const namespace = {
    idFromName: (name: string) => ({ toString: () => name }),
    getByName: () => ({
      managedProfiles: async () => '[]',
      jobParticipants: async () => 'null',
      commonsThread: async () => '[]',
    }),
  }
  const bindings = { Database: new D1(index), Board: namespace, DEPLOY_STAGE: stage, NETWORK: env.network }
  const factory = commonsHostFactory({ state, bindings })
  return { host: factory(env), factory, state, bindings, db, index, multicall }
}

it('runs the real post program, persists metadata-only feed rows and reuses the env host', async () => {
  const f = await fixture()
  expect(f.factory(env)).toBe(f.host)
  const result = await f.host.run('post_message', { address: maintainer }, { subject: 'lobby', body: `hello @${peer}` })
  expect(result).toMatchObject({ message: { id: 1, body: `hello @${peer}` }, notified: 1 + moderators.length })
  const rows = f.index.prepare('SELECT address, data_json, occurred_at FROM feed_events').all()
  // Unix seconds, as every other feed row: inbox reads without a cursor look back seven days by occurred_at.
  for (const row of rows) expect(Math.abs(Number(row.occurred_at) - Date.now() / 1000)).toBeLessThan(3600)
  expect(sorted(rows.map((row) => String(row.address)))).toEqual(sorted([peer, ...moderators]))
  expect(JSON.stringify(rows)).not.toContain('hello')
  expect(JSON.stringify(rows)).not.toContain('body')
  expect(await f.host.run('list_messages', {}, { subject: 'lobby', limit: '1' })).toMatchObject({
    messages: [{ id: 1 }],
  })
})

it('preserves BoardError codes for invalid input, authentication and absent jobs', async () => {
  const f = await fixture()
  await expect(f.host.run('post_message', {}, { subject: 'lobby', body: 'hello' })).rejects.toMatchObject({
    code: 'unauthenticated',
  })
  await expect(
    f.host.run('post_message', { address: maintainer }, { subject: 'lobby', body: '' }),
  ).rejects.toMatchObject({ code: 'invalid' })
  await expect(f.host.run('list_messages', {}, { subject: 'job:public:absent' })).rejects.toMatchObject({
    code: 'not-found',
  })
})

it('persists a canonical plan through the real host and rejects invalid presentations at admission', async () => {
  const f = await fixture()
  const presentation = {
    protocol: 'openui',
    version: 1,
    source: 'root = Plan("Review", "Review this plan.", [AskQuestion("Ready?", ["Yes", "Revise"])])',
  }
  await expect(
    f.host.run(
      'post_message',
      { address: maintainer },
      {
        subject: 'lobby',
        body: 'Summary',
        presentation: { ...presentation, source: 'root = Unknown("oops")' },
      },
    ),
  ).rejects.toMatchObject({ code: 'invalid' })
  expect(f.db.prepare('SELECT * FROM commons_messages').all()).toHaveLength(0)
  const posted = await f.host.run(
    'post_message',
    { address: maintainer },
    { subject: 'lobby', body: 'Summary', presentation },
  )
  expect(posted).toMatchObject({ message: { presentation: { protocol: 'sidequest.commons-ui', version: 1 } } })
  expect(await f.host.run('list_messages', {}, { subject: 'lobby' })).toMatchObject({
    messages: [{ body: 'Summary', presentation: { protocol: 'sidequest.commons-ui', version: 1 } }],
  })
})

it('reads numeric and string gap IDs and reports safe field constraints through the real host', async () => {
  const f = await fixture()
  const report = await f.host.run(
    'report_gap',
    { address: maintainer },
    {
      gap_type: 'missing_tool',
      what_i_needed: 'Read one report',
      what_i_tried: 'Used list_gaps',
    },
  )
  expect(await f.host.run('list_gaps', {}, { gapId: report.gapId })).toEqual(
    await f.host.run('list_gaps', {}, { gapId: String(report.gapId) }),
  )
  await expect(f.host.run('list_gaps', {}, { limit: 101 })).rejects.toMatchObject({
    code: 'invalid',
    message: expect.stringMatching(/limit/),
  })
  const secret = 'SECRET_FIXTURE_VALUE'.repeat(100)
  let message = ''
  try {
    await f.host.run(
      'report_gap',
      { address: maintainer },
      {
        gap_type: 'error',
        what_i_needed: secret,
        what_i_tried: 'Workaround',
        user_goal: secret,
      },
    )
  } catch (error) {
    if (error instanceof Error) message = error.message
  }
  expect(message).toMatch(/what_i_needed/)
  expect(message).toMatch(/1000/)
  expect(message).not.toContain('SECRET_FIXTURE_VALUE')
})

it('disables every tool without stage roles, exposing only disabled list_roles', async () => {
  // A stage with no profile has no roles; dev and prod both run Commons.
  const f = await fixture('local')
  await expect(
    f.host.run('post_message', { address: maintainer }, { subject: 'lobby', body: 'hello' }),
  ).rejects.toMatchObject({ code: 'unavailable' })
  expect(await f.host.run('list_roles', {}, {})).toMatchObject({ enabled: false })
  expect(f.host.thread('job:public:task')).toEqual([])
  expect(f.multicall).not.toHaveBeenCalled()
})

it('reads thread context synchronously and enforces reserved-object RPC identity', async () => {
  const f = await fixture()
  f.db
    .prepare(`INSERT INTO commons_messages (subject,subject_kind,author,badges_json,body,mentions_json,created_at)
    VALUES ('job:public:task','job',?,'[]','context','[]',1000)`)
    .run(peer)
  expect(f.host.thread('job:public:task')).toEqual([
    { id: 1, author: peer, roles: [], text: 'context', hidden: false, replyTo: null, at: 1000 },
  ])
  const rpcs = commonsRpcs({ state: f.state, bindings: f.bindings, host: f.factory })
  expect(JSON.parse(await Effect.runPromise(rpcs.commonsThread({ subject: 'job:public:task' })))).toHaveLength(1)
  const wrong = commonsRpcs({
    state: { ...f.state, id: { toString: () => 'public' } },
    bindings: f.bindings,
    host: f.factory,
  })
  expect(() => Effect.runSync(wrong.commonsThread({ subject: 'job:public:task' }))).toThrow(
    'Commons object identity mismatch',
  )
})
