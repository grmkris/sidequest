#!/usr/bin/env bun
/**
 * Sets up the crew's hosted hirers (crew/bin/hosted-hirers.ts) through the real site, as their operators would. Each
 * operator in crew/hirers/personas.json is a Privy account that signs in by email, claims testnet tokens on /welcome,
 * creates its personas' agents, backs each one with SIDE and connects each over OAuth with a weekly budget. Every step
 * first reads what the board and the chain already say, so running it again does nothing twice.
 *
 *   bun packages/sdk/scripts/live/operators.ts <operator> login             sign in; the emailed code goes in <dir>/otp
 *   bun packages/sdk/scripts/live/operators.ts <operator> fund              the daily testnet faucet, on /welcome
 *   bun packages/sdk/scripts/live/operators.ts <operator> agent <persona>   create the persona's agent
 *   bun packages/sdk/scripts/live/operators.ts <operator> back <persona>    the operator's SIDE behind it
 *   bun packages/sdk/scripts/live/operators.ts <operator> connect <persona> a weekly budget, then the OAuth connection
 *   bun packages/sdk/scripts/live/operators.ts <operator> all               every step, for each of its personas
 *
 * <dir> is OPERATORS_ROOT/<operator> (default .crew/operators/<operator>, owner-only). It holds the Chromium profile, a
 * screenshot when a step stalls, `otp` (the handoff: while login waits, write the emailed code there), `modals.log`
 * (the text of every Privy prompt confirmed) and `done.json` (the budgets signed). Env: MONAD_TESTNET_RPC_URL,
 * P8_ORIGIN (dev by default), HOSTED_ROOT (where connect saves the persona's tokens), PLAYWRIGHT_CHROMIUM_PATH.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { type Address, erc20Abi, formatUnits, getAddress, parseUnits } from 'viem'
import config from '../../../../crew/hirers/personas.json' with { type: 'json' }
import * as sdk from '../../src/index.ts'
import { HostedBrowser, type ManagedAgent } from './deployed/browser.ts'
import { ORIGIN, authorizationUrl, required } from './deployed/guards.ts'
import { confirmGrant } from './deployed/signing.ts'

type Operator = (typeof config.operators)[keyof typeof config.operators]
type Persona = (typeof config.personas)[number]
type ReadyAgent = ManagedAgent & { address: Address; agent_id: string }

const REPO = resolve(import.meta.dirname, '../../../..')
const ROOT = process.env.OPERATORS_ROOT ?? join(REPO, '.crew/operators')
const MUSD = getAddress('0x6B56D64150818f91f5112B285e806ec6C78EADe8')
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** The buttons that confirm a prompt in Privy's modal, and the site's own confirm for prepared transactions. */
const PRIVY_CONFIRM = /^(Approve|Confirm|Sign and continue|Sign|Send|Submit)$/
const SITE_CONFIRM =
  /^(Confirm in your wallet|Confirm step \d+ of \d+|Confirm all \d+ as one transaction|Send · Sidequest pays the gas)$/

class Session {
  readonly dir: string
  readonly browser: HostedBrowser
  readonly ctx = sdk.context('monad-testnet', 'main', required('MONAD_TESTNET_RPC_URL'))
  operator: Address | undefined

  constructor(
    readonly name: string,
    readonly op: Operator,
  ) {
    this.dir = join(ROOT, name)
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    this.browser = new HostedBrowser({ directory: this.dir })
  }

  get page() {
    return this.browser.page
  }

  get wallet(): Address {
    if (this.operator === undefined) throw new Error('OPERATOR_NOT_SIGNED_IN')
    return this.operator
  }

