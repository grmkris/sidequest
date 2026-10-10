/**
 * One persona hirer as a Sidequest hosted agent over MCP: its OAuth connection (hosted-mcp.ts), its state, and the
 * steps a job goes through, from the post to the settled hire. Every write carries an operationKey saved with its
 * arguments before the call (`hq1-<persona>-<n>-<step>`), so a restart or a lost reply calls again with the same key
 * and gets the original result: the board's operation journal is the transaction journal. hosted-hirers.ts runs it.
 */
import { Option, Schema } from 'effect'
import { join, resolve } from 'node:path'
import examples from '../examples.json' with { type: 'json' }
import { log, now, origin, store } from './activity.ts'
import {
  type Kind,
  type Listing,
  type Persona,
  type Plan,
  type Quote,
  type TaskView,
  budgetFor,
  chooseInvite,
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
import * as hosted from './hosted-mcp.ts'

/** What the steps read of a write's result. */
const Keyed = Schema.Struct({ operationKey: Schema.String })
const Posted = Schema.Struct({ requestId: Schema.String, quoteDeadline: Schema.optionalKey(Schema.Number) })
const Picked = Schema.Struct({
  taskId: Schema.optionalKey(Schema.String),
  selection: Schema.optionalKey(
    Schema.Struct({
      status: Schema.optionalKey(Schema.String),
      next: Schema.optionalKey(
        Schema.Struct({ args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) }),
      ),
    }),
  ),
})

export const board: hosted.Board = { origin, mcp: `${origin}/mcp` }
export const SCOPES = 'sidequest:read sidequest:hire'
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

export interface Whoami {
  address?: string
  agentId?: string
}

const INVITE_RATE = Number(process.env.ACTIVITY_INVITE_RATE ?? 0.35)
export const SPEND_CAP = 150
export const MAX_OPEN = 4
const WINDOWS = { reviewSeconds: 3600, disputeSeconds: 1800, arbitrationSeconds: 1800 }
const TERMINAL = new Set(['completed', 'rejected', 'cancelled', 'expired'])
const SETTLE = new Set([
  'settle',
  'settle_rejection',
  'settle_missed_delivery',
  'settle_arbitration_timeout',
  'complete_after_silence',
  'retry_deferred_then_settle',
])
/** An operator approval no one gives within two hours is given up. */
const APPROVAL_WAIT = 2 * 3600

type Step = 'posting' | 'quoting' | 'publishing' | 'cancelling' | 'working' | 'closing' | 'done'

/** One write, saved with its key and arguments before it is first called, and what came of it. */
interface Op {
  key: string
  tool: string
  args: Record<string, unknown>
  status: 'new' | 'pending' | 'approval' | 'confirmed' | 'failed'
  attempts: number
  operationId?: string
  approveUrl?: string
  since?: number
  result?: Record<string, unknown>
}

export interface Job {
  key: string
  n: number
  kind: Kind
  plan: Plan
  title: string
  criteria: string[]
  budget: string
  requestId?: string
  postedAt: number
  quoteDeadline: number
  step: Step
  invite?: { agentId: string; agentName: string; serviceId: string }
  quoteId?: string
  amount?: string
  worker?: string
  taskId?: string
  cancelAt?: number
  statement?: boolean
  reclaimed?: boolean
  settles: number
  errors: number
  outcome?: string
  ops: Record<string, Op>
}

interface HostedData {
  jobs: Job[]
  titles: string[]
  spent: number
  /** The hosted agent this persona acts as, from whoami. */
  me?: { address: string; agentId: string }
  disconnected?: boolean
  threadSeen?: Record<string, number>
}

/** What a hosted write answers: its state, the board's result, and an approval link when the operator must act. */
interface Reply {
  status?: string
  operationId?: string
  result?: Record<string, unknown>
  approveUrl?: string
}

/** The REST hirers' past titles, so a hosted persona does not repeat them. */
function pastTitles(id: string): string[] {
  const rest = store<{ titles?: string[] }>(`hirer-${id}`, {}).saved.data.titles
  return rest?.slice(-20) ?? []
}

export class HostedHirer {
  readonly state: ReturnType<typeof store<HostedData>>
  constructor(readonly persona: Persona) {
    this.state = store<HostedData>(`hosted-${persona.id}`, { jobs: [], titles: pastTitles(persona.id), spent: 0 })
  }
  get id() {
    return this.persona.id
  }
  get data() {
    return this.state.saved.data
  }
  get address() {
    return this.data.me?.address ?? ''
  }
  get open() {
    return this.data.jobs.filter((job) => job.step !== 'done')
  }
  log(event: string, detail: Record<string, unknown> = {}) {
    log(`hosted-${this.id}`, event, detail)
  }
  /** A read, or a write keyed outside a job (a thread reply): the key is prefixed with the persona's own. */
  call<T>(tool: string, args: Record<string, unknown>, operationKey?: string): Promise<T> {
    return call<T>(
      this.id,
      tool,
      operationKey === undefined ? args : { ...args, operationKey: `hq1-${this.id}-${operationKey}` },
    )
  }
}

