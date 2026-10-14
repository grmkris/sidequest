/**
 * The ecosystem roles beside the crew, each an always-on container of the crew image. Testnet (dev) runs the dispute
 * arbiter and the Commons moderator and maintainer; mainnet (prod) runs the arbiter and the Commons moderator. They run
 * `apps/arbiter/src/main.ts --role <role>` from a detached worktree of a released commit, never the shared checkout,
 * which other agents edit live.
 *
 *   bun crew/bin/roles.ts up <sha> [role…]   add <sha>'s tree (installed once), set those roles in the compose file, start them
 *   bun crew/bin/roles.ts down               stop and remove every role container in the stage's compose file
 *   bun crew/bin/roles.ts prune              remove this stage's per-commit trees that no role runs from
 *   bun crew/bin/roles.ts status             list them
 *
 * Every commit gets its own tree, and `up` replaces only the roles it names, so starting one role never moves the source
 * under another or drops it from the file. Trees from before per-commit trees (`roles`, `roles-mainnet`) stay as long as
 * a role still runs from them.
 *
 * Each role's keys and model key reach its container through its own 0600 env file holding only the variables that
 * role reads; they are read from .env.local, ~/.config/secrets.env, ~/.config/cliproxy.env and the stage env, and are
 * never printed or put on a command line. The moderator's and maintainer's cursors live in the stage's state directory.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { stageProfile, type StageProfile } from '../../infra/stage.ts'
import {
  assertRoleOnNetwork,
  mergeCompose,
  roleEnvironment,
  roleLayout,
  roleTree,
  unusedTrees,
  type Role,
  type RoleCompose,
  type RoleInputs,
} from './role-config.ts'

const repo = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
const IMAGE = 'sidequest-crew'
/** cliproxy as the crew's containers reach it (crew.json harness.containerBaseUrl). */
const MODEL_BASE_URL: string = JSON.parse(readFileSync(join(repo, 'crew', 'crew.json'), 'utf8')).harness
  .containerBaseUrl

function secrets(stage: StageProfile): RoleInputs {
  const files = [
    ...(stage.network === 'monad-testnet' ? [join(repo, '.env.local')] : []),
    join(homedir(), '.config/secrets.env'),
    join(homedir(), '.config/cliproxy.env'),
    join(homedir(), `.config/sidequest/${stage.stage}.env`),
  ]
  const merged: Record<string, string | undefined> = {}
  for (const file of files)
    if (existsSync(file)) Object.assign(merged, parseEnv(readFileSync(file, 'utf8').replace(/^export /gm, '')))
  return merged
}

const isRole = (name: string): name is Role => ['arbiter', 'moderator', 'maintainer'].includes(name)

function git(...args: string[]) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

/**
 * `full`'s tree, installed once. A tree at another commit is refused, never removed: a running role may mount it.
 */
function pin(full: string, tree: string): void {
  if (existsSync(tree)) {
    const head = spawnSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    if (head !== full) throw new Error(`${tree} is at ${head || 'no commit'}, not ${full}; it was not changed`)
  } else git('worktree', 'add', '--detach', tree, full)
  if (existsSync(join(tree, 'node_modules'))) return
  const install = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: tree, stdio: 'inherit' })
  if (install.status !== 0) throw new Error('bun install failed in the roles worktree')
}

function readCompose(file: string): RoleCompose | undefined {
  if (!existsSync(file)) return undefined
  // SAFETY: only writeCompose writes this file, always from a RoleCompose.
  return JSON.parse(readFileSync(file, 'utf8')) as RoleCompose
}