  /** Steps finished that the site cannot show again (a budget signed), so a rerun skips them. */
  done(key: string, value?: true): boolean {
    const file = join(this.dir, 'done.json')
    // SAFETY: only this script writes done.json, as an object of step keys.
    const saved = (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}) as Record<string, true>
    if (value !== undefined) writeFileSync(file, `${JSON.stringify({ ...saved, [key]: value }, null, 2)}\n`)
    return saved[key] === true || value === true
  }

  async shot(label: string) {
    await this.page.screenshot({ path: join(this.dir, `${label}.png`), fullPage: true }).catch(() => undefined)
  }
}

/** The emailed code, from <dir>/otp: whoever reads the inbox writes it there while this waits. */
async function emailedCode(s: Session): Promise<string> {
  const file = join(s.dir, 'otp')
  console.log(`Privy sent a code to ${s.op.email}; write it to ${file}`)
  for (const end = Date.now() + 15 * 60_000; Date.now() < end; await sleep(2000)) {
    if (!existsSync(file)) continue
    const code = readFileSync(file, 'utf8').trim()
    rmSync(file)
    if (/^\d{6}$/.test(code)) return code
    console.log(`${file} did not hold a 6-digit code; waiting for another`)
  }
  throw new Error('OPERATOR_OTP_TIMEOUT')
}

/** Signs in with the persisted session, or by email when it has expired. */
async function login(s: Session) {
  await s.browser.start()
  rmSync(join(s.dir, 'otp'), { force: true })
  s.operator = await s.browser.login({ email: s.op.email, otp: () => emailedCode(s) })
  console.log(`${s.name}: signed in as ${s.operator}`)
}

/**
 * Presses on until `done`: confirms each Privy prompt (its text logged to modals.log first) and the site's next
 * confirm for prepared transactions. A failed send stops here with a screenshot; the site's journal reconciles it.
 */
async function drive(s: Session, label: string, done: () => Promise<boolean>, minutes = 5) {
  const modal = s.page.locator('#privy-modal-content')
  const failed = s.page.getByRole('button', { name: 'Try again', exact: true })
  for (const end = Date.now() + minutes * 60_000; !(await done()); await sleep(1500)) {
    if (Date.now() > end || (await failed.isVisible())) {
      await s.shot(`${label}-stalled`)
      throw new Error(`OPERATOR_STEP_STALLED: ${label} (see ${join(s.dir, `${label}-stalled.png`)})`)
    }
    const confirm = modal.getByRole('button', { name: PRIVY_CONFIRM }).last()
    if (await confirm.isVisible()) {
      appendFileSync(join(s.dir, 'modals.log'), `${new Date().toISOString()} ${label}\n${await modal.innerText()}\n\n`)
      await confirm.click()
      continue
    }
    const next = s.page.getByRole('button', { name: SITE_CONFIRM }).first()
    if ((await next.isVisible()) && (await next.isEnabled())) await next.click()
  }
}

const balance = (s: Session, token: Address) =>
  s.ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [s.wallet] })

/** Testnet tokens from the faucet on /welcome, unless the wallet already holds MON, SIDE and mUSD. */
async function fund(s: Session) {
  const funded = async () => {
    const [mon, side, musd] = await Promise.all([
      s.ctx.publicClient.getBalance({ address: s.wallet }),
      balance(s, s.ctx.deployment.factory),
      balance(s, MUSD),
    ])
    return mon > 0n && side > 0n && musd > 0n
  }
  if (!(await funded())) {
    await s.page.goto(`${ORIGIN}/welcome`, { waitUntil: 'domcontentloaded' })
    await s.page.getByRole('button', { name: 'Get test tokens', exact: true }).click({ timeout: 60_000 })
    await drive(s, 'fund', funded)
  }
  const side = await balance(s, s.ctx.deployment.factory)
  console.log(`${s.name}: funded, ${formatUnits(side, 18)} SIDE`)
}

async function agents(s: Session): Promise<ManagedAgent[]> {
  return (await s.browser.api<{ agents: ManagedAgent[] }>('/api/agents')).agents
}

const ready = (a: ManagedAgent | undefined): a is ReadyAgent =>
  a?.state === 'active' && a.address !== null && a.agent_id !== null

