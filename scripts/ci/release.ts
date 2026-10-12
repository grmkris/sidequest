import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, http } from 'viem'

export type Stage = 'dev' | 'prod'
export type Action = 'plan' | 'deploy' | 'drift'

export interface StageFile {
  readonly stage: Stage
  readonly network: string
  readonly chainId: number
  readonly origin: string
  readonly relay: string
  readonly resources: Record<string, string>
  readonly cloudflare: { readonly accountId: string; readonly zoneId: string; readonly zoneName: string }
}

export interface Census {
  readonly zone: {
    readonly id: string
    readonly account?: { readonly id?: string }
    readonly name?: string
    readonly status?: string
  }
  readonly workers: readonly { readonly id?: string; readonly tags?: readonly string[] }[]
  readonly databases: readonly { readonly name?: string; readonly uuid?: string }[]
  readonly buckets: readonly { readonly name?: string }[]
  readonly domains: readonly { readonly hostname?: string; readonly service?: string; readonly zone_id?: string }[]
}

export interface PlanCounts {
  readonly create: number
  readonly update: number
  readonly adopted: number
  readonly replace: number
  readonly delete: number
  readonly orphaned: number
  readonly noop: number
}

const ROOT = resolve(import.meta.dirname, '../..')
const REQUIRED_SECRETS = [
  'RELAY_PRIVATE_KEY',
  'ATTESTER_PRIVATE_KEY',
  'PRIVY_APP_SECRET',
  'PRIVY_SIGNER_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'AI_GATEWAY_API_KEY',
  'HYPERSYNC_API_TOKEN',
  'MONAD_RPC_URL',
  'GITHUB_APP_PRIVATE_KEY',
  'CLOUDFLARE_API_TOKEN',
] as const
/** What one deploy is for, named on its command line (the runbook's `SIDEQUEST_PROD_ARTIFACT=… PROD_ADMISSION_DRAIN=…`)
 *  or in the CI environment; the stage env may hold them too, but never a different value. Empty is unset, as GitHub
 *  passes an unset variable. */
const LAUNCH_INPUTS: readonly string[] = ['SIDEQUEST_PROD_ARTIFACT', 'PROD_ADMISSION_DRAIN', 'HYPERSYNC_URL']
const STATE_CREDENTIAL = resolve(homedir(), '.alchemy/credentials/default/cloudflare-state-store.json')
// Api is not a public deep export: derive its installed sibling from the StateStore entrypoint.
// Do not use the generic HttpStateApi version: State.ts compares the Worker version in Api.
export const expectedStateStoreVersion = (): number => {
  const entrypoint = fileURLToPath(import.meta.resolve('alchemy/Cloudflare/StateStore'))
  const source = readFileSync(resolve(dirname(entrypoint), entrypoint.endsWith('.ts') ? 'Api.ts' : 'Api.js'), 'utf8')
  const version = /export const STATE_STORE_VERSION = (\d+)/.exec(source)?.[1]
  if (version === undefined) return fail('installed Alchemy state-store version unavailable')
  return Number(version)
}

export class ReleaseRefusal extends Error {}
function fail(message: string): never {
  throw new ReleaseRefusal(message)
}
const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8')) as unknown
const stageFile = (stage: Stage): StageFile => {
  const raw = json(resolve(ROOT, `infra/${stage}.json`))
  if (raw === null || typeof raw !== 'object') fail(`invalid infra/${stage}.json`)
  const value = raw as Partial<StageFile>
  if (
    value.stage !== stage ||
    typeof value.network !== 'string' ||
    typeof value.chainId !== 'number' ||
    typeof value.origin !== 'string' ||
    typeof value.relay !== 'string' ||
    value.resources === undefined ||
    value.cloudflare?.accountId === undefined ||
    value.cloudflare.zoneId === undefined ||
    value.cloudflare.zoneName === undefined
  )
    fail(`invalid infra/${stage}.json`)
  if (
    !['monad-testnet', 'monad-mainnet'].includes(value.network) ||
    !Number.isSafeInteger(value.chainId) ||
    value.chainId <= 0
  )
    fail(`invalid network in infra/${stage}.json`)
  if (new URL(value.origin).origin !== value.origin || !value.origin.startsWith('https://'))
    fail(`invalid origin in infra/${stage}.json`)
  for (const id of ['Api', 'Indexer', 'Explore', 'Database', 'Manifests'])
    if (!value.resources[id]) fail(`infra/${stage}.json missing resource ${id}`)
  return value as StageFile
}

