#!/usr/bin/env bun
/**
 * Overnight activity, the publisher side: persona wallets (crew/hirers/personas.json) that think up jobs with Grok,
 * post them as quote requests on the dev board, pick a quote, publish, select, and review each delivery against its
 * criteria, then approve, reject, cancel, or let a request lapse as real hirers do. Every board call goes over REST
 * with SIWE, and every send is journaled (FlowJournal), so a restart resumes exactly where it stopped.
 *
 *   bun crew/bin/hirers.ts run      the loop (container sq-hirers)
 *   bun crew/bin/hirers.ts status   each hirer's jobs, MON and spend
 *
 * Env: HIRER_<ID>_PRIVATE_KEY per persona, MONAD_RPC_URL, CLIPROXY_URL, CLIPROXY_API_KEY_CREW (else CLIPROXY_API_KEY),
 * ACTIVITY_MODEL (grok-4.7),
 * ACTIVITY_MAX_JOBS (40 posts in all), ACTIVITY_POST_MINUTES (20, the mean gap between posts), ACTIVITY_STATE.
 */
import { erc20Abi, parseEther } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import examples from '../examples.json' with { type: 'json' }
import { ctx, log, mon, now, origin, pick, sdk, signerFor, sleep, store, v1 } from './activity.ts'
import {
  type Kind,
  type Persona,
  type Plan,
  type Quote,
  type TaskView as Task,
  budgetFor,
  chooseKind,
  chooseQuote,
  judge,
  noShow,
  personas,
  planFor,
  quoteWait,
  statementText,
  writeIdea,
} from './hirer-mind.ts'
import { answerThreads } from './hirer-threads.ts'

type Step = 'quoting' | 'publishing' | 'selecting' | 'cancelling' | 'working' | 'reviewing' | 'closing' | 'done'
interface Job {
  key: string
  kind: Kind
  plan: Plan
  title: string
  criteria: string[]
  budget: string
  requestId: string
  postedAt: number
  quoteDeadline: number
  step: Step
  quoteId?: string
  amount?: string
  worker?: string
  taskId?: string
  applicationId?: string
  cancelAt?: number
  statement?: boolean
  reclaimed?: boolean
  settles: number
  errors: number
  outcome?: string
}
interface HirerData {
  jobs: Job[]
  titles: string[]
  spent: number
  paused?: boolean
  /** The newest Commons message seen on each job's thread, by task ID. */
  threadSeen?: Record<string, number>
}
interface Prepared {
  transactions?: sdk.TxRequest[]
  sign?: { typedData: string }
  status?: string
}

const MAX_JOBS = Number(process.env.ACTIVITY_MAX_JOBS ?? 40)
const POST_MINUTES = Number(process.env.ACTIVITY_POST_MINUTES ?? 20)
/** Below POST_FLOOR a hirer posts nothing new but finishes its open jobs; below MIN_MON it pauses entirely. */
const POST_FLOOR = Number(process.env.ACTIVITY_POST_FLOOR ?? 0.4)
const MIN_MON = Number(process.env.ACTIVITY_MIN_MON ?? 0.12)
const SPEND_CAP = 150
const MAX_OPEN = 4
const WINDOWS = { reviewSeconds: 3600, disputeSeconds: 1800, arbitrationSeconds: 1800 }
const TERMINAL = new Set(['completed', 'rejected', 'cancelled', 'expired', 'lapsed'])
const SETTLE = new Set([
  'settle',
  'settle_rejection',
  'settle_missed_delivery',
  'settle_arbitration_timeout',
  'complete_after_silence',
  'retry_deferred_then_settle',
])