async function agentOf(s: Session, p: Persona): Promise<ReadyAgent> {
  const found = (await agents(s)).find((a) => a.name === p.name)
  if (!ready(found)) throw new Error(`${p.name} has no agent yet: run \`agent ${p.id}\` first`)
  return found
}

/** The persona's agent: created on /welcome while that step is open, on /agents/new after, resumed if half made. */
async function agent(s: Session, p: Persona): Promise<void> {
  const existing = (await agents(s)).find((a) => a.name === p.name)
  if (existing === undefined) {
    await s.page.goto(`${ORIGIN}/welcome`, { waitUntil: 'domcontentloaded' })
    const name = s.page.locator('#agent-name')
    await name.waitFor({ timeout: 15_000 }).catch(async () => {
      await s.page.goto(`${ORIGIN}/agents/new`, { waitUntil: 'domcontentloaded' })
    })
    await name.fill(p.name)
    await s.page.locator('#agent-tagline').fill(p.tagline.slice(0, 120))
    await s.page.getByRole('button', { name: 'Create agent', exact: true }).click()
  } else if (!ready(existing)) {
    await s.page.goto(`${ORIGIN}/agents/new?resume=${encodeURIComponent(existing.id)}`)
    await s.page.getByRole('button', { name: `Continue setting up ${existing.name}`, exact: true }).click()
  }
  await drive(s, `agent-${p.id}`, async () => ready((await agents(s)).find((a) => a.name === p.name)), 8)
  const made = await agentOf(s, p)
  console.log(`${s.name}: ${p.name} is agent ${made.agent_id} (${made.address})`)
}

/** The operator's backing behind the agent, topped up to the operator's amount with the agent page's own form. */
async function back(s: Session, p: Persona) {
  const a = await agentOf(s, p)
  const target = parseUnits(s.op.backing, 18)
  const active = async () => (await sdk.getPosition(s.ctx, a.address, s.wallet)).activeValue
  const have = await active()
  if (have < target) {
    await s.page.goto(`${ORIGIN}/agent/${a.agent_id}`, { waitUntil: 'domcontentloaded' })
    await s.page.getByRole('button', { name: 'Back this agent', exact: true }).first().click({ timeout: 60_000 })
    await s.page.locator('#stake-amount').fill(formatUnits(target - have, 18))
    await s.page.getByRole('button', { name: /^Back with \d/ }).click()
    await drive(s, `back-${p.id}`, async () => (await active()) >= target)
  }
  console.log(`${s.name}: ${p.name} backed with ${formatUnits(await active(), 18)} SIDE`)
}

/** The first line a child prints: the authorize address `hosted-hirers.ts login --stdin` opens with. */
function firstLine(child: ReturnType<typeof spawn>): Promise<string> {
  // SAFETY: the child is spawned with piped stdout.
  const lines = createInterface({ input: child.stdout! })
  return new Promise((done, fail) => {
    lines.once('line', (line) => done(line.trim()))
    child.once('exit', (code) => fail(new Error(`hosted-hirers.ts login exited ${String(code)} before its address`)))
  })
}

/** On the consent page: the persona's weekly budget, its grant checked field by field before Privy signs it. */
async function budget(s: Session, p: Persona, a: ReadyAgent) {
  if (s.done(`budget/${p.id}`)) return
  const amount = parseUnits(s.op.weeklyBudget, 6)
  await s.page.getByLabel('Token jobs are paid in', { exact: true }).selectOption(MUSD.toLowerCase())
  await s.page.getByLabel('Weekly budget', { exact: true }).fill(s.op.weeklyBudget)
  await s.page.getByRole('button', { name: 'Review budget', exact: true }).click()
  await s.page.getByRole('button', { name: 'Sign budget', exact: true }).click({ timeout: 60_000 })
  await confirmGrant(s.browser, s.ctx, `/api/agents/${a.id}/allowance-prepare`, {
    kind: 'allowance',
    delegator: s.wallet,
    agent: a.address,
    token: MUSD,
    amount,
  })
  await s.page.getByRole('button', { name: 'Review budget', exact: true }).waitFor({ timeout: 60_000 })
  s.done(`budget/${p.id}`, true)
  console.log(`${s.name}: ${p.name} may spend ${s.op.weeklyBudget} mUSD a week`)
}

