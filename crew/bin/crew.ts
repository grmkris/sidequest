#!/usr/bin/env bun
/**
 * The Sidequest crew: each member is a hosted agent its operator created on the site and connected here over OAuth,
 * run headless in its own `sidequest-crew` container on a schedule. No member holds a private key; Sidequest signs and
 * pays gas for it. Every member runs Codex CLI against the box's cliproxy with its own model (crew.json), and each
 * container is capped (CPUs, memory, pids) and weighted below interactive work and CI. State (OAuth tokens, harness
 * home, scratch work, cursors, transcripts) lives in `.crew/hosted/`, which git ignores.
 *
 *   bun crew/bin/crew.ts login <member>            print the consent link (sign in, pick the member's agent, approve)
 *   bun crew/bin/crew.ts login <member> '<url>'    finish with the page address the browser landed on
 *   bun crew/bin/crew.ts run <member> [note]       one routine pass (inbox, listing, work), then stop
 *   bun crew/bin/crew.ts loop [minutes]            check every enabled, connected member each interval; start a run
 *                                                  (in parallel) only when it has inbox events, held work or a listing due
 *   bun crew/bin/crew.ts status
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { stageProfile } from '../../infra/stage.ts'
import * as hosted from './hosted-mcp.ts'
import { type ConnectionFiles, type Token, readToken } from './hosted-mcp.ts'
import { type HeldTask, type Offers, openHeld, wakeInbox } from './crew-wake.ts'
import { finishWake } from './inbox-state.ts'

const crewDir = resolve(import.meta.dir, '..')
const repo = resolve(crewDir, '..')
const crew = withBoard(JSON.parse(readFileSync(join(crewDir, 'crew.json'), 'utf8')) as CrewFile)
/** Set in a bot's own container (`up`): its supervisor runs as root there and starts each run as the harness's uid. */
const inContainer = process.env.CREW_IN_CONTAINER === '1'
const stateRoot =
  process.env.CREW_STATE_ROOT ??
  (crew.board.stage === 'dev' ? join(repo, '.crew', 'hosted') : join(repo, '.crew', 'hosted', crew.board.stage))
const cliproxyUrl = inContainer ? crew.harness.containerBaseUrl : crew.harness.baseUrl
const IMAGE = 'sidequest-crew'
/** Dev keeps its names; another stage's crew gets its own containers, compose project and env files beside dev's. */
const staged = (name: string) => (crew.board.stage === 'dev' ? name : `${name}-${crew.board.stage}`)
const PROJECT = staged('sidequest-crew')
const COMPOSE = join(repo, '.crew', `${staged('compose')}.json`)
const ENV_DIR = join(repo, '.crew', staged('env'))
const HARNESS_UID = 1000
/** How a supervisor starts a run in its container: as the harness's uid, without groups, capabilities or setuid. */
const DROP = ['--reuid=1000', '--regid=1000', '--clear-groups', '--no-new-privs', '--inh-caps=-all', '--']

interface Resources {
  cpus: number
  memory: string
}
interface Member {
  name: string
  email: string
  operator: string
  model: string
  /** The OAuth scopes its login asks for (default: the board's); a worker-only member drops sidequest:hire. */
  scopes?: string
  /** The CLI that runs the member: Codex (default) or Grok's own CLI, both against cliproxy. */
  harness?: 'codex' | 'grok'
  /** Used after `harness.fallbackAfter` failed runs in a row (cliproxy models come and go). */
  fallbackModel?: string
  effort: string
  resources?: Resources
  /** Overrides harness.runTimeoutMinutes (renders run long); capped below the hour an access token lasts. */
  runTimeoutMinutes?: number
  enabled: boolean
  env: string[]
  mcp: Record<string, string>
  /** Its directory listings (advertise_service, at most 10); `service` is the older single-listing form. */
  services?: Listing[]
  /** What public requests wake it: their tags, or words in their title or brief (none set: every request). */
  fit?: { tags: string[]; keywords: string[] }
  service?: Listing
}
/** One listing as crew.json writes it: a sample URL may be a path on the board's origin (`/samples/<sha256>.webp`). */
type Listing = Record<string, unknown> & { samples?: Array<Record<string, unknown> & { url: string }> }
interface CrewFile extends Omit<Crew, 'board'> {
  board: { stage: string; scopes: string; rpc: string }
}
interface Crew {
  board: CrewFile['board'] & { origin: string; mcp: string; relay?: string; chainId: number; chain: string }
  harness: {
    baseUrl: string
    /** cliproxy as a bot's container on the crew bridge reaches it: the box's tailnet address, not loopback. */
    containerBaseUrl: string
    /** How often a bot's container checks for work. */
    loopMinutes: number
    maxParallel: number
    runTimeoutMinutes: number
    cpuShares: number
    resources: Resources
    relayFloorMon: number
    fallbackAfter: number
    /** The cost guard: model runs per member per UTC day (idle checks are free and do not count). */
    maxRunsPerDay: number
  }
  members: Record<string, Member>
}

/** CREW_STAGE overrides crew.json's `board.stage`; its profile defines the board, with V1_BOARD_URL overriding origin. */
function withBoard(file: CrewFile): Crew {
  const stage = process.env.CREW_STAGE ?? file.board.stage
  const profile = stageProfile(stage)
  if (profile === undefined) throw new Error(`crew board.stage must be dev or prod, not ${stage}`)
  const origin = new URL(process.env.V1_BOARD_URL ?? profile.origin).origin
  const chain = profile.network === 'monad-mainnet' ? 'Monad mainnet' : 'Monad testnet'
  return {
    ...file,
    board: {
      ...file.board,
      stage,
      origin,
      mcp: `${origin}/mcp`,
      relay: profile.relay,
      chainId: profile.chainId,
      chain,
    },
  }
}
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const home = (member: string) => join(stateRoot, member)
const memberOf = (id: string | undefined): [string, Member] => {
  const m = id === undefined ? undefined : crew.members[id]
  if (m === undefined) throw new Error(`member must be one of: ${Object.keys(crew.members).join(', ')}`)
  return [id!, m]
}
const bot = (id: string) => (crew.board.stage === 'dev' ? `sq-bot-${id}` : `sq-bot-${crew.board.stage}-${id}`)
/** OAuth files: in `secrets/` (root-only) once a member runs in its container, else in its home as before. */
const secretPath = (id: string, file: string) =>
  inContainer || existsSync(join(home(id), 'secrets')) ? join(home(id), 'secrets', file) : join(home(id), file)