/** Parse the stage env without ever printing a value. */
export const readStageEnv = (stage: Stage, env = process.env): Record<string, string> => {
  if (env.CI === 'true' || env.CI === '1') return {}
  const path = resolve(homedir(), `.config/sidequest/${stage}.env`)
  if (!existsSync(path)) fail(`stage env missing: ${stage}.env`)
  if ((statSync(path).mode & 0o077) !== 0) fail(`stage env must be mode 600: ${stage}.env`)
  const values = parseEnv(readFileSync(path, 'utf8'))
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

const launchInput = (key: string): boolean => LAUNCH_INPUTS.includes(key)

/** Whether a variable of the invoking environment reaches the deploy: never stage controls or Alchemy settings, and in a
 *  local run never the box's own credentials and settings, which come from the stage env instead. */
const inherited = (key: string, localRun: boolean, settings: ReadonlySet<string>): boolean => {
  if ((key.startsWith('SIDEQUEST_') && key !== 'SIDEQUEST_ALLOW_PROD') || key.startsWith('ALCHEMY_')) return false
  return !localRun || !(settings.has(key) || key.startsWith('SQ_GITHUB_APP_'))
}

/** The launch inputs a deploy runs with: the command line's (or CI's), else the stage env's, never two different ones. */
const launchInputs = (stage: Stage, base: NodeJS.ProcessEnv, local: Record<string, string>): Record<string, string> => {
  const inputs: Record<string, string> = {}
  for (const key of LAUNCH_INPUTS) {
    const given = base[key] || undefined
    const staged = local[key] || undefined
    if (given !== undefined && staged !== undefined && given !== staged)
      fail(`${key} differs between the command line and ${stage}.env`)
    const value = given ?? staged
    if (value !== undefined) inputs[key] = value
  }
  return inputs
}

export const assembleEnv = (
  stage: Stage,
  infra: StageFile,
  base: NodeJS.ProcessEnv = process.env,
  local: Record<string, string> = {},
): Record<string, string> => {
  if ([base, local].some((source) => Object.keys(source).some((key) => key.startsWith('DISTILLED_DEBUG'))))
    fail('DISTILLED_DEBUG settings are refused')
  const env: Record<string, string> = {}
  const localRun = base.CI !== 'true' && base.CI !== '1'
  const settings = new Set<string>([
    ...REQUIRED_SECRETS,
    'PRIVY_APP_ID',
    'PRIVY_SIGNER_ID',
    'PRIVY_POLICY_ID',
    'GITHUB_APP_ID',
    'GITHUB_APP_INSTALLATION_ID',
    'ARBITER_MODEL_BASE_URL',
    'SCREENING_MODEL',
  ])
  for (const [key, value] of Object.entries(base))
    if (value !== undefined && !launchInput(key) && inherited(key, localRun, settings)) env[key] = value
  Object.assign(
    env,
    Object.fromEntries(Object.entries(local).filter(([key]) => !launchInput(key))),
    launchInputs(stage, base, local),
  )
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_ACCOUNT_ID !== infra.cloudflare.accountId)
    fail('CLOUDFLARE_ACCOUNT_ID does not match the stage file')
  Object.assign(env, {
    SIDEQUEST_RELEASE: '1',
    SIDEQUEST_STAGE: stage,
    SIDEQUEST_NETWORK: infra.network,
    ALCHEMY_REMOTE_STATE: '1',
    SIDEQUEST_APPLY_MIGRATIONS: '1',
    CLOUDFLARE_ACCOUNT_ID: infra.cloudflare.accountId,
    ALCHEMY_PROFILE: 'default',
    BUN_CONFIG_NO_ENV_FILE: 'true',
  })
  if (env.SQ_GITHUB_APP_ID !== undefined) env.GITHUB_APP_ID = env.SQ_GITHUB_APP_ID
  if (env.SQ_GITHUB_APP_INSTALLATION_ID !== undefined)
    env.GITHUB_APP_INSTALLATION_ID = env.SQ_GITHUB_APP_INSTALLATION_ID
  if (env.SQ_GITHUB_APP_PRIVATE_KEY !== undefined) env.GITHUB_APP_PRIVATE_KEY = env.SQ_GITHUB_APP_PRIVATE_KEY
  return env
}