/** Connects the persona's MCP client: the operator approves its agent on the consent page; the code goes back to it. */
async function connect(s: Session, p: Persona) {
  const a = await agentOf(s, p)
  const child = spawn('bun', [join(REPO, 'crew', 'bin', 'hosted-hirers.ts'), 'login', p.id, '--stdin'], {
    cwd: REPO,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const output: string[] = []
  const url = authorizationUrl(await firstLine(child))
  if (url === undefined) throw new Error('OPERATOR_UNEXPECTED_AUTHORIZE_URL')
  child.stdout?.on('data', (chunk) => output.push(String(chunk)))
  const exited = new Promise<number | null>((done) => child.once('exit', done))
  await s.page.goto(url, { waitUntil: 'domcontentloaded' })
  await s.page.getByRole('combobox').first().selectOption(a.id, { timeout: 60_000 })
  await budget(s, p, a)
  s.page.on('request', (request) => {
    const landed = new URL(request.url())
    if (landed.hostname !== '127.0.0.1' || !landed.searchParams.has('code')) return
    if (child.stdin !== null && !child.stdin.writableEnded) child.stdin.end(`${landed.href}\n`)
  })
  await s.page.getByRole('button', { name: 'Use this agent for this connection', exact: true }).click()
  if ((await exited) !== 0) throw new Error(`${p.id}: the connection did not finish`)
  if (!output.join('').includes(`connected as agent ${a.agent_id} `))
    throw new Error(`${p.id}: connected another agent`)
  console.log(`${s.name}: ${output.join('').trim()}`)
}

function personaOf(operator: string, id: string | undefined): Persona {
  const p = config.personas.find((row) => row.id === id && row.operator === operator)
  if (p === undefined) throw new Error(`${operator} runs no persona ${String(id)}`)
  return p
}

type Step = (s: Session) => Promise<void>
const OPERATORS = new Map(Object.entries(config.operators))
const PERSONA_STEPS = new Map<string, (s: Session, p: Persona) => Promise<void>>([
  ['agent', agent],
  ['back', back],
  ['connect', connect],
])

/** What a command runs once signed in: nothing more, the faucet, one persona's step, or everything in order. */
function stepsFor(name: string, command: string, id: string | undefined): Step[] {
  if (command === 'login') return []
  if (command === 'fund') return [fund]
  if (command === 'all') {
    const mine = config.personas.filter((p) => p.operator === name)
    return [
      fund,
      ...mine.flatMap((p) =>
        [agent, back, connect].map(
          (step): Step =>
            (s) =>
              step(s, p),
        ),
      ),
    ]
  }
  const step = PERSONA_STEPS.get(command)
  if (step === undefined) throw new Error(`operators.ts has no step ${command}`)
  const p = personaOf(name, id)
  return [(s) => step(s, p)]
}

async function main([name = '', command = '', id]: string[]) {
  const op = OPERATORS.get(name)
  if (op === undefined || command === '')
    return console.log('usage: operators.ts <studio|research|shop> login|fund|agent <p>|back <p>|connect <p>|all')
  const steps = stepsFor(name, command, id)
  const s = new Session(name, op)
  try {
    await login(s)
    for (const step of steps) await step(s)
  } catch (error) {
    await s.shot('failed')
    throw error
  } finally {
    // A page error the site threw along the way is not this run's failure; the steps above checked their results.
    await s.browser.close().catch((error: unknown) => console.error(`${s.name}: ${String(error)}`))
  }
}

await main(process.argv.slice(2))