class Hirer {
  readonly wallet: sdk.Wallet
  readonly account: PrivateKeyAccount
  readonly state: ReturnType<typeof store<HirerData>>
  /** The persona's own ERC-8004 agent (crew/bin/personas.ts), named on every post; null until it is registered. */
  readonly agentId: string | null
  #board = sdk.boardClient(origin)
  #signedIn = false
  balance = 0
  constructor(readonly persona: Persona) {
    ;({ wallet: this.wallet, account: this.account } = signerFor(`hirer_${persona.id}`))
    this.state = store<HirerData>(`hirer-${persona.id}`, { jobs: [], titles: [], spent: 0 })
    this.agentId = store<{ agentId: string | null }>(`persona-${persona.id}`, { agentId: null }).saved.data.agentId
  }
  get data() {
    return this.state.saved.data
  }
  get address() {
    return this.wallet.account.address
  }
  get open() {
    return this.data.jobs.filter((job) => job.step !== 'done')
  }
  log(event: string, detail: Record<string, unknown> = {}) {
    log(this.persona.id, event, detail)
  }
  async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    if (!this.#signedIn) {
      await this.#board.signIn(this.account)
      this.#signedIn = true
    }
    try {
      return await this.#board.call<T>(tool, args)
    } catch (error) {
      if (!(error instanceof sdk.BoardApiError) || !/auth|session|401/i.test(error.code)) throw error
      this.#signedIn = false
      return this.call<T>(tool, args)
    }
  }
  /** Sends the board's prepared transactions once each, under `key`, and reports each hash on the task. */
  async send(key: string, prepared: Prepared, taskId?: string) {
    const txs = prepared.transactions ?? []
    for (const receipt of await this.state.journal.transactions(key, this.wallet, txs))
      if (taskId !== undefined) await this.call('report_transaction', { taskId, txHash: receipt.transactionHash })
    return txs.length
  }
  /** Once per wallet: faucet SIDE and mUSD, and 200 SIDE staked to itself for creator bonds. */
  async setup() {
    const j = this.state.journal
    if (j.state.values['setup/done'] === true) return
    const stake = parseEther('200')
    if ((await sdk.nextDripAt(ctx, this.address)) <= now())
      await j.send('setup/drip', this.wallet, { ...sdk.dripCall(ctx, this.address), value: '0' })
    await j.contract('setup/approve-side', this.wallet, ctx.deployment.factory, erc20Abi, 'approve', [v1.vault, stake])
    await j.contract('setup/stake', this.wallet, v1.vault, sdk.stakeVaultAbi, 'delegate', [this.address, stake])
    j.state.values['setup/done'] = true
    this.state.save()
    this.log('setup', { staked: '200 SIDE' })
  }
}

async function post(h: Hirer, total: number) {
  const p = h.persona
  const kind: Kind = chooseKind(p)
  const idea = await writeIdea(p, kind, h.data.titles)
  if (idea === null) {
    h.log('idea-skipped', { kind })
    return
  }
  const budget = budgetFor(p)
  const plan = planFor()
  const key = `${p.id}-${h.data.jobs.length + 1}`
  const criteria = idea.criteria
  const request = await h.state.journal.once(`${key}/request`, () =>
    h.call<{ requestId: string; quoteDeadline: number }>('request_quotes', {
      title: idea.title.slice(0, 90),
      brief: idea.brief,
      acceptanceCriteria: criteria,
      tags: idea.tags,
      budget: { token: 'mUSD', max: budget },
      quoteDeadline: '40m',
      deliveryDeadline: '5h',
      windows: WINDOWS,
      deliverable: { accepts: examples.defaults.accepts },
      idempotencyKey: `activity-${h.address.slice(2, 10)}-${key}`,
      ...(h.agentId === null ? {} : { agentId: h.agentId }),
    }),
  )
  h.data.jobs.push({
    key,
    kind,
    plan,
    title: idea.title,
    criteria,
    budget,
    requestId: request.requestId,
    postedAt: now(),
    quoteDeadline: request.quoteDeadline || now() + 40 * 60,
    step: 'quoting',
    settles: 0,
    errors: 0,
  })
  h.data.titles.push(idea.title)
  h.state.save()
  h.log('posted', { n: total + 1, key, kind, plan, title: idea.title, budget, requestId: request.requestId })
}

async function review(h: Hirer, job: Job, task: Task) {
  const verdict = await judge(h.persona, job, task)
  if (verdict === null) return
  const url = verdict.url
  const taskId = job.taskId ?? ''
  if (verdict.approve) {
    const accepted = await h.state.journal.once(`${job.key}/approve`, () =>
      h.call<Prepared>('approve_work', { taskId }),
    )
    await h.send(`${job.key}/approve`, accepted, taskId)
    job.outcome = 'approved'
  } else {
    const reason = verdict.reason
    const rejected = await h.state.journal.once(`${job.key}/reject`, () =>
      h.call<Prepared>('reject_work', { taskId, violation: 'Quality', reason }),
    )
    await h.send(`${job.key}/reject`, rejected, taskId)
    job.outcome = 'rejected'
  }
  job.step = 'closing'
  h.log(job.outcome, { key: job.key, taskId, reason: verdict.reason, url })
}