/** In a container the supervisor is root: whatever it writes for a run has to belong to the harness's uid. */
const own = (...paths: string[]) => {
  if (inContainer) for (const p of paths) if (existsSync(p)) chownSync(p, HARNESS_UID, HARNESS_UID)
}
const botRunning = (id: string) =>
  spawnSync('docker', ['container', 'inspect', '-f', '{{.State.Running}}', bot(id)], {
    encoding: 'utf8',
  }).stdout.trim() === 'true'
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The crew's cliproxy key: its own (`CLIPROXY_API_KEY_CREW`, so the gateway's usage collector can tell the crew's model
 * use from everything else on the box), else the box's main key.
 */
const cliproxyKey = (e: Record<string, string>): string => e.CLIPROXY_API_KEY_CREW ?? e.CLIPROXY_API_KEY ?? ''

function env(): Record<string, string> {
  const files = [
    join(repo, '.env.local'),
    join(process.env.HOME ?? '', '.config/secrets.env'),
    join(process.env.HOME ?? '', '.config/cliproxy.env'),
    // The crew's GitHub tokens, one per member that acts on GitHub (see a member's `env`).
    join(process.env.HOME ?? '', '.config/sidequest/crew-github.env'),
  ]
  const merged: Record<string, string> = {}
  for (const f of files) {
    if (!existsSync(f)) continue
    const text = readFileSync(f, 'utf8').replace(/^export /gm, '')
    Object.assign(merged, parseEnv(text))
  }
  return { ...merged, ...(process.env as Record<string, string>) }
}

/** A member's OAuth files: in `secrets/` once it runs in its container (see secretPath). */
const oauthFiles = (id: string): ConnectionFiles => ({
  client: secretPath(id, 'client.json'),
  login: secretPath(id, 'login.json'),
  token: secretPath(id, 'token.json'),
  lock: secretPath(id, 'token.lock'),
})

async function login(id: string, landed?: string) {
  const [, m] = memberOf(id)
  if (landed === undefined) {
    const url = await hosted.beginLogin(crew.board, oauthFiles(id), {
      clientName: `Sidequest crew: ${m.name}`,
      scopes: m.scopes ?? crew.board.scopes,
    })
    console.log(
      `Open this while signed in to ${crew.board.origin}, pick ${m.name}'s agent and approve. The browser then`,
    )
    console.log(
      `lands on ${hosted.REDIRECT}?code=… (a page that does not load); pass that whole address within 2 minutes:\n`,
    )
    console.log(`${url}\n`)
    console.log(`  bun crew/bin/crew.ts login ${id} '<that address>'`)
    return
  }
  const t = await hosted.finishLogin(crew.board, oauthFiles(id), landed)
  console.log(`${m.name} connected as agent ${t.agent_id} with ${t.scope}`)
}

/** Minutes a member's run may take: its own override or the harness default, never past a fresh token's hour. */
function runTimeout(id: string): number {
  return Math.min(crew.members[id]?.runTimeoutMinutes ?? crew.harness.runTimeoutMinutes, 55)
}

/** A token that outlives the member's run (it may last its timeout; access tokens last an hour). */
const freshToken = (id: string): Promise<Token> =>
  hosted.freshToken(crew.board, oauthFiles(id), (runTimeout(id) + 5) * 60, id)