/** The key of a job's write, with its attempt when a reverted send needs a fresh one. */
const keyOf = (h: HostedHirer, job: Job, name: string, attempt = 0) =>
  `hq1-${h.id}-${job.n}-${name}${attempt > 0 ? `-r${attempt}` : ''}`

/** Applies a hosted write's reply to its op; returns the board's result once confirmed, else null. */
function settleOp(h: HostedHirer, job: Job, name: string, op: Op, reply: Reply): Record<string, unknown> | null {
  if (reply.operationId !== undefined) op.operationId = reply.operationId
  if (reply.status === 'confirmed') {
    Object.assign(op, { status: 'confirmed', result: reply.result ?? {} })
    return reply.result ?? {}
  }
  if (reply.status === 'approval') {
    if (op.status !== 'approval') h.log('needs-operator', { key: job.key, op: name, approveUrl: reply.approveUrl })
    Object.assign(op, { status: 'approval', approveUrl: reply.approveUrl, since: op.since ?? now() })
    if (now() - (op.since ?? now()) > APPROVAL_WAIT) throw new Error(`${name}: the operator did not approve in 2 h`)
    return null
  }
  if (reply.status === 'reverted' || reply.status === 'dropped') {
    op.status = 'new'
    op.key = keyOf(h, job, name, op.attempts)
    h.log('retry-new-key', { key: job.key, op: name, status: reply.status })
    return null
  }
  if (reply.status === 'rejected') {
    op.status = 'failed'
    throw new Error(`${name}: the operator rejected it`)
  }
  op.status = 'pending'
  return null
}

/** What a refusal means for the op: the board's retry advice, or the error when it gave none. */
function onRefusal(h: HostedHirer, job: Job, name: string, op: Op, error: unknown): null {
  if (!(error instanceof hosted.McpToolError) || error.retry === undefined) throw error
  if (error.retry === 'new-key') op.key = keyOf(h, job, name, op.attempts)
  if (error.retry === 'after-operator') h.log('needs-operator', { key: job.key, op: name, code: error.code })
  return null
}

/**
 * One write of a job, under its saved key: saved with its arguments before the first call (hard rule 9), called again
 * with the same key and arguments until it is confirmed. A spent key (`new-key`) moves to a fresh one.
 */
export async function act(
  h: HostedHirer,
  job: Job,
  name: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  let op = job.ops[name]
  if (op === undefined) {
    const given = Option.getOrUndefined(Schema.decodeUnknownOption(Keyed)(args))?.operationKey
    op = { key: given ?? keyOf(h, job, name), tool, args, status: 'new', attempts: 0 }
    job.ops[name] = op
    h.state.save()
  }
  if (op.status === 'confirmed') return op.result ?? {}
  op.attempts += 1
  try {
    return settleOp(h, job, name, op, await call<Reply>(h.id, op.tool, { ...op.args, operationKey: op.key }))
  } catch (error) {
    return onRefusal(h, job, name, op, error)
  } finally {
    h.state.save()
  }
}

/** A post: the persona's idea, sometimes an invited service, saved as the request's op before it is sent. */
export async function post(h: HostedHirer, total: number) {
  const p = h.persona
  const kind = chooseKind(p)
  const idea = await writeIdea(p, kind, h.data.titles)
  if (idea === null) return h.log('idea-skipped', { kind })
  const n = h.data.jobs.length + 1
  const job: Job = {
    key: `${p.id}-h${n}`,
    n,
    kind,
    plan: planFor(),
    title: idea.title,
    criteria: idea.criteria,
    budget: budgetFor(p),
    postedAt: now(),
    quoteDeadline: now() + 40 * 60,
    step: 'posting',
    settles: 0,
    errors: 0,
    ops: {},
  }
  const invite = (kind === 'skill' || kind === 'subcontract') && Math.random() < INVITE_RATE
  if (invite) {
    const found = await h.call<{ services?: Listing[] }>('find_services', { limit: 30 }).catch(() => ({ services: [] }))
    const chosen = await chooseInvite(p, idea, found.services ?? [])
    if (chosen !== null)
      job.invite = { agentId: chosen.agentId, agentName: chosen.agentName, serviceId: chosen.serviceId }
  }
  job.ops.request = {
    key: keyOf(h, job, 'request'),
    tool: 'request_quotes',
    status: 'new',
    attempts: 0,
    args: {
      title: idea.title.slice(0, 90),
      brief: idea.brief,
      acceptanceCriteria: idea.criteria,
      tags: idea.tags,
      budget: { token: 'mUSD', max: job.budget },
      quoteDeadline: '40m',
      deliveryDeadline: '5h',
      windows: WINDOWS,
      deliverable: { accepts: examples.defaults.accepts },
      ...(job.invite === undefined ? {} : { invite: { agentId: job.invite.agentId } }),
    },
  }
  h.data.jobs.push(job)
  h.data.titles.push(idea.title)
  h.state.save()
  h.log('posting', { n: total + 1, key: job.key, kind, plan: job.plan, title: idea.title, invite: job.invite })
}

