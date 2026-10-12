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

const repo = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
const tree = `${repo}.wt/roles`
const stateDir = join(repo, '.crew', 'roles', 'state')
const envDir = join(repo, '.crew', 'roles', 'env')
const composeFile = join(repo, '.crew', 'roles', 'compose.json')
const PROJECT = 'sidequest-roles'
const IMAGE = 'sidequest-crew'
const DEV = 'https://dev.sidequest.exchange'
const PROD = 'https://sidequest.exchange'
/** cliproxy as the crew's containers reach it (crew.json harness.containerBaseUrl). */
const MODEL_BASE_URL: string = JSON.parse(readFileSync(join(repo, 'crew', 'crew.json'), 'utf8')).harness
  .containerBaseUrl

type Env = Record<string, string | undefined>

function secrets(): Env {
  const files = [
    join(repo, '.env.local'),
    join(homedir(), '.config/secrets.env'),
    join(homedir(), '.config/cliproxy.env'),
    join(homedir(), '.config/sidequest/dev.env'),
  ]
  const merged: Env = {}
  for (const file of files)
    if (existsSync(file)) Object.assign(merged, parseEnv(readFileSync(file, 'utf8').replace(/^export /gm, '')))
  return merged
}

/** What each role reads, and nothing else. */
const ROLES = {
  arbiter: (e: Env) => ({
    NETWORK: 'monad-testnet',
    BOARD_URLS: `${DEV},${PROD}`,
    V1_ARBITRATOR_PRIVATE_KEY: e.SIDEQUEST_DEV_ARBITRATOR_PRIVATE_KEY,
    ARBITER_MODEL: e.ARBITER_MODEL,
    ARBITER_MODEL_BASE_URL: MODEL_BASE_URL,
    ARBITER_MODEL_API_KEY: e.CLIPROXY_API_KEY,
    ARBITER_RUNNER: 'sq-arbiter@netcup',
    ARBITER_INTERVAL_SECONDS: '60',
    // Sends a dispute's cancellation transaction.
    MONAD_RPC_URL: e.MONAD_RPC_URL || e.MONAD_TESTNET_RPC_URL,
  }),
  moderator: (e: Env) => ({
    NETWORK: 'monad-testnet',
    BOARD_URL: DEV,
    MODERATOR_PRIVATE_KEY: e.MODERATOR_PRIVATE_KEY,
    MODERATOR_MODEL: 'qwen3.8-flash',
    MODERATOR_MODEL_BASE_URL: MODEL_BASE_URL,
    MODERATOR_MODEL_API_KEY: e.CLIPROXY_API_KEY,
    MODERATOR_CURSOR_FILE: '/state/moderator.cursor',
  }),
  maintainer: (e: Env) => ({
    NETWORK: 'monad-testnet',
    BOARD_URL: DEV,
    MAINTAINER_PRIVATE_KEY: e.MAINTAINER_PRIVATE_KEY,
    MAINTAINER_MODEL: 'gpt-6.1-sol',
    MAINTAINER_MODEL_BASE_URL: MODEL_BASE_URL,
    MAINTAINER_MODEL_API_KEY: e.CLIPROXY_API_KEY,
    MAINTAINER_STATE_FILE: '/state/maintainer.json',
  }),
} as const
type Role = keyof typeof ROLES
const isRole = (name: string): name is Role => Object.hasOwn(ROLES, name)

function git(...args: string[]) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

/** The worktree at `sha`, installed: recreated when it is at another commit. */
function pin(sha: string): string {
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

function service(role: Role, e: Env, sha: string, bun: string) {
  const vars = Object.entries(ROLES[role](e))
  const missing = vars.filter(([, value]) => value === undefined || value === '').map(([name]) => name)
  if (missing.length > 0) throw new Error(`${role}: missing ${missing.join(', ')}`)
  const envFile = join(envDir, `${role}.env`)
  writeFileSync(envFile, `${vars.map(([name, value]) => `${name}=${value}`).join('\n')}\n`, { mode: 0o600 })
  chmodSync(envFile, 0o600)
  return {
    image: IMAGE,
    container_name: `sq-${role}`,
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
    volumes: [`${tree}:${tree}:ro`, `${stateDir}:/state`, `${bun}:/opt/bin/bun:ro`],
  }
}

function up(sha: string | undefined, only: string[]) {
  if (sha === undefined) throw new Error('usage: roles.ts up <released sha> [role…]')
  if (only.some((name) => !isRole(name))) throw new Error(`roles are ${Object.keys(ROLES).join(', ')}`)
  const roles = (only.length === 0 ? Object.keys(ROLES) : only).filter(isRole)
  const full = pin(sha)
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(envDir, { recursive: true, mode: 0o700 })
  const bun = spawnSync('bash', ['-lc', 'command -v bun'], { encoding: 'utf8' }).stdout.trim()
  const e = secrets()
  const services = Object.fromEntries(roles.map((role) => [`sq-${role}`, service(role, e, full, bun)]))
  // The crew's network: cliproxy is reachable from it as from the crew bots.
  const compose = { name: PROJECT, services, networks: { crew: { name: 'sidequest-crew', external: true } } }
  writeFileSync(composeFile, `${JSON.stringify(compose, null, 2)}\n`)
  const started = spawnSync('docker', ['compose', '-f', composeFile, 'up', '-d', ...Object.keys(services)], {
    stdio: 'inherit',
  })
  process.exitCode = started.status ?? 1
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'up') up(rest[0], rest.slice(1))
else if (command === 'down') spawnSync('docker', ['compose', '-f', composeFile, 'down'], { stdio: 'inherit' })
else if (command === 'status')
  spawnSync('docker', ['ps', '-a', '--filter', 'label=sidequest.role', '--format', '{{.Names}}\t{{.Status}}'], {
    stdio: 'inherit',
  })
else console.log('usage: bun crew/bin/roles.ts up <sha> [arbiter|moderator|maintainer…] | down | status')
