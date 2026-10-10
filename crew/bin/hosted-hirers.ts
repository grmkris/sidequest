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
 *   bun crew/bin/hosted-hirers.ts status                                    each persona's connection and budget
 *
 * Env: MONAD_RPC_URL, HOSTED_ROOT (the personas' OAuth files, default .crew/activity/hosted), CLIPROXY_URL and
 * CLIPROXY_API_KEY_CREW (else CLIPROXY_API_KEY), ACTIVITY_MODEL, ACTIVITY_STATE.
 */
import { join, resolve } from 'node:path'
import { origin } from './activity.ts'
import { type Persona, personas } from './hirer-mind.ts'
import * as hosted from './hosted-mcp.ts'

const board: hosted.Board = { origin, mcp: `${origin}/mcp` }
const SCOPES = 'sidequest:read sidequest:hire'
const hostedRoot = process.env.HOSTED_ROOT ?? resolve(import.meta.dirname, '../../.crew/activity/hosted')

/** A persona's OAuth files: its own directory under HOSTED_ROOT, owner-only. */
export const filesOf = (id: string): hosted.ConnectionFiles => ({
  client: join(hostedRoot, id, 'client.json'),
  login: join(hostedRoot, id, 'login.json'),
  token: join(hostedRoot, id, 'token.json'),
  lock: join(hostedRoot, id, 'token.lock'),
})

export function personaOf(id: string | undefined): Persona {
  const p = personas.find((candidate) => candidate.id === id)
  if (p === undefined) throw new Error(`persona must be one of: ${personas.map((c) => c.id).join(', ')}`)
  return p
}

/** One tool call as the persona's hosted agent, with a token good for at least five minutes. */
export async function call<T>(id: string, tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const token = await hosted.freshToken(board, filesOf(id), 300, id)
  return hosted.mcpCall<T>(board.mcp, token.access_token, tool, args)
}

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

interface Whoami {
  address?: string
  agentId?: string
}

async function status() {
  for (const p of personas) {
    if (hosted.readToken(filesOf(p.id).token) === undefined) {
      console.log(`${p.id} ${p.name}: not connected`)
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
if (import.meta.main) {
  if (command === 'login') await login(personaOf(a).id, b)
  else if (command === 'call' && b !== undefined) {
    const args: Record<string, unknown> = JSON.parse(process.argv[5] ?? '{}')
    console.log(JSON.stringify(await call(personaOf(a).id, b, args), null, 2))
  } else if (command === 'status') await status()
  else
    console.log(
      'usage: bun crew/bin/hosted-hirers.ts login <persona> [address|--stdin] | call <p> <tool> [json] | status',
    )
}
