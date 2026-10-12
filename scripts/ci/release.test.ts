import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assembleEnv,
  assertNoop,
  assertPlanSafe,
  assertSnapshotSafe,
  censusOf,
  checkStateStore,
  expectedStateStoreVersion,
  validateEnv,
  validateFirstDeployCensus,
  type Census,
  type PlanCounts,
  type StageFile,
} from './release.ts'

const infra: StageFile = {
  stage: 'dev',
  network: 'monad-testnet',
  chainId: 10143,
  origin: 'https://dev.sidequest.exchange',
  relay: '0x0000000000000000000000000000000000000001',
  resources: { Api: 'api', Indexer: 'indexer', Explore: 'explore', Database: 'db', Manifests: 'manifests' },
  cloudflare: { accountId: 'account', zoneId: 'zone', zoneName: 'sidequest.exchange' },
}
const clean: PlanCounts = { create: 0, update: 0, adopted: 0, replace: 0, delete: 0, orphaned: 0, noop: 5 }

test('assembles fixed release settings and maps GitHub app names', () => {
  const result = assembleEnv(
    'dev',
    infra,
    { CI: '1', SQ_GITHUB_APP_ID: 'id', SQ_GITHUB_APP_INSTALLATION_ID: 'install', SQ_GITHUB_APP_PRIVATE_KEY: 'pem' },
    {},
  )
  expect(result).toMatchObject({
    SIDEQUEST_RELEASE: '1',
    SIDEQUEST_STAGE: 'dev',
    SIDEQUEST_NETWORK: 'monad-testnet',
    ALCHEMY_REMOTE_STATE: '1',
    SIDEQUEST_APPLY_MIGRATIONS: '1',
    CLOUDFLARE_ACCOUNT_ID: 'account',
    GITHUB_APP_ID: 'id',
    GITHUB_APP_INSTALLATION_ID: 'install',
    GITHUB_APP_PRIVATE_KEY: 'pem',
  })
  expect(() => assembleEnv('dev', infra, { DISTILLED_DEBUG_FOO: '1' })).toThrow('DISTILLED_DEBUG')
})

test('local settings do not inherit the box signing/RPC credentials or stale stage controls', () => {
  const result = assembleEnv(
    'dev',
    infra,
    {
      PATH: '/bin',
      RELAY_PRIVATE_KEY: 'box-key',
      MONAD_RPC_URL: 'box-rpc',
      SIDEQUEST_NETWORK: 'wrong',
      ALCHEMY_STATE_MODE: 'local',
    },
    { RELAY_PRIVATE_KEY: 'stage-key', GITHUB_APP_ID: 'plain-id' },
  )
  expect(result.RELAY_PRIVATE_KEY).toBe('stage-key')
  expect(result.GITHUB_APP_ID).toBe('plain-id')
  expect(result.MONAD_RPC_URL).toBeUndefined()
  expect(result.ALCHEMY_STATE_MODE).toBeUndefined()
  expect(result.SIDEQUEST_NETWORK).toBe(infra.network)
  expect(result.PATH).toBe('/bin')
  expect(() => assembleEnv('dev', infra, {}, { DISTILLED_DEBUG: '0' })).toThrow('DISTILLED_DEBUG')
  expect(() => assembleEnv('dev', infra, { CI: 'true', CLOUDFLARE_ACCOUNT_ID: 'foreign' })).toThrow('does not match')
})

