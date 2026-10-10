#!/usr/bin/env bun
/**
 * Overnight activity, the publisher side, as hosted agents: each persona (crew/hirers/personas.json) is a Sidequest
 * hosted agent its operator created on the site, connected over MCP with OAuth like any hiring agent. Its operator
 * pays its hires through a weekly budget and backs it with SIDE for the deposits; Sidequest's executor signs and its
 * relay pays the gas. What the persona thinks (posts, quote choice, reviews) is hirer-mind.ts, shared with the REST
 * hirers (hirers.ts).
 *
 *   bun crew/bin/hosted-hirers.ts login <persona> [landed address|--stdin]   connect, as crew.ts login does
 *   bun crew/bin/hosted-hirers.ts call <persona> <tool> [json]              one tool call, for a probe
 *   bun crew/bin/hosted-hirers.ts status                                    each persona's connection and jobs
 *   bun crew/bin/hosted-hirers.ts once <persona> [--post]                   one tick for one persona (and a post)
 *   bun crew/bin/hosted-hirers.ts run                                       the loop (container sq-hirers)
 *
 * Every write carries an operationKey saved with its arguments before the call (`hq1-<persona>-<n>-<step>`), so a
 * restart or a lost reply calls again with the same key and gets the original result: the board's operation
 * journal is the transaction journal.
 *
 * Env: MONAD_RPC_URL, HOSTED_ROOT (the personas' OAuth files, default .crew/activity/hosted), CLIPROXY_URL and
 * CLIPROXY_API_KEY_CREW (else CLIPROXY_API_KEY), ACTIVITY_MODEL, ACTIVITY_STATE, ACTIVITY_MAX_JOBS (posts in all),
 * ACTIVITY_POST_MINUTES (mean gap), ACTIVITY_INVITE_RATE (0.35), ACTIVITY_RELAY_FLOOR (3 MON).
 */
import dev from '../../infra/dev.json' with { type: 'json' }
import { now, pick, sleep } from './activity.ts'
import { personas } from './hirer-mind.ts'
import {
  type Whoami,
  HostedHirer,
  MAX_OPEN,
  SCOPES,
  SPEND_CAP,
  board,
  call,
  filesOf,
  identify,
  personaOf,
  post,
  tick,
} from './hosted-hirer.ts'
import * as hosted from './hosted-mcp.ts'

const MAX_JOBS = Number(process.env.ACTIVITY_MAX_JOBS ?? 12)
const POST_MINUTES = Number(process.env.ACTIVITY_POST_MINUTES ?? 20)
const RELAY_FLOOR = Number(process.env.ACTIVITY_RELAY_FLOOR ?? 3)

async function readStdin(): Promise<string> {
  let text = ''
  for await (const chunk of process.stdin) text += String(chunk)
  return text.trim()
}

/** Connects a persona: prints the consent address, then finishes with the address its operator's browser landed on. */
async function login(id: string, landed?: string) {
  const p = personaOf(id)
  if (landed === undefined || landed === '--stdin') {
    const url = await hosted.beginLogin(board, filesOf(id), {
      clientName: `Sidequest hirer: ${p.name}`,
      scopes: SCOPES,
    })
    console.log(url)
    if (landed === undefined) {
      console.error(`Open it signed in as ${p.name}'s operator, pick its agent and approve; then, within 2 minutes:`)
      console.error(`  bun crew/bin/hosted-hirers.ts login ${id} '<the ${hosted.REDIRECT}?code=… address>'`)
      return
    }
    landed = await readStdin()
  }
  const t = await hosted.finishLogin(board, filesOf(id), landed)
  console.log(`${p.name} connected as agent ${t.agent_id} with ${t.scope}`)
}

/** The next poster: the maker first, so the 3D ask is on the board from the start; then any connected persona with room. */
function nextPoster(hirers: HostedHirer[]): HostedHirer | undefined {
  const ready = hirers.filter(
    (h) =>
      h.data.me !== undefined && h.data.disconnected !== true && h.open.length < MAX_OPEN && h.data.spent < SPEND_CAP,
  )
  const maker = ready.find((h) => h.persona.always === '3d' && h.data.jobs.length === 0)
  return maker ?? pick(ready)
}

/** Hosted writes spend the relay's gas: below the floor nothing new is posted, and open jobs carry on. */
const relayLow = async () =>
  (await hosted.relayMon(process.env.MONAD_RPC_URL ?? '', dev.relay).catch(() => 0)) < RELAY_FLOOR

async function loop() {
  const hirers = personas.map((p) => new HostedHirer(p))
  const posted = () => hirers.reduce((n, h) => n + h.data.jobs.length, 0)
  let nextPost = now()
  for (;;) {
    for (const h of hirers) await tick(h)
    const due = posted() < MAX_JOBS && now() >= nextPost
    const poster = due && !(await relayLow()) ? nextPoster(hirers) : undefined
    if (poster !== undefined) {
      await post(poster, posted()).catch((error: unknown) =>
        poster.log('post-error', { message: String(error).slice(0, 300) }),
      )
      // Exponential gaps around the mean, kept between 6 and 45 minutes.
      const gap = Math.min(45, Math.max(6, -Math.log(1 - Math.random()) * POST_MINUTES))
      nextPost = now() + Math.round(gap * 60)
    }
    await sleep(120_000)
  }
}

/** One tick for one persona, and a post first when asked: a probe for a single persona on the live board. */
async function once(id: string, withPost: boolean) {
  const h = new HostedHirer(personaOf(id))
  if (withPost) {
    if (!(await identify(h))) throw new Error(`${id} is not connected`)
    await post(h, h.data.jobs.length)
  }
  await tick(h)
  for (const job of h.data.jobs.slice(-3)) console.log(`${job.key} ${job.step} ${job.outcome ?? ''} ${job.title}`)
}

async function status() {
  for (const p of personas) {
    const jobs = new HostedHirer(p).data.jobs
    const invited = jobs.filter((job) => job.invite !== undefined).length
    console.log(`${p.id} ${p.name}: ${jobs.length} posted, ${invited} with an invite`)
    for (const job of jobs.slice(-5)) console.log(`  ${job.key} ${job.step} ${job.outcome ?? ''} ${job.title}`)
    if (hosted.readToken(filesOf(p.id).token) === undefined) {
      console.log(`  not connected`)
      continue
    }
    try {
      const me = await call<Whoami>(p.id, 'whoami')
      const agent = await call<{ allowances?: unknown }>(p.id, 'agent_status')
      console.log(`${p.id} ${p.name}: agent ${me.agentId ?? '?'} ${me.address ?? '?'}`)
      console.log(`  ${JSON.stringify(agent.allowances ?? null).slice(0, 300)}`)
    } catch (error) {
      console.log(`${p.id} ${p.name}: ${String(error).slice(0, 200)}`)
    }
  }
}

const [command, a, b] = process.argv.slice(2)
if (command === 'login') await login(personaOf(a).id, b)
else if (command === 'call' && b !== undefined) {
  const args: Record<string, unknown> = JSON.parse(process.argv[5] ?? '{}')
  console.log(JSON.stringify(await call(personaOf(a).id, b, args), null, 2))
} else if (command === 'status') await status()
else if (command === 'once') await once(personaOf(a).id, b === '--post')
else if (command === 'run') await loop()
else
  console.log(
    'usage: bun crew/bin/hosted-hirers.ts login <persona> [address|--stdin] | call <p> <tool> [json] | status | once <p> [--post] | run',
  )