/** Settlement anyone may send once its clock allows; a fresh journal key per attempt, so a revert never sticks. */
async function settle(h: Hirer, job: Job, task: Task) {
  const due = task.nextAction?.deadline === undefined || task.nextAction.deadline <= now()
  if (!SETTLE.has(task.nextAction?.action ?? '') || !due) return
  const prepared = await h.call<Prepared>('settlement_actions', { taskId: job.taskId })
  job.settles += 1
  if ((await h.send(`${job.key}/settle-${job.settles}`, prepared, job.taskId)) > 0)
    h.log('settled', { key: job.key, action: task.nextAction?.action })
}

async function quoting(h: Hirer, job: Job) {
  const { quotes } = await h.call<{ quotes: Quote[] }>('list_quotes', { requestId: job.requestId })
  const next = quoteWait(job, quotes.length)
  if (next === 'lapsed') {
    Object.assign(job, { step: 'done', outcome: 'lapsed' })
    h.log('lapsed', { key: job.key, title: job.title })
  }
  if (next !== 'choose') return
  const quote = await chooseQuote(h.persona, job, quotes)
  Object.assign(job, { step: 'publishing', quoteId: quote.quoteId, amount: quote.amount, worker: quote.agentId })
  h.data.spent += Number(quote.amount)
  h.log('picked', { key: job.key, agentId: quote.agentId, amount: quote.amount, of: quotes.length })
}

async function publishing(h: Hirer, job: Job) {
  const created = await h.state.journal.once(`${job.key}/pick`, () =>
    h.call<Prepared & { taskId: string; applicationId: string }>('pick_quote', {
      requestId: job.requestId,
      quoteId: job.quoteId,
      idempotencyKey: `activity-${h.address.slice(2, 10)}-${job.key}-pick`,
    }),
  )
  Object.assign(job, { taskId: created.taskId, applicationId: created.applicationId })
  await h.send(`${job.key}/publish`, created, created.taskId)
  h.log('published', { key: job.key, taskId: created.taskId })
  const delay = job.plan === 'cancel-early' ? 240 : 900
  Object.assign(job, job.plan === 'normal' ? { step: 'selecting' } : { step: 'cancelling', cancelAt: now() + delay })
}

async function cancelling(h: Hirer, job: Job) {
  if (now() < (job.cancelAt ?? 0)) return
  const cancelled = await h.state.journal.once(`${job.key}/cancel`, () =>
    h.call<Prepared>('cancel_task', { taskId: job.taskId }),
  )
  await h.send(`${job.key}/cancel`, cancelled, job.taskId)
  Object.assign(job, { step: 'closing', outcome: job.outcome ?? 'cancelled' })
  h.log('cancelled', { key: job.key, taskId: job.taskId, late: job.plan === 'cancel-late', outcome: job.outcome })
}

async function selecting(h: Hirer, job: Job) {
  const j = h.state.journal
  const selected = await j.once(`${job.key}/select`, () =>
    h.call<{ nonce: string; sign: { typedData: string } }>('select_worker', {
      taskId: job.taskId,
      applicationId: job.applicationId,
    }),
  )
  const signature = await j.once(`${job.key}/select-sign`, () =>
    sdk.signTypedDataJson(h.wallet, selected.sign.typedData),
  )
  await j.once(`${job.key}/selection`, () =>
    h.call('submit_selection', { taskId: job.taskId, nonce: selected.nonce, signature }),
  )
  job.step = 'working'
  h.log('selected', { key: job.key, taskId: job.taskId, agentId: job.worker })
}

const statusOf = (task: Task) => task.chain?.status ?? ''

async function working(h: Hirer, job: Job) {
  const task = await h.call<Task>('get_task', { taskId: job.taskId })
  if (statusOf(task) === 'submitted') return review(h, job, task)
  if (noShow(task)) {
    Object.assign(job, { step: 'cancelling', cancelAt: now(), outcome: 'no-show' })
    h.log('no-show', { key: job.key, taskId: job.taskId, agentId: job.worker })
    return
  }
  return closing(h, job, task)
}