const bin = (name: string) =>
  realpathSync(spawnSync('bash', ['-lc', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim())

function prepareAgentDir(id: string): string {
  const agent = join(home(id), 'agent')
  mkdirSync(join(agent, 'state'), { recursive: true, mode: 0o700 })
  mkdirSync(join(agent, 'work'), { recursive: true })
  own(agent, join(agent, 'state'), join(agent, 'work'))
  const role = join(crewDir, 'agents', id)
  for (const f of readdirSync(role)) {
    const from = join(role, f)
    const to = join(agent, f === 'ROLE.md' ? 'AGENTS.md' : f)
    // ROLE.md lands as AGENTS.md: the harness loads it from the working directory, and the repo's agent check skips it.
    if (statSync(from).isFile()) copyFileSync(realpathSync(from), to)
    own(to)
  }
  // Skills are pinned by skills-lock.json and restored once per member, as the harness's user in a container.
  if (!existsSync(join(agent, '.agents')) && !existsSync(join(agent, '.claude', 'skills'))) {
    const install = ['npx', '--yes', 'skills', 'experimental_install']
    if (inContainer)
      spawnSync('setpriv', [...DROP, ...install], {
        cwd: agent,
        stdio: 'inherit',
        env: { HOME: '/home/agent', PATH: '/usr/local/bin:/usr/bin:/bin' },
      })
    else spawnSync('npx', install.slice(1), { cwd: agent, stdio: 'inherit' })
  }
  return agent
}

/** The harness's own config in its home: cliproxy as the model provider, the board (and extra servers) as MCP. */
function writeHarnessConfig(m: Member, token: Token, harnessHome: string) {
  mkdirSync(join(harnessHome, '.codex'), { recursive: true, mode: 0o700 })
  writeFileSync(
    join(harnessHome, '.gitconfig'),
    `[user]\n\tname = ${m.name}\n\temail = ${m.email}\n[safe]\n\tdirectory = *\n[init]\n\tdefaultBranch = main\n${
      // A member with a GitHub token pushes over https through gh, which reads GH_TOKEN from the run's env.
      m.env.some((v) => v.startsWith('GH_TOKEN'))
        ? '[credential "https://github.com"]\n\thelper =\n\thelper = !/opt/bin/gh auth git-credential\n'
        : ''
    }`,
  )
  const extraMcp = Object.entries(m.mcp)
    .map(([n, url]) => `[mcp_servers.${n}]\nurl = "${url}"\n`)
    .join('')
  // Grok's CLI reads the board's bearer token from its config, not the environment; the home is the member's own (0700).
  if (m.harness === 'grok') {
    mkdirSync(join(harnessHome, '.grok'), { recursive: true, mode: 0o700 })
    writeFileSync(
      join(harnessHome, '.grok', 'config.toml'),
      `[models]\ndefault = "${m.model}"\ndefault_reasoning_effort = "${m.effort}"\n[model."${m.model}"]\nbase_url = "${cliproxyUrl}"\nenv_key = "CLIPROXY_API_KEY"\n[mcp_servers.sidequest]\nurl = "${crew.board.mcp}"\nenabled = true\n[mcp_servers.sidequest.headers]\nAuthorization = "Bearer ${token.access_token}"\n${Object.entries(
        m.mcp,
      )
        .map(([n, url]) => `[mcp_servers.${n}]\nurl = "${url}"\nenabled = true\n`)
        .join('')}`,
      { mode: 0o600 },
    )
  }
  writeFileSync(
    join(harnessHome, '.codex', 'config.toml'),
    `model = "${m.model}"\nmodel_provider = "cliproxy"\nmodel_reasoning_effort = "${m.effort}"\n[model_providers.cliproxy]\nname = "cliproxy"\nbase_url = "${cliproxyUrl}"\nwire_api = "responses"\nenv_key = "CLIPROXY_API_KEY"\nrequires_openai_auth = false\n[mcp_servers.sidequest]\nurl = "${crew.board.mcp}"\nbearer_token_env_var = "SIDEQUEST_MCP_TOKEN"\n${extraMcp}[projects."/crew/agent"]\ntrust_level = "trusted"\n`,
  )
  const grok = join(harnessHome, '.grok')
  own(
    harnessHome,
    join(harnessHome, '.gitconfig'),
    join(harnessHome, '.codex'),
    join(harnessHome, '.codex', 'config.toml'),
    grok,
    join(grok, 'config.toml'),
  )
}

/** The run's whole environment: nothing else from the supervisor reaches the harness. */
function harnessVars(m: Member, token: Token, e: Record<string, string>): Record<string, string> {
  const vars: Record<string, string> = {
    HOME: '/home/agent',
    TERM: 'dumb',
    LANG: 'C.UTF-8',
    PATH: '/opt/bin:/opt/codex/bin:/opt/foundry:/usr/local/bin:/usr/bin:/bin',
    SIDEQUEST_MCP_TOKEN: token.access_token,
    CLIPROXY_API_KEY: cliproxyKey(e),
    GIT_AUTHOR_NAME: m.name,
    GIT_AUTHOR_EMAIL: m.email,
    GIT_COMMITTER_NAME: m.name,
    GIT_COMMITTER_EMAIL: m.email,
  }
  return { ...vars, ...memberEnv(m, e) }
}

/**
 * A member's allowlisted variables: `NAME` is looked up, `NAME=value` is literal, and `NAME=$SOURCE` takes SOURCE's
 * value, so each member can get its own token under the name its tools read (`GH_TOKEN=$CREW_PATCH_GITHUB_TOKEN`). In
 * a bot's container only the resolved NAME is in the env file, hence the fallback.
 */
function memberEnv(m: Member, e: Record<string, string>): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const v of m.env) {
    const at = v.indexOf('=')
    const name = at === -1 ? v : v.slice(0, at)
    const value = at === -1 ? undefined : v.slice(at + 1)
    if (value === undefined) vars[name] = e[name] ?? ''
    else if (value.startsWith('$')) vars[name] = e[value.slice(1)] ?? e[name] ?? ''
    else vars[name] = value
  }
  return vars
}

interface Launch {
  child: ReturnType<typeof spawn>
  stop: () => void
}

/** In a bot's container: the harness as uid 1000 in its own process group, which a timeout ends as a whole. */
function launchHere(command: string[], vars: Record<string, string>): Launch {
  const child = spawn('setpriv', [...DROP, ...command], {
    cwd: '/crew/agent',
    env: vars,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const signal = (name: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, name)
    } catch (error) {
      // ESRCH: the group has already exited. Anything else (EPERM without CAP_KILL) leaves the run alive: say so.
      // SAFETY: process.kill only throws Node system errors, which carry an errno code.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
        console.error(`run ${child.pid}: ${name} failed: ${String(error)}`)
    }
  }
  return {
    child,
    stop: () => {
      signal('SIGTERM')
      setTimeout(() => signal('SIGKILL'), 20_000).unref()
    },
  }
}

/** On the host: a throwaway `sidequest-crew` container per run, as before the bots had containers of their own. */
function launchDocker(id: string, m: Member, command: string[], vars: Record<string, string>): Launch {
  const agent = join(home(id), 'agent')
  const container = `sq-crew-${id}`
  const { cpus, memory } = m.resources ?? crew.harness.resources
  const mounts = [
    `${agent}:/crew/agent`,
    `${join(home(id), 'home')}:/home/agent`,
    `${join(crewDir, 'shared')}:/crew/shared:ro`,
    `${join(repo, 'skill')}:/crew/skill:ro`,
    `${dirname(dirname(bin('codex')))}:/opt/codex:ro`,
    `${dirname(bin('grok'))}:/opt/grok:ro`,
    `${dirname(bin('forge'))}:/opt/foundry:ro`,
    `${bin('bun')}:/opt/bin/bun:ro`,
    `${bin('gh')}:/opt/bin/gh:ro`,
  ]
  const docker = [
    'run',
    '--rm',
    '-i',
    '--network',
    'host',
    '--user',
    '1000:1000',
    '--name',
    container,
    '--cpus',
    String(cpus),
    '--memory',
    memory,
    '--memory-swap',
    memory,
    '--pids-limit',
    '1024',
    '--cpu-shares',
    String(crew.harness.cpuShares),
    ...Object.entries(vars).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...mounts.flatMap((mount) => ['-v', mount]),
    IMAGE,
  ]
  return {
    child: spawn('docker', [...docker, ...command], { stdio: ['ignore', 'pipe', 'pipe'] }),
    stop: () => spawnSync('docker', ['stop', '--time', '20', container], { stdio: 'ignore' }),
  }
}