/** Written beside the file and renamed over it, so a crash never leaves the running roles' compose file half written. */
function writeCompose(file: string, compose: RoleCompose): void {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(compose, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}

function service(input: {
  readonly role: Role
  readonly env: RoleInputs
  readonly stage: StageProfile
  readonly layout: ReturnType<typeof roleLayout>
  readonly tree: string
  readonly sha: string
  readonly bun: string
}) {
  const { role, env, stage, layout, tree, sha, bun } = input
  const testnetBoards = ['dev', 'prod']
    .map((name) => stageProfile(name)!)
    .filter((profile) => profile.network === 'monad-testnet')
    .map((profile) => profile.origin)
  const vars = Object.entries(roleEnvironment(role, env, stage, MODEL_BASE_URL, testnetBoards))
  const missing = vars.filter(([, value]) => value === undefined || value === '').map(([name]) => name)
  if (missing.length > 0) throw new Error(`${role}: missing ${missing.join(', ')}`)
  const envFile = join(layout.envDir, `${role}.env`)
  writeFileSync(envFile, `${vars.map(([name, value]) => `${name}=${value}`).join('\n')}\n`, { mode: 0o600 })
  chmodSync(envFile, 0o600)
  return {
    image: IMAGE,
    container_name: `sq-${role}${layout.suffix}`,
    user: '1000:1000',
    init: true,
    restart: 'unless-stopped',
    working_dir: tree,
    command: ['/opt/bin/bun', '--no-env-file', 'apps/arbiter/src/main.ts', '--role', role],
    env_file: [envFile],
    environment: { HOME: '/tmp' },
    cpus: 0.5,
    mem_limit: '512m',
    security_opt: ['no-new-privileges:true'],
    cap_drop: ['ALL'],
    networks: ['crew'],
    labels: { 'sidequest.role': role, 'sidequest.source': sha },
    volumes: [`${tree}:${tree}:ro`, `${layout.stateDir}:/state`, `${bun}:/opt/bin/bun:ro`],
  }
}

function up(sha: string | undefined, only: string[]) {
  if (sha === undefined) throw new Error('usage: roles.ts up <released sha> [role…]')
  if (only.some((name) => !isRole(name))) throw new Error('roles are arbiter, moderator, maintainer')
  const stage = stageProfile(process.env.SIDEQUEST_STAGE ?? 'dev')!
  const layout = roleLayout(repo, stage)
  const defaults = stage.network === 'monad-mainnet' ? ['arbiter'] : ['arbiter', 'moderator', 'maintainer']
  const roles = (only.length === 0 ? defaults : only).filter(isRole)
  for (const role of roles) assertRoleOnNetwork(role, stage)
  const full = git('rev-parse', '--verify', `${sha}^{commit}`)
  const tree = roleTree(layout, full)
  pin(full, tree)
  mkdirSync(layout.stateDir, { recursive: true })
  mkdirSync(layout.envDir, { recursive: true, mode: 0o700 })
  const bun = spawnSync('bash', ['-lc', 'command -v bun'], { encoding: 'utf8' }).stdout.trim()
  const e = secrets(stage)
  const services = Object.fromEntries(
    roles.map((role) => [`sq-${role}${layout.suffix}`, service({ role, env: e, stage, layout, tree, sha: full, bun })]),
  )
  // The crew's network (set by mergeCompose): cliproxy is reachable from it as from the crew bots.
  writeCompose(layout.composeFile, mergeCompose(readCompose(layout.composeFile), layout.project, services))
  const started = spawnSync('docker', ['compose', '-f', layout.composeFile, 'up', '-d', ...Object.keys(services)], {
    stdio: 'inherit',
  })
  process.exitCode = started.status ?? 1
}

function prune(layout: ReturnType<typeof roleLayout>) {
  const trees = git('worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
  for (const tree of unusedTrees(layout, readCompose(layout.composeFile), trees)) {
    git('worktree', 'remove', '--force', tree)
    console.log(`removed ${tree}`)
  }
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2)
  const selectedStage = stageProfile(process.env.SIDEQUEST_STAGE ?? 'dev')!
  const layout = roleLayout(repo, selectedStage)
  if (command === 'up') up(rest[0], rest.slice(1))
  else if (command === 'down') spawnSync('docker', ['compose', '-f', layout.composeFile, 'down'], { stdio: 'inherit' })
  else if (command === 'prune') prune(layout)
  else if (command === 'status')
    spawnSync('docker', ['ps', '-a', '--filter', 'label=sidequest.role', '--format', '{{.Names}}\t{{.Status}}'], {
      stdio: 'inherit',
    })
  else console.log('usage: SIDEQUEST_STAGE=dev|prod bun crew/bin/roles.ts up <sha> [role…] | down | prune | status')
}