export const validateEnv = (env: Record<string, string>, required: readonly string[] = REQUIRED_SECRETS): void => {
  if (Object.keys(env).some((key) => key.startsWith('DISTILLED_DEBUG'))) fail('DISTILLED_DEBUG settings are refused')
  const missing = required.filter(
    (name) => env[name] === undefined || env[name]?.trim() === '' || env[name]?.trim().toLowerCase() === 'unset',
  )
  if (missing.length > 0) fail(`required secrets missing: ${missing.join(', ')}`)
}

const addressMatches = (key: string | undefined, expected: string, name: string): void => {
  if (key === undefined) fail(`${name} is missing`)
  let address: string
  try {
    address = privateKeyToAccount(key as `0x${string}`).address
  } catch {
    return fail(`${name} is invalid`)
  }
  if (address.toLowerCase() !== expected.toLowerCase()) fail(`${name} address mismatch`)
}

export const verifyRpcAndRoles = async (
  infra: StageFile,
  env: Record<string, string>,
  roles: { readonly attester: string },
): Promise<void> => {
  const rpc = env.MONAD_RPC_URL
  if (rpc === undefined) fail('MONAD_RPC_URL is missing')
  const client = createPublicClient({ transport: http(rpc) })
  if ((await client.getChainId()) !== infra.chainId) fail('MONAD_RPC_URL chain mismatch')
  addressMatches(env.RELAY_PRIVATE_KEY, infra.relay, 'RELAY_PRIVATE_KEY')
  addressMatches(env.ATTESTER_PRIVATE_KEY, roles.attester, 'ATTESTER_PRIVATE_KEY')
}

const getJson = async (url: string, token?: string, fetcher: typeof fetch = fetch): Promise<any> => {
  const headers = token === undefined ? {} : { authorization: `Bearer ${token}` }
  const response = await fetcher(url, { headers, redirect: 'error', signal: AbortSignal.timeout(20_000) })
  let body: any
  try {
    body = await response.json()
  } catch {
    fail(`request failed: HTTP ${response.status}`)
  }
  if (!response.ok || (body.success !== undefined && body.success !== true))
    fail(`request failed: HTTP ${response.status}`)
  return body
}