/** Whether a run of this member is already going: its marker in a container, its throwaway container on the host. */
function busy(id: string): boolean {
  if (!inContainer)
    return spawnSync('docker', ['container', 'inspect', `sq-crew-${id}`], { stdio: 'ignore' }).status === 0
  const marker = join(home(id), 'running')
  return existsSync(marker) && alive(Number(readFileSync(marker, 'utf8')))
}

/** What a run is told: who it is, what to read, its listings, the operator's note for this run. */
async function promptFor(id: string, m: Member, token: Token, note: string): Promise<string> {
  const { services, hash } = await listingsOf(m)
  return [
    // token.agent_id is the hosted agent's key; a member signs work with its ERC-8004 Agent ID, which whoami returns.
    `You are ${m.name}, the '${id}' member of the Sidequest crew and an autonomous hosted worker (hosted-agent key ${token.agent_id}; your public Agent ID is the agentId whoami returns).`,
    'You run in a sandbox container; your working directory is /crew/agent (scratch work in /crew/agent/work, your state in /crew/agent/state).',
    'Read, in this order: /crew/agent/AGENTS.md (your role), /crew/shared/COMMON.md (crew rules) and /crew/skill/worker/SKILL.md (your procedure).',
    'Do one routine pass as COMMON.md describes, then stop.',
    `Your directory listings (one advertise_service call each; listings hash ${hash}): ${JSON.stringify(services)}`,
    note === '' ? '' : `Operator note for this run: ${note}`,
    `Your git identity is ${m.name} <${m.email}>. Chain: ${crew.board.chain} (${crew.board.chainId}). Board: ${crew.board.origin}. Be concise.`,
  ]
    .filter(Boolean)
    .join('\n')
}

async function run(id: string, note = '', model?: string): Promise<number | null> {
  const [, base] = memberOf(id)
  const m = model === undefined ? base : { ...base, model, effort: 'high' }
  // One run per member at a time.
  if (busy(id)) {
    console.log(`${m.name}: still running, skipped`)
    return null
  }
  const token = await freshToken(id)
  const agent = prepareAgentDir(id)
  writeHarnessConfig(m, token, join(home(id), 'home'))
  const prompt = await promptFor(id, m, token, note)
  const vars = harnessVars(m, token, env())
  const runs = join(home(id), 'runs')
  mkdirSync(runs, { recursive: true, mode: 0o700 })
  own(runs)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const grok = inContainer ? `/opt/grok/${process.env.CREW_GROK_BIN ?? 'grok'}` : `/opt/grok/${basename(bin('grok'))}`
  const command =
    m.harness === 'grok'
      ? [grok, '-p', prompt, '--always-approve', '--output-format', 'streaming-json']
      : ['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--json', prompt]
  const { cpus, memory } = m.resources ?? crew.harness.resources
  console.log(`${m.name} (${m.harness ?? 'codex'} ${m.model}, ${cpus} CPU, ${memory}): run ${stamp}`)
  const marker = join(home(id), 'running')
  if (inContainer) writeFileSync(marker, String(process.pid))
  const out = Bun.file(join(runs, `${stamp}.jsonl`)).writer()
  const err: Buffer[] = []
  const { child, stop } = inContainer ? launchHere(command, vars) : launchDocker(id, m, command, vars)
  child.stdout?.on('data', (chunk: Buffer) => out.write(chunk))
  child.stderr?.on('data', (chunk: Buffer) => err.push(chunk))
  const timer = setTimeout(stop, runTimeout(id) * 60_000)
  const code = await new Promise<number | null>((done) => child.on('close', done))
  clearTimeout(timer)
  await out.end()
  rmSync(marker, { force: true })
  writeFileSync(join(runs, `${stamp}.err`), `${Buffer.concat(err).toString()}\nexit ${code}\n`, { mode: 0o600 })
  chmodSync(join(runs, `${stamp}.jsonl`), 0o600)
  own(join(runs, `${stamp}.jsonl`), join(runs, `${stamp}.err`))
  const operator = join(agent, 'state', 'needs-operator')
  if (existsSync(operator)) console.log(`${m.name} needs the operator: ${readFileSync(operator, 'utf8').trim()}`)
  console.log(`${m.name}: exit ${code}`)
  return code
}

/** The sponsor relay's MON: below the floor the board refuses sponsored sends, so a run would only fail. */
const relayMon = (relay: string): Promise<number> => hosted.relayMon(crew.board.rpc, relay)

/** One MCP tool call as the member (JSON-RPC over the board's /mcp; no session needed). */
const mcpCall = <T = unknown>(token: string, name: string, args: Record<string, unknown> = {}): Promise<T> =>
  hosted.mcpCall<T>(crew.board.mcp, token, name, args)

/** When a member last advertised, in ms. Members write ISO 8601 (COMMON.md), but some write Unix seconds or ms. */
function advertisedAt(state: string): number {
  const stamp = existsSync(join(state, 'advertised')) ? readFileSync(join(state, 'advertised'), 'utf8').trim() : ''
  if (/^\d{10}$/.test(stamp)) return Number(stamp) * 1000
  return /^\d{13}$/.test(stamp) ? Number(stamp) : Date.parse(stamp)
}

