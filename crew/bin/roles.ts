/**
 * The ecosystem roles beside the crew, each an always-on container of the crew image: the dispute arbiter for both
 * testnet boards (dev and prod), and the Commons moderator and maintainer for dev's Commons. They run
 * `apps/arbiter/src/main.ts --role <role>` from a detached worktree pinned to a released commit, never the shared
 * checkout, which other agents edit live.
 *
 *   bun crew/bin/roles.ts up <sha> [role…]   pin the worktree to <sha> (install once), write the compose file, start
 *   bun crew/bin/roles.ts down               stop and remove the role containers
 *   bun crew/bin/roles.ts status             list them
 *
 * Each role's keys and model key reach its container through its own 0600 env file holding only the variables that
 * role reads; they are read from .env.local, ~/.config/secrets.env, ~/.config/cliproxy.env and the dev stage env, and
 * are never printed or put on a command line. The moderator's and maintainer's cursors live in .crew/roles/state.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { stageProfile, type StageProfile } from '../../infra/stage.ts'
import { roleEnvironment, roleLayout, type Role, type RoleInputs } from './role-config.ts'

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

/** The worktree at `sha`, installed: recreated when it is at another commit. */
function pin(sha: string, tree: string): string {
  const full = git('rev-parse', '--verify', `${sha}^{commit}`)
  if (
    existsSync(tree) &&
    spawnSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() !== full
  )
    git('worktree', 'remove', '--force', tree)
  if (!existsSync(tree)) {
    git('worktree', 'add', '--detach', tree, full)
    const install = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: tree, stdio: 'inherit' })
    if (install.status !== 0) throw new Error('bun install failed in the roles worktree')
  }
  return full
}

function service(input: {
  readonly role: Role
  readonly env: RoleInputs
  readonly stage: StageProfile
  readonly layout: ReturnType<typeof roleLayout>
  readonly sha: string
  readonly bun: string
}) {
  const { role, env, stage, layout, sha, bun } = input
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
    working_dir: layout.tree,
    command: ['/opt/bin/bun', '--no-env-file', 'apps/arbiter/src/main.ts', '--role', role],
    env_file: [envFile],
    environment: { HOME: '/tmp' },
    cpus: 0.5,
    mem_limit: '512m',
    security_opt: ['no-new-privileges:true'],
    cap_drop: ['ALL'],
    networks: ['crew'],
    labels: { 'sidequest.role': role, 'sidequest.source': sha },
    volumes: [`${layout.tree}:${layout.tree}:ro`, `${layout.stateDir}:/state`, `${bun}:/opt/bin/bun:ro`],
  }
}

function up(sha: string | undefined, only: string[]) {
  if (sha === undefined) throw new Error('usage: roles.ts up <released sha> [role…]')
  if (only.some((name) => !isRole(name))) throw new Error('roles are arbiter, moderator, maintainer')
  const stage = stageProfile(process.env.SIDEQUEST_STAGE ?? 'dev')!
  const layout = roleLayout(repo, stage)
  const defaults = stage.network === 'monad-mainnet' ? ['arbiter'] : ['arbiter', 'moderator', 'maintainer']
  const roles = (only.length === 0 ? defaults : only).filter(isRole)
  if (stage.network === 'monad-mainnet' && roles.some((role) => role !== 'arbiter'))
    throw new Error('Only arbiter is enabled on mainnet')
  const full = pin(sha, layout.tree)
  mkdirSync(layout.stateDir, { recursive: true })
  mkdirSync(layout.envDir, { recursive: true, mode: 0o700 })
  const bun = spawnSync('bash', ['-lc', 'command -v bun'], { encoding: 'utf8' }).stdout.trim()
  const e = secrets(stage)
  const services = Object.fromEntries(
    roles.map((role) => [`sq-${role}${layout.suffix}`, service({ role, env: e, stage, layout, sha: full, bun })]),
  )
  // The crew's network: cliproxy is reachable from it as from the crew bots.
  const compose = { name: layout.project, services, networks: { crew: { name: 'sidequest-crew', external: true } } }
  writeFileSync(layout.composeFile, `${JSON.stringify(compose, null, 2)}\n`)
  const started = spawnSync('docker', ['compose', '-f', layout.composeFile, 'up', '-d', ...Object.keys(services)], {
    stdio: 'inherit',
  })
  process.exitCode = started.status ?? 1
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2)
  const selectedStage = stageProfile(process.env.SIDEQUEST_STAGE ?? 'dev')!
  const layout = roleLayout(repo, selectedStage)
  if (command === 'up') up(rest[0], rest.slice(1))
  else if (command === 'down') spawnSync('docker', ['compose', '-f', layout.composeFile, 'down'], { stdio: 'inherit' })
  else if (command === 'status')
    spawnSync('docker', ['ps', '-a', '--filter', 'label=sidequest.role', '--format', '{{.Names}}\t{{.Status}}'], {
      stdio: 'inherit',
    })
  else console.log('usage: SIDEQUEST_STAGE=dev|prod bun crew/bin/roles.ts up <sha> [role…] | down | status')
}