export const checkStateStore = async (
  accountId: string,
  credentialPath = STATE_CREDENTIAL,
  fetcher: typeof fetch = fetch,
): Promise<{ readonly url: string; readonly stackExists: (stage: Stage) => Promise<boolean> }> => {
  if (!existsSync(credentialPath)) fail('state-store credentials are missing')
  if ((statSync(credentialPath).mode & 0o077) !== 0) fail('state-store credentials must be mode 600')
  const credential = json(credentialPath) as {
    readonly url?: string
    readonly authToken?: string
    readonly accountId?: string
  }
  const credentialUrl = credential.url
  const credentialToken = credential.authToken
  if (typeof credentialUrl !== 'string' || typeof credentialToken !== 'string' || credentialToken === '')
    fail('invalid state-store credentials')
  if (credential.accountId !== accountId) fail('state-store credential account mismatch')
  const url = new URL(credentialUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    fail('invalid state-store URL')
  const version = await getJson(new URL('/version', credentialUrl).href, undefined, fetcher)
  const expected = expectedStateStoreVersion()
  if (version.version !== expected)
    fail(
      `state-store version mismatch: expected ${expected}, observed ${typeof version.version === 'number' ? version.version : 'unknown'}`,
    )
  return {
    url: credentialUrl,
    stackExists: async (stage) => {
      const stacks = await getJson(new URL('/state/stacks', credentialUrl).href, credentialToken, fetcher)
      if (!Array.isArray(stacks) || !stacks.every((stack) => typeof stack === 'string'))
        fail('invalid remote stack inventory')
      if (!stacks.includes('Sidequest')) return false
      const stages = await getJson(
        new URL('/state/stacks/Sidequest/stages', credentialUrl).href,
        credentialToken,
        fetcher,
      )
      if (!Array.isArray(stages) || !stages.every((entry) => typeof entry === 'string'))
        fail('invalid remote stage inventory')
      if (!stages.includes(stage)) return false
      // A stage with saved output or pending replacement generations is never a first deploy.
      const resources = await getJson(
        new URL(`/state/stacks/Sidequest/stages/${stage}/resources`, credentialUrl).href,
        credentialToken,
        fetcher,
      )
      if (!Array.isArray(resources)) fail('invalid remote resource inventory')
      return true
    },
  }
}

const page = async (path: string, token: string, fetcher: typeof fetch): Promise<any[]> => {
  const rows: any[] = []
  for (let number = 1; number <= 100; number++) {
    const body = await getJson(
      `https://api.cloudflare.com/client/v4${path}?page=${number}&per_page=100`,
      token,
      fetcher,
    )
    const info = body.result_info
    const total =
      info?.total_pages ??
      (Number.isInteger(info?.total_count) && Number.isInteger(info?.per_page) && info.per_page > 0
        ? Math.max(1, Math.ceil(info.total_count / info.per_page))
        : NaN)
    if (
      !Array.isArray(body.result) ||
      !Number.isInteger(total) ||
      total < 1 ||
      total > 100 ||
      info?.page !== number ||
      (info.count !== undefined && info.count !== body.result.length)
    )
      fail('cloudflare pagination incomplete')
    rows.push(...body.result)
    if (number >= total) {
      if (info.total_count !== undefined && rows.length !== info.total_count) fail('cloudflare pagination incomplete')
      return rows
    }
  }
  return fail('cloudflare pagination limit')
}

export const censusOf = async (infra: StageFile, token: string, fetcher: typeof fetch = fetch): Promise<Census> => {
  const account = infra.cloudflare.accountId
  const get = async (path: string) => {
    const response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
    let body: any
    try {
      body = await response.json()
    } catch {
      fail('cloudflare census unavailable')
    }
    if (!response.ok || body.success !== true) fail('cloudflare census unavailable')
    return body
  }
  const buckets: any[] = []
  let cursor: string | undefined
  const seen = new Set<string>()
  for (let number = 0; ; number++) {
    if (number >= 100) fail('cloudflare pagination limit')
    const body = await get(
      `/accounts/${account}/r2/buckets?per_page=100${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
    )
    if (!Array.isArray(body.result?.buckets)) fail('cloudflare census incomplete')
    buckets.push(...body.result.buckets)
    const next = body.result_info?.cursor
    if (!next) break
    if (typeof next !== 'string' || seen.has(next)) fail('cloudflare pagination incomplete')
    seen.add(next)
    cursor = next
  }
  const [zone, workers, databases, domains] = await Promise.all([
    get(`/zones/${infra.cloudflare.zoneId ?? ''}`),
    get(`/accounts/${account}/workers/scripts`),
    page(`/accounts/${account}/d1/database`, token, fetcher),
    page(`/accounts/${account}/workers/domains`, token, fetcher),
  ])
  if (!Array.isArray(workers.result)) fail('cloudflare census incomplete')
  return { zone: zone.result, workers: workers.result, databases, buckets, domains }
}

export const validateFirstDeployCensus = (infra: StageFile, census: Census): void => {
  const cloudflare = infra.cloudflare
  if (
    census.zone.id !== cloudflare.zoneId ||
    census.zone.account?.id !== cloudflare.accountId ||
    (cloudflare.zoneName !== undefined && census.zone.name !== cloudflare.zoneName) ||
    census.zone.status !== 'active'
  )
    fail('cloudflare zone ownership mismatch')
  const names = ['Api', 'Indexer', 'Explore']
    .map((id) => infra.resources[id])
    .filter((name): name is string => name !== undefined)
  if (
    census.workers.some((worker) => names.includes(worker.id ?? '')) ||
    census.databases.some((row) => row.name === infra.resources.Database) ||
    census.buckets.some((row) => row.name === infra.resources.Manifests) ||
    census.domains.some((domain) => domain.hostname === new URL(infra.origin).hostname)
  )
    fail('first deploy refused: fixed Cloudflare resources already exist (local-state migration required)')
}

export const assertPlanSafe = (counts: PlanCounts, firstDeploy: boolean, adoptMove: boolean): void => {
  for (const value of Object.values(counts)) if (!Number.isSafeInteger(value) || value < 0) fail('invalid plan counts')
  if (counts.replace > 0 || counts.delete > 0 || counts.orphaned > 0)
    fail(`plan refused: replace=${counts.replace} delete=${counts.delete} orphaned=${counts.orphaned}`)
  if (counts.adopted > 0 && !adoptMove)
    fail(`plan refused: adopted=${counts.adopted}; pass --adopt-move for the one-time state move`)
  if (counts.create > 0 && !firstDeploy) fail(`plan refused: create=${counts.create} outside a first deploy`)
}

const countsLine = (counts: PlanCounts): string =>
  Object.entries(counts)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
const writeSummary = (line: string): void => {
  const path = process.env.GITHUB_STEP_SUMMARY
  if (path !== undefined) writeFileSync(path, `${line}\n`, { flag: 'a' })
}

const configFor = (infra: StageFile): { readonly attester: string } => {
  const config = json(resolve(ROOT, `contracts/config/${infra.network}.json`)) as {
    readonly network: string
    readonly chainId: number
    readonly roles: { readonly attester: string }
  }
  if (config.network !== infra.network || config.chainId !== infra.chainId) fail('stage/contract network mismatch')
  if (typeof config.roles?.attester !== 'string') fail('contract attester address missing')
  return config.roles
}
export interface PlanRow {
  readonly fqn: string
  readonly action: string
  readonly bindings: readonly { readonly action: string }[]
}
interface Snapshot {
  readonly summary: PlanCounts
  readonly resources: readonly PlanRow[]
  readonly actions: readonly { readonly action: string }[]
  readonly drifted?: number
  readonly deferredAdoption?: readonly string[]
}
// The Alchemy CLI requires a regular file for --env-file; the stage env reaches it as the process environment instead,
// and BUN_OPTIONS=--no-env-file stops Bun auto-loading a checkout's .env/.env.local into the deploy.
const EMPTY_ENV = resolve(ROOT, 'scripts/ci/empty.env')
const runAlchemy = (
  action: 'plan' | 'drift',
  stage: Stage,
  env: Record<string, string>,
  adoptMove = false,
): Snapshot => {
  const child = spawnSync(
    'bun',
    ['--no-env-file', resolve(ROOT, 'scripts/ci/alchemy.ts'), action, stage, ...(adoptMove ? ['--adopt-move'] : [])],
    { cwd: ROOT, env, stdio: 'pipe', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  if (child.status !== 0) fail('programmatic Alchemy inspection failed (provider details withheld)')
  const lines = child.stdout.split('\n').filter((line) => line.startsWith('SIDEQUEST_CI_RESULT='))
  if (lines.length !== 1) fail('Alchemy inspection returned an invalid result')
  return JSON.parse(lines[0]!.slice('SIDEQUEST_CI_RESULT='.length)) as Snapshot
}

/** Creates whose ownership probe Alchemy defers to Apply (props wait on upstream outputs); Apply adopts them when they exist. */
export const deferredCreates = (snapshot: Snapshot): number =>
  snapshot.resources.filter((row) => row.action === 'create' && (snapshot.deferredAdoption ?? []).includes(row.fqn))
    .length
export const assertSnapshotSafe = (snapshot: Snapshot, firstDeploy: boolean, adoptMove: boolean): void => {
  // During the one-time dev state move, a deferred-adoption create is an adoption of the existing named resource.
  const deferred = adoptMove ? deferredCreates(snapshot) : 0
  assertPlanSafe(
    { ...snapshot.summary, create: snapshot.summary.create - deferred, adopted: snapshot.summary.adopted + deferred },
    firstDeploy,
    adoptMove,
  )
  if (snapshot.resources.some((row) => row.bindings.some((binding) => binding.action === 'delete')))
    fail('plan refused: binding deletion')
  if (snapshot.actions.some((entry) => entry.action === 'delete')) fail('plan refused: action deletion')
}
export const assertNoop = (snapshot: Snapshot): void => {
  if (
    Object.entries(snapshot.summary).some(([key, value]) => key !== 'noop' && value !== 0) ||
    snapshot.resources.some(
      (row) => row.action !== 'noop' || row.bindings.some((binding) => binding.action !== 'noop'),
    ) ||
    snapshot.actions.some((entry) => entry.action !== 'noop')
  )
    fail(`post-deploy plan is not a no-op: ${countsLine(snapshot.summary)}`)
}

const workerVersions = async (infra: StageFile, token: string): Promise<string> => {
  const versions: string[] = []
  for (const id of ['Api', 'Indexer', 'Explore']) {
    try {
      const name = infra.resources[id]!
      const body = await getJson(
        `https://api.cloudflare.com/client/v4/accounts/${infra.cloudflare.accountId}/workers/scripts/${encodeURIComponent(name)}/deployments`,
        token,
      )
      const version = body.result?.deployments?.[0]?.versions?.[0]?.version_id
      if (typeof version === 'string' && /^[a-f0-9-]{36}$/i.test(version)) versions.push(`${id}:${version}`)
    } catch {
      /* Versions are supplementary evidence; deployment verification is the no-op plan. */
    }
  }
  return versions.length === 0 ? 'unavailable' : versions.join(',')
}