test("a deploy's launch inputs come from its command line or CI, never two different values", () => {
  const prod: StageFile = { ...infra, stage: 'prod', origin: 'https://sidequest.exchange' }
  const artifact = 'docs/p0-prod-artifact.json'
  // The runbook names them on the command line of a local deploy.
  expect(
    assembleEnv(
      'prod',
      prod,
      { SIDEQUEST_PROD_ARTIFACT: artifact, PROD_ADMISSION_DRAIN: '0' },
      { RELAY_PRIVATE_KEY: 'k' },
    ),
  ).toMatchObject({ SIDEQUEST_PROD_ARTIFACT: artifact, PROD_ADMISSION_DRAIN: '0' })
  // The stage env alone still works, and an agreeing command line is fine.
  expect(assembleEnv('prod', prod, { PROD_ADMISSION_DRAIN: '1' }, { PROD_ADMISSION_DRAIN: '1' })).toMatchObject({
    PROD_ADMISSION_DRAIN: '1',
  })
  expect(() => assembleEnv('prod', prod, { PROD_ADMISSION_DRAIN: '0' }, { PROD_ADMISSION_DRAIN: '1' })).toThrow(
    'PROD_ADMISSION_DRAIN differs between the command line and prod.env',
  )
  // CI passes an unset GitHub variable as empty: it stays unset, so the indexer keeps its HyperSync default.
  const ci = assembleEnv('prod', prod, {
    CI: 'true',
    SIDEQUEST_PROD_ARTIFACT: artifact,
    HYPERSYNC_URL: '',
    PROD_ADMISSION_DRAIN: '0',
  })
  expect(ci).toMatchObject({ SIDEQUEST_PROD_ARTIFACT: artifact, PROD_ADMISSION_DRAIN: '0' })
  expect('HYPERSYNC_URL' in ci).toBe(false)
  // Other SIDEQUEST_ settings still never come from the environment.
  expect(assembleEnv('prod', prod, { CI: 'true', SIDEQUEST_NETWORK: 'monad-mainnet' }).SIDEQUEST_NETWORK).toBe(
    'monad-testnet',
  )
})

test('refuses unset required values by name', () => {
  expect(() => validateEnv({ RELAY_PRIVATE_KEY: 'unset' }, ['RELAY_PRIVATE_KEY'])).toThrow('RELAY_PRIVATE_KEY')
})

test('plan refusal rules cover destructive and adoption actions', () => {
  expect(() => assertPlanSafe({ ...clean, replace: 1 }, false, false)).toThrow('replace=1')
  expect(() => assertPlanSafe({ ...clean, adopted: 1 }, false, false)).toThrow('--adopt-move')
  expect(() => assertPlanSafe({ ...clean, create: 1 }, false, false)).toThrow('outside a first deploy')
  expect(() => assertPlanSafe({ ...clean, create: 1 }, true, false)).not.toThrow()
  for (const action of ['delete', 'orphaned'] as const)
    expect(() => assertPlanSafe({ ...clean, [action]: 1 }, true, true)).toThrow('plan refused')
  expect(() => assertPlanSafe({ ...clean, adopted: 1 }, false, true)).not.toThrow()
  expect(() => assertPlanSafe({ ...clean, update: 1 }, false, false)).not.toThrow()
  expect(() => assertPlanSafe({ ...clean, update: -1 }, true, true)).toThrow('invalid plan')
})

test('binding deletions and deleted stack actions are refused even when resource counts are safe', () => {
  const resource = { fqn: 'Api', action: 'noop', bindings: [{ action: 'delete' }] }
  expect(() => assertSnapshotSafe({ summary: clean, resources: [resource], actions: [] }, false, false)).toThrow(
    'binding deletion',
  )
  expect(() =>
    assertSnapshotSafe({ summary: clean, resources: [], actions: [{ action: 'delete' }] }, false, false),
  ).toThrow('action deletion')
})

test('post-deploy verification requires no-op resources, bindings and stack actions', () => {
  const snapshot = {
    summary: clean,
    resources: [{ fqn: 'Api', action: 'noop', bindings: [{ action: 'noop' }] }],
    actions: [{ action: 'noop' }],
  }
  expect(() => assertNoop(snapshot)).not.toThrow()
  expect(() => assertNoop({ ...snapshot, summary: { ...clean, update: 1 } })).toThrow('not a no-op')
  expect(() =>
    assertNoop({ ...snapshot, resources: [{ ...snapshot.resources[0]!, bindings: [{ action: 'create' }] }] }),
  ).toThrow('not a no-op')
  expect(() => assertNoop({ ...snapshot, actions: [{ action: 'run' }] })).toThrow('not a no-op')
})

test('first deploy census refuses fixed-name collisions and foreign zones', () => {
  const fresh = {
    zone: { id: 'zone', account: { id: 'account' }, name: 'sidequest.exchange', status: 'active' },
    workers: [],
    databases: [],
    buckets: [],
    domains: [],
  }
  expect(() => validateFirstDeployCensus(infra, fresh)).not.toThrow()
  expect(() => validateFirstDeployCensus(infra, { ...fresh, workers: [{ id: 'api' }] })).toThrow('fixed Cloudflare')
  expect(() =>
    validateFirstDeployCensus(infra, { ...fresh, zone: { ...fresh.zone, account: { id: 'other' } } }),
  ).toThrow('zone ownership')
  const collisions: Census[] = [
    { ...fresh, databases: [{ name: 'db' }] },
    { ...fresh, buckets: [{ name: 'manifests' }] },
    { ...fresh, domains: [{ hostname: 'dev.sidequest.exchange' }] },
  ]
  for (const census of collisions)
    expect(() => validateFirstDeployCensus(infra, census)).toThrow('local-state migration')
})