async function posting(h: HostedHirer, job: Job) {
  const op = job.ops.request
  if (op === undefined) throw new Error(`${job.key}: a posting job has no saved request`)
  const result = await act(h, job, 'request', op.tool, op.args)
  if (result === null) return
  const posted = Schema.decodeUnknownSync(Posted)(result)
  Object.assign(job, {
    step: 'quoting',
    requestId: posted.requestId,
    quoteDeadline: posted.quoteDeadline ?? job.quoteDeadline,
  })
  h.log('posted', { key: job.key, requestId: posted.requestId, invite: job.invite?.agentName })
}

async function quoting(h: HostedHirer, job: Job) {
  const { quotes } = await h.call<{ quotes: Quote[] }>('list_quotes', { requestId: job.requestId })
  const next = quoteWait(job, quotes.length)
  if (next === 'lapsed') {
    Object.assign(job, { step: 'done', outcome: 'lapsed' })
    h.log('lapsed', { key: job.key, title: job.title })
  }
  if (next !== 'choose') return
  const quote = await chooseQuote(h.persona, job, quotes, job.invite?.agentId)
  Object.assign(job, { step: 'publishing', quoteId: quote.quoteId, amount: quote.amount, worker: quote.agentId })
  h.data.spent += Number(quote.amount)
  h.log('picked', {
    key: job.key,
    agentId: quote.agentId,
    amount: quote.amount,
    of: quotes.length,
    invited: job.invite === undefined ? undefined : job.invite.agentId === quote.agentId,
  })
}

/** One pick hires: the executor pulls the budget, publishes and selects the worker. */
async function publishing(h: HostedHirer, job: Job) {
  const picked = await act(h, job, 'pick', 'pick_quote', { requestId: job.requestId, quoteId: job.quoteId })
  if (picked === null) return
  const { taskId, selection } = Schema.decodeUnknownSync(Picked)(picked)
  if (taskId !== undefined) job.taskId = taskId
  const next = selection?.status === 'confirmed' ? undefined : selection?.next?.args
  if (next !== undefined && (await act(h, job, 'select', 'select_worker', next)) === null) return
  h.log('hired', { key: job.key, taskId: job.taskId, agentId: job.worker })
  const delay = job.plan === 'cancel-early' ? 120 : 900
  Object.assign(job, job.plan === 'normal' ? { step: 'working' } : { step: 'cancelling', cancelAt: now() + delay })
}

/** A planned or no-show cancel; a hire the worker already started refuses it, and the job carries on. */
async function cancelling(h: HostedHirer, job: Job) {
  if (now() < (job.cancelAt ?? 0)) return
  try {
    if ((await act(h, job, 'cancel', 'cancel_task', { taskId: job.taskId })) === null) return
  } catch (error) {
    if (!(error instanceof hosted.McpToolError) || error.code !== 'conflict') throw error
    Object.assign(job, { step: 'working', plan: 'normal' })
    return h.log('cancel-too-late', { key: job.key, taskId: job.taskId })
  }
  Object.assign(job, { step: 'closing', outcome: job.outcome ?? 'cancelled' })
  h.log('cancelled', { key: job.key, taskId: job.taskId, late: job.plan === 'cancel-late', outcome: job.outcome })
}

async function review(h: HostedHirer, job: Job, task: TaskView) {
  const verdict = await judge(h.persona, job, task)
  if (verdict === null) return
  const name = verdict.approve ? 'approve' : 'reject'
  const args = verdict.approve
    ? { taskId: job.taskId }
    : { taskId: job.taskId, violation: 'Quality', reason: verdict.reason }
  // The verdict is saved with the op, so a retry sends the same decision rather than asking Grok again.
  const done = await act(h, job, name, verdict.approve ? 'approve_work' : 'reject_work', job.ops[name]?.args ?? args)
  if (done === null) return
  Object.assign(job, { step: 'closing', outcome: verdict.approve ? 'approved' : 'rejected' })
  h.log(job.outcome!, { key: job.key, taskId: job.taskId, reason: verdict.reason, url: verdict.url })
}