async function main(): Promise<void> {
  const [actionArg, stageArg, ...flags] = process.argv.slice(2)
  if (!['plan', 'deploy', 'drift'].includes(actionArg ?? '') || (stageArg !== 'dev' && stageArg !== 'prod'))
    fail('usage: bun scripts/ci/release.ts plan|deploy|drift dev|prod [--adopt-move]')
  const action = actionArg as Action
  const stage = stageArg as Stage
  if (flags.some((flag) => flag !== '--adopt-move') || flags.length > 1) fail('unknown release flag')
  const adoptMove = flags.includes('--adopt-move')
  if (adoptMove && (stage !== 'dev' || action === 'drift')) fail('--adopt-move is only available for dev plan/deploy')
  const infra = stageFile(stage)
  const env = assembleEnv(stage, infra, process.env, readStageEnv(stage))
  if (stage === 'prod' && env.SIDEQUEST_ALLOW_PROD !== '1' && process.env.SIDEQUEST_ALLOW_PROD !== '1')
    fail('prod requires SIDEQUEST_ALLOW_PROD=1')
  validateEnv(env)
  await verifyRpcAndRoles(infra, env, configFor(infra))
  const stateStore = await checkStateStore(infra.cloudflare.accountId)
  const remoteState = await stateStore.stackExists(stage)
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  if (!remoteState && !adoptMove) validateFirstDeployCensus(infra, await censusOf(infra, env.CLOUDFLARE_API_TOKEN!))
  if (action === 'drift') {
    if (!remoteState) fail(`drift refused: no remote state for Sidequest/${stage}`)
    // The noninteractive CLI does not fail on drift; require the programmatic verdict too.
    const cli = spawnSync(
      'bunx',
      ['--no-install', 'alchemy', 'drift', '--stage', stage, '--profile', 'default', '--env-file', EMPTY_ENV],
      { cwd: ROOT, env: { ...env, BUN_OPTIONS: '--no-env-file' }, stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 },
    )
    if (cli.status !== 0) fail('alchemy drift failed (provider output withheld)')
    const snapshot = runAlchemy('drift', stage, env)
    if (snapshot.drifted === undefined) fail('invalid drift verdict')
    if (snapshot.drifted > 0) fail(`drift detected: ${snapshot.drifted} resource(s)`)
    const line = `Sidequest drift clean stage=${stage} commit=${commit}`
    console.log(line)
    writeSummary(line)
    return
  }
  const snapshot = runAlchemy('plan', stage, env, adoptMove)
  const counts = snapshot.summary
  assertSnapshotSafe(snapshot, !remoteState && !adoptMove, adoptMove)
  for (const resource of snapshot.resources)
    console.log(
      `${resource.fqn}: ${resource.action}${(snapshot.deferredAdoption ?? []).includes(resource.fqn) ? ' (ownership probe at apply)' : ''}`,
    )
  const summary = `Sidequest ${action} stage=${stage} commit=${commit} ${countsLine(counts)}`
  console.log(summary)
  writeSummary(summary)
  if (action === 'plan') return
  // Capture provider output: it can contain credential-bearing request details.
  await checkStateStore(infra.cloudflare.accountId)
  const deploy = spawnSync(
    'bunx',
    [
      '--no-install',
      'alchemy',
      'deploy',
      '--stage',
      stage,
      '--profile',
      'default',
      '--env-file',
      EMPTY_ENV,
      '--yes',
      ...(adoptMove ? ['--adopt'] : []),
    ],
    { cwd: ROOT, env: { ...env, BUN_OPTIONS: '--no-env-file' }, stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 },
  )
  if (deploy.status !== 0) fail('alchemy deploy failed (provider output withheld)')
  const after = runAlchemy('plan', stage, env)
  assertNoop(after)
  const versions = await workerVersions(infra, env.CLOUDFLARE_API_TOKEN!)
  const done = `Sidequest deploy verified stage=${stage} commit=${commit} ${countsLine(after.summary)} workers=${versions}`
  console.log(done)
  writeSummary(done)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(
      `release refused: ${error instanceof ReleaseRefusal ? error.message : 'provider or configuration unavailable (details withheld)'}`,
    )
    process.exitCode = 1
  })
}

export { REQUIRED_SECRETS }