/** How often a member confirms its listings that have not changed: they last until withdrawn (ADR-0025). */
const LISTING_CONFIRM_MS = 7 * 24 * 3600_000

/**
 * A member's listings as it advertises them: its services, with sample paths on this stage's origin, priced as quotes.
 * `hash` names this exact set, so a member re-advertises when it changes.
 */
async function listingsOf(m: Member): Promise<{ services: Record<string, unknown>[]; hash: string }> {
  const rewardToken = (await protocolInfo()).rewardTokens?.[0]
  const services = (m.services ?? (m.service === undefined ? [] : [m.service])).map((service) => ({
    ...service,
    ...(service.samples === undefined
      ? {}
      : {
          samples: service.samples.map((sample) => ({
            ...sample,
            url: sample.url.startsWith('/') ? crew.board.origin + sample.url : sample.url,
          })),
        }),
    price: { model: 'quote', amountBaseUnits: '0', token: rewardToken },
  }))
  return { services, hash: createHash('sha256').update(JSON.stringify(services)).digest('hex').slice(0, 16) }
}

/** Whether a member's listings are due: never advertised, changed since, or not confirmed for a week. */
function listingDue(state: string, hash: string): boolean {
  const saved = existsSync(join(state, 'listings')) ? readFileSync(join(state, 'listings'), 'utf8').trim() : ''
  return saved !== hash || !(Date.now() - advertisedAt(state) < LISTING_CONFIRM_MS)
}

/**
 * Whether a member has anything to do, read without starting a model: new inbox events past its saved cursor, held
 * work that is not finished, its own jobs past a deadline, or listings that changed or are due for their weekly
 * confirmation. Idle members cost no model tokens.
 */
async function wakeReason(id: string): Promise<string | null> {
  const state = join(home(id), 'agent', 'state')
  // A nudge (crew/bin/publish.ts) is an operator's word that this member should look at something now.
  if (existsSync(join(state, 'nudge'))) return 'nudged'
  if (listingDue(state, (await listingsOf(memberOf(id)[1])).hash)) return 'listing due'
  const token = (await freshToken(id)).access_token
  const inboxWake = await inboxReason(id, token, state)
  if (inboxWake !== null) return inboxWake
  // Held work: jobs this member activated and holds on chain (role holder), whose chain status is not final.
  const held = await hosted.readTaskList<HeldTask>(crew.board.mcp, token, { role: 'holder', limit: 20 })
  const open = openHeld(held)
  if (open.length > 0) return `${open.length} held task(s)`
  // A deadline passing writes nothing on chain, so no event wakes a creator to close a no-show or an undisputed
  // rejection: look for its own jobs whose window has run out.
  const now = Date.now() / 1000
  const created = await hosted.readTaskList<{
    chain?: { status?: string; deliveryDeadline?: number; disputeEndsAt?: number | null }
  }>(crew.board.mcp, token, { role: 'creator', limit: 20 })
  const due = created.filter(
    ({ chain: c }) =>
      (c?.status === 'active' && (c.deliveryDeadline ?? Infinity) < now) ||
      (c?.status === 'rejected-pending' && (c.disputeEndsAt ?? Infinity) < now),
  )
  if (due.length > 0) return `${due.length} own job(s) past a deadline`
  return null
}

/** The wake cursor each member's last check read up to, written once the events behind it are dealt with. */
const wakeCursors = new Map<string, string>()

/** Idle checks acknowledge filtered events; successful model runs copy only the worker's processed checkpoint. */
function commitWakeCursor(id: string, code?: number | null) {
  const cursor = wakeCursors.get(id)
  if (cursor === undefined) return
  const path = join(home(id), 'agent', 'state', 'wake-cursor')
  finishWake(path, cursor, code)
  own(path, `${path}.bak`)
  wakeCursors.delete(id)
}

/** A public offer as the board lists it: a quote request, or an open job. */
interface Offer {
  title?: string
  brief?: string
  tags?: string[]
}

/** Whether an offer fits a member: one of its tags, or one of its words in the title or brief. */
function fits(m: Member, request: Offer): boolean {
  if (m.fit === undefined) return true
  const text = `${request.title ?? ''} ${request.brief ?? ''}`.toLowerCase()
  return (
    (request.tags ?? []).some((tag) => m.fit?.tags.includes(tag) === true) ||
    m.fit.keywords.some((word) => text.includes(word))
  )
}

/** The member's own ERC-8004 agent id, from whoami: a member never wakes for a job it posted itself. */
const ownAgentIds = new Map<string, string>()
async function ownAgentId(id: string, token: string): Promise<string> {
  const known = ownAgentIds.get(id)
  if (known !== undefined) return known
  const me = await mcpCall<{ agentId?: string | number }>(token, 'whoami')
  if (me.agentId === undefined) throw new Error(`${id}: whoami named no agent`)
  ownAgentIds.set(id, String(me.agentId))
  return String(me.agentId)
}

/**
 * The offers that fit a member: open quote requests, and jobs opened for applications (published, not from a picked
 * quote) that another agent posted. New jobs are the index's newest, so its first page holds them.
 */
async function fittingOffers(id: string, m: Member, token: string, { requests, jobs }: Offers): Promise<number> {
  const quoteRequests =
    requests.size === 0 ? [] : await mcpCall<Array<Offer & { requestId: string }>>(token, 'list_quote_requests', {})
  const openJobs =
    jobs.size === 0
      ? []
      : await mcpCall<Array<Offer & { taskId: string; quoted?: boolean; creatorAgentId?: string | null }>>(
          token,
          'task_index',
          { limit: 50 },
        )
  const me = jobs.size === 0 ? undefined : await ownAgentId(id, token)
  return (
    quoteRequests.filter((r) => requests.has(r.requestId) && fits(m, r)).length +
    openJobs.filter((t) => jobs.has(t.taskId) && t.quoted !== true && (t.creatorAgentId ?? '') !== me && fits(m, t))
      .length
  )
}