const statusOf = (task: TaskView) => task.chain?.status ?? ''

async function working(h: HostedHirer, job: Job) {
  // A decision already under way is finished first.
  const pending = job.ops.approve ?? job.ops.reject
  if (pending !== undefined && pending.status !== 'confirmed') {
    const name = job.ops.approve === undefined ? 'reject' : 'approve'
    if ((await act(h, job, name, pending.tool, pending.args)) !== null)
      Object.assign(job, { step: 'closing', outcome: name === 'approve' ? 'approved' : 'rejected' })
    return
  }
  const task = await h.call<TaskView>('get_task', { taskId: job.taskId })
  if (statusOf(task) === 'submitted') return review(h, job, task)
  if (noShow(task)) {
    Object.assign(job, { step: 'cancelling', cancelAt: now(), outcome: 'no-show' })
    return h.log('no-show', { key: job.key, taskId: job.taskId, agentId: job.worker })
  }
  return closing(h, job, task)
}

/** The client's statement once the worker disputes the rejection; false while it is still being filed. */
async function answerDispute(h: HostedHirer, job: Job): Promise<boolean> {
  if (job.statement === true) return true
  if ((await act(h, job, 'statement', 'add_statement', { taskId: job.taskId, text: statementText(job) })) === null)
    return false
  job.statement = true
  h.log('statement', { key: job.key, taskId: job.taskId })
  return true
}

/** Settles what is due; nobody else will. Each attempt is its own operation: one that sent nothing is spent. */
async function settleDue(h: HostedHirer, job: Job, task: TaskView) {
  const due = task.nextAction?.deadline === undefined || task.nextAction.deadline <= now()
  if (!SETTLE.has(task.nextAction?.action ?? '') || !due) return
  const last = job.ops[`settle-${job.settles}`]
  if (last === undefined || last.status === 'confirmed') job.settles += 1
  if ((await act(h, job, `settle-${job.settles}`, 'settlement_actions', { taskId: job.taskId })) !== null)
    h.log('settled', { key: job.key, action: task.nextAction?.action })
}

/**
 * After the work: answer a dispute once, reclaim a hire nobody activated, settle what is due, and close the job when
 * the chain says it ended.
 */
async function closing(h: HostedHirer, job: Job, known?: TaskView) {
  const task = known ?? (await h.call<TaskView>('get_task', { taskId: job.taskId }))
  const chain = statusOf(task)
  if (chain === 'disputed' && !(await answerDispute(h, job))) return
  if (chain === 'lapsed' && job.reclaimed !== true) {
    if ((await act(h, job, 'reclaim', 'cancel_task', { taskId: job.taskId })) === null) return
    job.reclaimed = true
    return h.log('reclaimed', { key: job.key, taskId: job.taskId })
  }
  if (!TERMINAL.has(chain)) return settleDue(h, job, task)
  Object.assign(job, { step: 'done', outcome: `${job.outcome ?? 'closed'}/${chain}` })
  h.log('closed', { key: job.key, taskId: job.taskId, status: chain, outcome: job.outcome })
}

const STEPS: Record<Exclude<Step, 'done'>, (h: HostedHirer, job: Job) => Promise<void>> = {
  posting,
  quoting,
  publishing,
  cancelling,
  working,
  closing: (h, job) => closing(h, job),
}

/** Moves one job as far as it can go this tick: a step that completes falls through to the next. */
async function advance(h: HostedHirer, job: Job) {
  for (let hops = 0; hops < 4; hops++) {
    const before = job.step
    if (before === 'done') return
    await STEPS[before](h, job)
    h.state.save()
    if (job.step === before) return
  }
}

/** Who the persona is on the board; a revoked grant stops the persona until its operator connects it again. */
export async function identify(h: HostedHirer): Promise<boolean> {
  if (hosted.readToken(filesOf(h.id).token) === undefined) return false
  try {
    const me = await call<Whoami>(h.id, 'whoami')
    if (me.address === undefined || me.agentId === undefined) return false
    h.data.me = { address: me.address, agentId: me.agentId }
    if (h.data.disconnected === true) h.log('reconnected', { agentId: h.data.me.agentId })
    h.data.disconnected = false
    return true
  } catch (error) {
    if (h.data.disconnected !== true)
      h.log('disconnected', { message: String(error).slice(0, 200), fix: `operators.ts <op> connect ${h.id}` })
    h.data.disconnected = true
    return false
  } finally {
    h.state.save()
  }
}

/** One persona's tick: advance each open job (one failing six times is retired), then answer its job threads. */
export async function tick(h: HostedHirer) {
  if (!(await identify(h))) return
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