async function closing(h: Hirer, job: Job, known?: Task) {
  const task = known ?? (await h.call<Task>('get_task', { taskId: job.taskId }))
  const chainStatus = statusOf(task)
  if (chainStatus === 'disputed' && job.statement !== true) {
    await h.call('add_statement', { taskId: job.taskId, text: statementText(job) })
    job.statement = true
    h.log('statement', { key: job.key, taskId: job.taskId })
  }
  // A hire nobody activated keeps its reward and bond escrowed until its creator cancels; get_task points at a
  // settle that settlement_actions cannot prepare. The next tick closes it as cancelled.
  if (chainStatus === 'lapsed' && job.reclaimed !== true) {
    const cancelled = await h.state.journal.once(`${job.key}/reclaim`, () =>
      h.call<Prepared>('cancel_task', { taskId: job.taskId }),
    )
    await h.send(`${job.key}/reclaim`, cancelled, job.taskId)
    job.reclaimed = true
    h.log('reclaimed', { key: job.key, taskId: job.taskId })
    return
  }
  if (!TERMINAL.has(chainStatus)) return settle(h, job, task)
  const collect = await h.call<Prepared>('collect_actions', { taskId: job.taskId }).catch((): Prepared => ({}))
  await h.send(`${job.key}/collect`, collect, job.taskId)
  Object.assign(job, { step: 'done', outcome: `${job.outcome ?? 'closed'}/${chainStatus}` })
  h.log('closed', { key: job.key, taskId: job.taskId, status: chainStatus, outcome: job.outcome })
}

const STEPS: Record<Exclude<Step, 'done' | 'reviewing'>, (h: Hirer, job: Job) => Promise<void>> = {
  quoting,
  publishing,
  cancelling,
  selecting,
  working,
  closing: (h, job) => closing(h, job),
}

/** Moves one job as far as it can go this tick: a step that completes falls through to the next. */
async function advance(h: Hirer, job: Job) {
  for (let hops = 0; hops < 4; hops++) {
    const before = job.step
    if (before === 'done' || before === 'reviewing') return
    await STEPS[before](h, job)
    h.state.save()
    if (job.step === before) return
  }
}

const closedLapsed = (job: Job) => job.taskId !== undefined && job.outcome?.endsWith('/lapsed') === true

/** Hires closed as lapsed before the reclaim step existed reopen once, so their escrow comes back. */
function reopenLapsed(h: Hirer) {
  for (const job of h.data.jobs)
    if (job.step === 'done' && closedLapsed(job) && job.reclaimed !== true) job.step = 'closing'
}

/** One hirer's tick: pause on low MON, set up once, then advance each open job; a failing job is retired after 6. */
async function tick(h: Hirer) {
  const balance = await mon(h.address)
  h.balance = balance
  const paused = balance < MIN_MON
  if (paused !== (h.data.paused === true)) h.log(paused ? 'paused' : 'resumed', { mon: balance.toFixed(3) })
  h.data.paused = paused
  if (paused) return
  reopenLapsed(h)
  try {
    await h.setup()
  } catch (error) {
    h.log('setup-error', { message: String(error).slice(0, 300) })
    return
  }
  for (const job of h.open) {
    try {
      await advance(h, job)
    } catch (error) {
      job.errors += 1
      h.log('error', { key: job.key, step: job.step, message: String(error).slice(0, 300) })
      if (job.errors >= 6) Object.assign(job, { step: 'done', outcome: `stuck at ${job.step}` })
    }
    h.state.save()
  }
  const jobs = h.open.filter((job) => job.step === 'working' || job.step === 'closing')
  h.data.threadSeen = await answerThreads(h, jobs, h.data.threadSeen ?? {}).catch((error: unknown) => {
    h.log('thread-error', { message: String(error).slice(0, 300) })
    return h.data.threadSeen ?? {}
  })
  h.state.save()
}

/** The next poster: the maker first, so the 3D ask is on the board from the start; then any hirer with room. */
function nextPoster(hirers: Hirer[]): Hirer | undefined {
  const ready = hirers.filter((h) => h.balance >= POST_FLOOR && h.open.length < MAX_OPEN && h.data.spent < SPEND_CAP)
  const maker = ready.find((h) => h.persona.always === '3d' && h.data.jobs.length === 0)
  return maker ?? pick(ready)
}

async function loop() {
  const hirers = personas.map((p) => new Hirer(p))
  const posted = () => hirers.reduce((n, h) => n + h.data.jobs.length, 0)
  let nextPost = now()
  for (;;) {
    for (const h of hirers) await tick(h)
    const poster = posted() < MAX_JOBS && now() >= nextPost ? nextPoster(hirers) : undefined
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

async function status() {
  for (const p of personas) {
    const h = new Hirer(p)
    const jobs = h.data.jobs.map((job) => `${job.key} ${job.step} ${job.outcome ?? ''} ${job.title}`)
    console.log(`${p.id} ${h.address} ${(await mon(h.address)).toFixed(3)} MON, spent ${h.data.spent} mUSD`)
    for (const line of jobs) console.log(`  ${line}`)
  }
}

const command = process.argv[2]
if (command === 'run') await loop()
else if (command === 'status') await status()
else console.log('usage: bun crew/bin/hirers.ts run|status')