/**
 * Inbox events past the member's wake cursor, as a reason to wake: its own events always, but a public offer (every
 * request and open job reaches every inbox) only when it fits, so the crew doesn't all run for each new one.
 */
async function inboxReason(id: string, token: string, state: string): Promise<string | null> {
  const [, m] = memberOf(id)
  wakeCursors.delete(id)
  const result = await wakeInbox(
    state,
    (cursor) => hosted.inboxAfter(crew.board.mcp, token, cursor),
    (offers) => fittingOffers(id, m, token, offers),
  )
  if (result.cursor !== undefined) wakeCursors.set(id, result.cursor)
  return result.reason
}

let info: { rewardTokens?: string[] } | undefined
async function protocolInfo() {
  info ??= (
    (await (
      await fetch(`${crew.board.origin}/api/protocol_info`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).json()) as { result: { rewardTokens?: string[] } }
  ).result
  return info
}

/** Model runs this UTC day: run logs are named by their start time (`runs/<ISO>.jsonl`). */
function runsToday(id: string): number {
  const dir = join(home(id), 'runs')
  if (!existsSync(dir)) return 0
  const day = new Date().toISOString().slice(0, 10)
  return readdirSync(dir).filter((f) => f.startsWith(day) && f.endsWith('.jsonl')).length
}

/** How a member is connected: its token where this process can read it, else the container that holds it. */
function connection(id: string, now: number): string {
  if (!inContainer && existsSync(join(home(id), 'secrets')))
    return `connected in ${bot(id)} (${botRunning(id) ? 'up' : 'down'})`
  const t = readToken(secretPath(id, 'token.json'))
  if (t === undefined) return 'not connected'
  const left = t.expires_at - now
  return `agent ${t.agent_id}, token ${left > 0 ? `valid ${Math.round(left / 60)} min` : 'expired (refreshes on run)'}`
}

function status() {
  const now = Math.floor(Date.now() / 1000)
  for (const [id, m] of Object.entries(crew.members)) {
    const runs = existsSync(join(home(id), 'runs'))
      ? readdirSync(join(home(id), 'runs'))
          .filter((f) => f.endsWith('.jsonl'))
          .toSorted()
      : []
    const operator = join(home(id), 'agent', 'state', 'needs-operator')
    console.log(
      [
        `${m.name.padEnd(6)} ${id.padEnd(6)} ${m.model.padEnd(20)} ${m.operator.padEnd(5)}`,
        m.enabled ? '' : 'paused',
        connection(id, now),
        runs.length === 0 ? 'never run' : `last run ${runs.at(-1)!.replace('.jsonl', '')}`,
        existsSync(operator) ? 'NEEDS OPERATOR' : '',
      ]
        .filter(Boolean)
        .join(' · '),
    )
  }
}

interface Slot {
  take: () => Promise<void>
  give: () => void
}

/** The crew-wide cap on runs at once, for members looping in this one process (`loop`). */
function processSlot(): Slot {
  let running = 0
  return {
    take: async () => {
      while (running >= crew.harness.maxParallel) await Bun.sleep(5_000)
      running++
    },
    give: () => {
      running--
    },
  }
}

/**
 * The same cap across the bots' containers: slot directories in `.slots`, which every container mounts. A slot older
 * than the longest run is one a container left behind when it stopped mid-run.
 */
function fileSlot(id: string): Slot {
  const dir = join(stateRoot, '.slots')
  const stale = (runTimeout(id) + 10) * 60_000
  let held: string | null = null
  const claim = (path: string) => {
    try {
      mkdirSync(path)
      writeFileSync(join(path, 'owner'), id)
      return true
    } catch {
      const age = Date.now() - (statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Date.now())
      if (age > stale) rmSync(path, { recursive: true, force: true })
      return false
    }
  }
  // Slots this member held when its container last stopped are free again.
  for (const slot of existsSync(dir) ? readdirSync(dir) : []) {
    const owner = join(dir, slot, 'owner')
    if (existsSync(owner) && readFileSync(owner, 'utf8') === id)
      rmSync(join(dir, slot), { recursive: true, force: true })
  }
  return {
    take: async () => {
      mkdirSync(dir, { recursive: true })
      for (;;) {
        for (let i = 0; i < crew.harness.maxParallel && held === null; i++)
          if (claim(join(dir, String(i)))) held = join(dir, String(i))
        if (held !== null) return
        await Bun.sleep(5_000)
      }
    },
    give: () => {
      if (held !== null) rmSync(held, { recursive: true, force: true })
      held = null
    },
  }
}

/**
 * One run, started for a reason. A nudge's text becomes its operator note and is set aside as the run starts, so it
 * acts once; a run that did not start (one already going) puts it back for the next pass.
 */
async function wake(id: string, reason: string, model: string | undefined): Promise<number | null> {
  const nudgePath = join(home(id), 'agent', 'state', 'nudge')
  const nudge = existsSync(nudgePath) ? readFileSync(nudgePath, 'utf8').trim() : ''
  if (nudge !== '') renameSync(nudgePath, `${nudgePath}.${Date.now()}`)
  console.log(`${crew.members[id]?.name ?? id}: waking, ${reason}${model === undefined ? '' : ` (on ${model})`}`)
  const code = await run(id, nudge, model)
  if (code === null && nudge !== '') appendFileSync(nudgePath, `${nudge}\n`)
  return code
}

/** Why a member should not wake although it has a reason: the relay's gas or its daily run cap. */
async function holdReason(id: string, m: Member, reason: string): Promise<string | null> {
  // A stage without a relay (mainnet, ADR-0023) pays gas in USDC from the operator's gas allowance: no relay guard.
  if (crew.board.relay !== undefined) {
    // Fail closed: an unreadable relay balance is treated as empty.
    const relay = await relayMon(crew.board.relay).catch(() => 0)
    if (relay < crew.harness.relayFloorMon)
      return `${m.name}: ${reason}, but the relay holds ${relay} MON (floor ${crew.harness.relayFloorMon}); not waking`
  }
  const today = runsToday(id)
  if (today >= crew.harness.maxRunsPerDay)
    return `${m.name}: ${reason}, but it already ran ${today} times today (cap ${crew.harness.maxRunsPerDay})`
  return null
}

/** A member's routine, forever: check for work, wake when there is a reason and nothing holds it back, sleep. */
async function memberLoop(id: string, m: Member, minutes: number, slot: Slot) {
  let failures = 0
  for (;;) {
    let reason: string | null = null
    try {
      wakeCursors.delete(id)
      reason = await wakeReason(id)
      if (reason === null) {
        console.log(`${m.name}: idle`)
        commitWakeCursor(id)
      }
    } catch (error) {
      // A failed check is not a reason to spend a model run; the next pass checks again.
      console.log(`${m.name}: wake check failed (${String(error).slice(0, 80)}); not waking`)
    }
    const blocked = reason === null ? null : await holdReason(id, m, reason)
    if (blocked !== null) console.log(blocked)
    else if (reason !== null) {
      await slot.take()
      try {
        const code = await wake(id, reason, failures >= crew.harness.fallbackAfter ? m.fallbackModel : undefined)
        if (code !== null) {
          failures = code === 0 ? 0 : failures + 1
          commitWakeCursor(id, code)
        }
      } catch (error) {
        failures++
        console.error(`${id}: ${String(error)}`)
      } finally {
        slot.give()
      }
    }
    await Bun.sleep(minutes * 60_000)
  }
}

/** A bot's container runs this: its own routine every `minutes`, within the run cap it shares with the others. */
async function serve(id: string, minutes: number) {
  const [, m] = memberOf(id)
  console.log(
    `${m.name}: serving ${crew.board.origin} every ${minutes} min (crew-wide cap ${crew.harness.maxParallel})`,
  )
  // A run marker left when the container last stopped names that container's supervisor pid, which this supervisor
  // reuses (both are pid 7), so it would read as a run in progress forever. No run outlives its container.
  rmSync(join(home(id), 'running'), { force: true })
  await memberLoop(id, m, minutes, fileSlot(id))
}

/** Moves a member's OAuth files into `secrets/` (root-only) for its container and records its hosted agent's key. */
function containerize(id: string) {
  memberOf(id)
  const script = [
    'set -e',
    'cd /m',
    'if [ -f token.json ]; then jq -r .agent_id token.json > agent-key; fi',
    'mkdir -p secrets',
    'for f in token.json client.json login.json; do if [ -f "$f" ]; then mv "$f" secrets/; fi; done',
    'chown -R 0:0 secrets',
    'chmod 700 secrets',
    'find secrets -type f -exec chmod 600 {} +',
  ].join('; ')
  const moved = spawnSync(
    'docker',
    ['run', '--rm', '--user', '0:0', '--network', 'none', '-v', `${home(id)}:/m`, IMAGE, 'sh', '-c', script],
    { stdio: 'inherit' },
  )
  if (moved.status !== 0) throw new Error(`${id}: its OAuth files could not be moved`)
  console.log(`${id}: OAuth files are root-only in ${join(home(id), 'secrets')}; start it with "up ${id}"`)
}

/** The source a container runs: a `git archive` of this commit, so editing the working tree never changes a bot. */
function snapshot(): { sha: string; source: string } {
  const sha = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const source = join(repo, '.crew', 'source', sha)
  if (!existsSync(source)) {
    mkdirSync(source, { recursive: true })
    const tar = spawnSync(
      'bash',
      ['-c', `git -C "$0" archive "$1" crew infra skill | tar -x -C "$2"`, repo, sha, source],
      {
        stdio: 'inherit',
      },
    )
    if (tar.status !== 0) throw new Error('could not snapshot the crew source')
  }
  return { sha, source }
}

interface Mounts {
  sha: string
  source: string
  codex: string
  grok: string
  forge: string
  bun: string
  gh: string
}

/** One bot's compose service: its env file (0600, only the variables its member lists), limits, labels and mounts. */
function botService(id: string, m: Member, e: Record<string, string>, at: Mounts, agentId: string) {
  const envFile = join(ENV_DIR, `${id}.env`)
  const vars = [
    `CLIPROXY_API_KEY=${cliproxyKey(e)}`,
    ...Object.entries(memberEnv(m, e)).map(([name, value]) => `${name}=${value}`),
  ]
  writeFileSync(envFile, `${vars.join('\n')}\n`, { mode: 0o600 })
  chmodSync(envFile, 0o600)
  const keyFile = join(home(id), 'agent-key')
  const agentKey = existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : ''
  const { cpus, memory } = m.resources ?? crew.harness.resources
  const state = home(id)
  return {
    image: IMAGE,
    container_name: bot(id),
    user: '0:0',
    init: true,
    restart: 'unless-stopped',
    working_dir: '/crew/src',
    command: ['bun', '/crew/src/crew/bin/crew.ts', 'serve', id, String(crew.harness.loopMinutes)],
    env_file: [envFile],
    environment: {
      CREW_IN_CONTAINER: '1',
      CREW_STATE_ROOT: '/crew/state',
      CREW_STAGE: crew.board.stage,
      CREW_GROK_BIN: basename(at.grok),
    },
    cpus,
    mem_limit: memory,
    memswap_limit: memory,
    pids_limit: 1024,
    cpu_shares: crew.harness.cpuShares,
    security_opt: ['no-new-privileges:true'],
    cap_drop: ['ALL'],
    // KILL lets the root supervisor end a timed-out run, which runs as uid 1000.
    cap_add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID', 'KILL'],
    networks: ['crew'],
    stop_grace_period: '30s',
    labels: {
      'sidequest.agent.id': agentId,
      'sidequest.agent.key': agentKey,
      'sidequest.agent.name': m.name,
      'sidequest.agent.member': id,
      'sidequest.agent.harness': m.harness ?? 'codex',
      'sidequest.agent.model': m.model,
      'sidequest.agent.profile': agentId === '' ? '' : `${crew.board.origin}/agent/${agentId}`,
      'sidequest.board': crew.board.origin,
      'sidequest.source': at.sha,
    },
    volumes: [
      `${state}:/crew/state/${id}`,
      `${join(stateRoot, '.slots')}:/crew/state/.slots`,
      `${join(state, 'agent')}:/crew/agent`,
      `${join(state, 'home')}:/home/agent`,
      `${at.source}:/crew/src:ro`,
      `${join(at.source, 'crew', 'shared')}:/crew/shared:ro`,
      `${join(at.source, 'skill')}:/crew/skill:ro`,
      `${at.codex}:/opt/codex:ro`,
      `${dirname(at.grok)}:/opt/grok:ro`,
      `${at.forge}:/opt/foundry:ro`,
      `${at.bun}:/opt/bin/bun:ro`,
      `${at.gh}:/opt/bin/gh:ro`,
    ],
  }
}

/** The crew's ERC-8004 Agent IDs by name, from the board's directory (a token names only the hosted agent's key). */
async function agentIds(): Promise<Map<string, string>> {
  const res = await fetch(`${crew.board.origin}/data/directory`).catch(() => undefined)
  const body: { agents?: Array<{ agentId: string; profile: { name: string } }> } =
    res?.ok === true ? await res.json() : {}
  return new Map((body.agents ?? []).map((agent) => [agent.profile.name, agent.agentId]))
}

/** Writes the crew's compose file, one always-on container per connected member, and starts it (or just `only`). */
async function up(only: string[]) {
  const e = env()
  const grok = bin('grok')
  const at: Mounts = {
    ...snapshot(),
    codex: dirname(dirname(bin('codex'))),
    grok,
    forge: dirname(bin('forge')),
    bun: bin('bun'),
    gh: bin('gh'),
  }
  mkdirSync(join(stateRoot, '.slots'), { recursive: true })
  mkdirSync(ENV_DIR, { recursive: true, mode: 0o700 })
  const members = Object.entries(crew.members).filter(([id, m]) => m.enabled && existsSync(join(home(id), 'secrets')))
  const ids = await agentIds()
  const services = Object.fromEntries(
    members.map(([id, m]) => [bot(id), botService(id, m, e, at, ids.get(m.name) ?? '')]),
  )
  writeFileSync(COMPOSE, json({ name: PROJECT, services, networks: { crew: { name: PROJECT } } }))
  const started = spawnSync('docker', ['compose', '-f', COMPOSE, 'up', '-d', '--remove-orphans', ...only.map(bot)], {
    stdio: 'inherit',
  })
  process.exitCode = started.status ?? 1
}

const compose = (...args: string[]) => spawnSync('docker', ['compose', '-f', COMPOSE, ...args], { stdio: 'inherit' })

const [command, a, b] = process.argv.slice(2)
// On the host, a containerized member's commands run in its container: only there is its refresh token readable.
const relayed = !inContainer && ['login', 'run', 'wake', 'call'].includes(command ?? '') && a !== undefined
if (relayed && existsSync(join(home(a), 'secrets'))) {
  if (!botRunning(a)) throw new Error(`${a} runs in ${bot(a)}, which is not up; start it with "up ${a}"`)
  const inside = spawnSync('docker', ['exec', bot(a), 'bun', '/crew/src/crew/bin/crew.ts', ...process.argv.slice(2)], {
    stdio: 'inherit',
  })
  process.exit(inside.status ?? 1)
}
if (command === 'login') await login(a!, b)
else if (command === 'run') await run(memberOf(a)[0], b)
else if (command === 'status') status()
else if (command === 'wake') console.log((await wakeReason(memberOf(a)[0])) ?? 'idle')
// One tool call as a member, for an operator's probe: reads, or writes with the operationKey in the JSON.
else if (command === 'call')
  console.log(
    JSON.stringify(
      await mcpCall((await freshToken(memberOf(a)[0])).access_token, b!, JSON.parse(process.argv[5] ?? '{}')),
      null,
      2,
    ),
  )
else if (command === 'serve') await serve(memberOf(a)[0], Number(b ?? crew.harness.loopMinutes))
else if (command === 'containerize') containerize(memberOf(a)[0])
else if (command === 'up') await up(process.argv.slice(3))
else if (command === 'down') compose('down')
else if (command === 'logs')
  spawnSync('docker', ['logs', '--tail', '100', '-f', bot(memberOf(a)[0])], { stdio: 'inherit' })
else if (command === 'loop') {
  // Each enabled, connected member loops on its own (start staggered), at most maxParallel runs at once.
  const minutes = Number(a ?? 15)
  const slot = processSlot()
  const members = Object.entries(crew.members).filter(
    ([id, m]) => m.enabled && existsSync(secretPath(id, 'token.json')),
  )
  console.log(
    `crew loop: ${members.map(([, m]) => m.name).join(', ')} every ${minutes} min, at most ${crew.harness.maxParallel} at once`,
  )
  await Promise.all(
    members.map(async ([id, m], i) => {
      await Bun.sleep(i * 30_000)
      await memberLoop(id, m, minutes, slot)
    }),
  )
} else {
  console.error(
    'usage: crew.ts login <member> [url] | run <member> [note] | loop [minutes] | status | wake <member> | call <member> <tool> [json]\n' +
      '       crew.ts containerize <member> | up [member…] | down | logs <member> | serve <member> [minutes] (in its container)',
  )
  process.exit(2)
}