test('census follows D1/domain count pagination and R2 cursors, refusing incomplete totals', async () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const transport = (incomplete: boolean): typeof fetch =>
    (async (input) => {
      const url = new URL(String(input))
      if (url.pathname.includes('/zones/')) return Response.json({ success: true, result: { id: 'zone' } })
      if (url.pathname.endsWith('/workers/scripts')) return Response.json({ success: true, result: [] })
      if (url.pathname.endsWith('/r2/buckets')) {
        const second = url.searchParams.has('cursor')
        return Response.json({
          success: true,
          result: { buckets: [{ name: second ? 'second' : 'first' }] },
          result_info: second ? {} : { cursor: 'next' },
        })
      }
      const page = Number(url.searchParams.get('page'))
      const result = Array.from({ length: page === 1 ? 100 : incomplete ? 0 : 1 }, (_, i) => ({ id: i }))
      return Response.json({
        success: true,
        result,
        result_info: { page, per_page: 100, total_count: 101, count: result.length },
      })
    }) as typeof fetch
  const census = await censusOf(infra, 'test-token', transport(false))
  expect(census.databases.length).toBe(101)
  expect(census.domains.length).toBe(101)
  expect(census.buckets.map((row) => row.name)).toEqual(['first', 'second'])
  await expect(censusOf(infra, 'test-token', transport(true))).rejects.toThrow('pagination incomplete')
})

test('state-store guard rejects mismatched versions before authenticated state inventory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sidequest-ci-'))
  const file = join(directory, 'credential.json')
  writeFileSync(file, JSON.stringify({ url: 'https://state.example', authToken: 'test-token', accountId: 'account' }), {
    mode: 0o600,
  })
  let requests = 0
  const transport = (async () => {
    requests++
    return Response.json({ version: expectedStateStoreVersion() - 1 })
  }) as typeof fetch
  try {
    await expect(checkStateStore('account', file, transport)).rejects.toThrow('version mismatch')
    expect(requests).toBe(1)
    await expect(checkStateStore('foreign', file, transport)).rejects.toThrow('account mismatch')
    expect(requests).toBe(1)
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('remote absence needs successful valid inventory, never a failed read', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sidequest-ci-'))
  const file = join(directory, 'credential.json')
  writeFileSync(file, JSON.stringify({ url: 'https://state.example', authToken: 'test-token', accountId: 'account' }), {
    mode: 0o600,
  })
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const transport = (stacks: unknown): typeof fetch =>
    (async (input) => {
      const path = new URL(String(input)).pathname
      return Response.json(path === '/version' ? { version: expectedStateStoreVersion() } : stacks)
    }) as typeof fetch
  try {
    expect(await (await checkStateStore('account', file, transport([]))).stackExists('dev')).toBe(false)
    await expect((await checkStateStore('account', file, transport({}))).stackExists('dev')).rejects.toThrow(
      'invalid remote stack',
    )
    const readFailure = (async (input) =>
      new URL(String(input)).pathname === '/version'
        ? Response.json({ version: expectedStateStoreVersion() })
        : new Response('unavailable', { status: 503 })) as typeof fetch
    await expect((await checkStateStore('account', file, readFailure)).stackExists('dev')).rejects.toThrow('HTTP 503')
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('a deferred-adoption create counts as an adoption only during the dev state move', () => {
  const summary: PlanCounts = { create: 2, update: 0, adopted: 3, replace: 0, delete: 0, orphaned: 0, noop: 0 }
  const resources = [
    { fqn: 'Database', action: 'adopted', bindings: [] },
    { fqn: 'Api', action: 'create', bindings: [] },
    { fqn: 'Explore', action: 'create', bindings: [] },
  ]
  const snapshot = { summary, resources, actions: [], deferredAdoption: ['Api', 'Explore'] }
  expect(() => assertSnapshotSafe(snapshot, false, true)).not.toThrow()
  expect(() => assertSnapshotSafe(snapshot, false, false)).toThrow('--adopt-move')
  expect(() => assertSnapshotSafe({ ...snapshot, deferredAdoption: ['Api'] }, false, true)).toThrow('create=1')
})
