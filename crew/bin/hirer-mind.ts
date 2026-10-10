/**
 * What a persona hirer thinks, apart from how it talks to the board: the kind of job it posts next and the post Grok
 * writes for it, which quote it trusts, how it reads a delivery and whether that meets its criteria, and its rules for
 * waiting on quotes and giving up on a worker that never starts. The REST hirers (hirers.ts) and the hosted MCP
 * hirers (hosted-hirers.ts) share it, so prompt work lands in one place.
 */
import { Option, Schema } from 'effect'
import crewJson from '../crew.json' with { type: 'json' }
import examples from '../examples.json' with { type: 'json' }
import personaFile from '../hirers/personas.json' with { type: 'json' }
import { between, now, origin, sdk } from './activity.ts'
import { ChoiceSchema, DirectorySchema, IdeaSchema, VerdictSchema, grok, listOf } from './hirer-grok.ts'

export interface Persona {
  id: string
  name: string
  voice: string
  strict: boolean
  budget: number[]
  likes: string[]
  always?: string
}
export type Kind = 'skill' | 'stretch' | 'subcontract' | '3d'
export type Plan = 'normal' | 'cancel-early' | 'cancel-late'

/** What the mind needs of a job: what was asked and against what it is judged. */
export interface Brief {
  title: string
  criteria: string[]
}

export interface Quote {
  quoteId: string
  worker: string
  agentId: string
  amount: string
  note?: string
  /** The bidder's open work, from the requester's list_quotes (roadmap #4). */
  workerLoad?: { holding: number; awaitingActivation: number } | null
}

/** The chain view of a task, as get_task answers it. */
export interface TaskView {
  /** open, active, submitted, rejected-pending, disputed, completed, rejected, cancelled, expired, lapsed… */
  chain?: { status?: string } | null
  nextAction?: { actor?: string; action?: string; deadline?: number } | null
  deliverables?: Array<{ descriptor?: { kind?: string; url?: string } }>
}

export const personas: Persona[] = personaFile.personas
const TAGS: readonly string[] = sdk.JOB_TAGS
const listings = Object.values(crewJson.members)
  .map((m) => `${m.name}: ${m.services.map((s) => s.name).join(', ')}`)
  .join('\n')

export function chooseKind(persona: Persona): Kind {
  if (persona.always === '3d') return Math.random() < 0.75 ? '3d' : 'skill'
  const roll = Math.random()
  return roll < 0.72 ? 'skill' : roll < 0.87 ? 'stretch' : 'subcontract'
}

const KIND_ASK: Record<Kind, string> = {
  skill: `Something one of these marketplace specialists does well, deliverable within three hours:\n${listings}`,
  stretch:
    'A stretch ask a little outside the usual listings (for example a short jingle, a tiny browser game, a ' +
    'three-language voiceover, an interactive quiz), still deliverable as one web page within three hours.',
  subcontract:
    'A research or data job with a visual part, so a researcher would sensibly hire a designer or web builder for ' +
    'that part: for example a market memo with a published chart page, or an on-chain report with a small dashboard.',
  '3d':
    'A 3D-printable functional part with real dimensions in millimetres and tolerances (a clip, bracket, stand, ' +
    'knob, organiser, adapter): delivered as an STL with its parametric OpenSCAD source and rendered previews.',
}

/** A job post in the persona's voice: title, brief, up to four criteria plus the defaults, one or two tags. */
export async function writeIdea(
  persona: Persona,
  kind: Kind,
  recentTitles: readonly string[],
): Promise<{ title: string; brief: string; criteria: string[]; tags: string[] } | null> {
  const idea = await grok(
    IdeaSchema,
    'You write realistic, specific job posts for a marketplace where AI agents do paid work. You are the client.',
    `You are ${persona.name}. ${persona.voice}\nYou often need: ${persona.likes.join('; ')}.\n\nWrite one new job post. The work: ` +
      `${KIND_ASK[kind]}\n\nDo not repeat these recent titles: ${recentTitles.slice(-20).join(' | ') || 'none'}.\n` +
      'Fields: title (under 70 characters), brief (2 to 4 sentences with the concrete details a worker needs, in your ' +
      'voice; no links you invented; self-contained, since nothing can be sent to the worker later, so give any ' +
      'address, number or data it needs, or say where to find it publicly), criteria (2 to 4 short checkable ' +
      'acceptance criteria), tags (one or two of ' +
      `${sdk.JOB_TAGS.join(', ')}).`,
  )
  if (idea === null) return null
  const criteria = [...listOf(idea.criteria, /(?<=\.)\s+/).slice(0, 4), ...examples.defaults.criteria]
  const tags = listOf(idea.tags, /[,\s]+/)
    .filter((tag) => TAGS.includes(tag))
    .slice(0, 2)
  return { title: idea.title, brief: idea.brief, criteria, tags: tags.length > 0 ? tags : ['other'] }
}

/** The post's budget in whole mUSD, within the persona's range. */
export const budgetFor = (persona: Persona) =>
  Math.round(between(persona.budget[0] ?? 5, persona.budget[1] ?? 10)).toString()

/** About one post in seventeen is withdrawn, half before the worker starts and half after. */
export const planFor = (): Plan =>
  Math.random() < 0.06 ? (Math.random() < 0.5 ? 'cancel-early' : 'cancel-late') : 'normal'

const loadOf = ({ workerLoad: w }: Quote) =>
  w == null ? '' : ` Holds ${w.holding} unfinished, ${w.awaitingActivation} to start.`

/** The quote the persona trusts most; the cheapest when Grok cannot say. `invited` marks the agent it asked to quote. */
export async function chooseQuote(persona: Persona, job: Brief, quotes: Quote[], invited?: string): Promise<Quote> {
  const body: unknown = await fetch(`${origin}/data/directory`)
    .then((r) => r.json())
    .catch(() => ({}))
  const directory = Schema.decodeUnknownOption(DirectorySchema)(body)
  const agents = Option.isSome(directory) ? directory.value.agents : []
  const names = new Map(agents.map((a) => [a.agentId, a.profile.name]))
  const lines = quotes.map(
    (q, i) =>
      `${i}: ${names.get(q.agentId) ?? `agent ${q.agentId}`}${q.agentId === invited ? ' (you invited them)' : ''} ` +
      `quotes ${q.amount} mUSD.${loadOf(q)} ${q.note ?? ''}`,
  )
  const choice = await grok(
    ChoiceSchema,
    'You are a client choosing which quote to accept for your job.',
    `You are ${persona.name}. ${persona.voice}\nJob: ${job.title}\nCriteria: ${job.criteria.join(' / ')}\n` +
      `Quotes:\n${lines.join('\n')}\nPick the one you trust most to deliver well and in time; price matters but fit matters more, and a worker with several unfinished jobs may miss your deadline. ` +
      'Fields: index, why (one sentence).',
  )
  const chosen = choice !== null && Number.isInteger(choice.index) ? quotes[choice.index] : undefined
  return chosen ?? quotes.reduce((a, b) => (Number(b.amount) < Number(a.amount) ? b : a))
}

/** What the delivery shows: the page's visible text and its deliverable.json, both bounded. */
export async function readDelivery(url: string): Promise<string> {
  const page = await fetch(url, { signal: AbortSignal.timeout(30_000) }).catch(() => undefined)
  if (page?.ok !== true) return `The page at ${url} did not load (${page?.status ?? 'no response'}).`
  const html = await page.text()
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 12_000)
  const links = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]).slice(0, 40)
  // What an interactive page renders with JavaScript (quiz answers, results, chart data) lives in its inline scripts.
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => (m[1] ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 10_000)
  const manifest = await fetch(new URL('deliverable.json', url), { signal: AbortSignal.timeout(20_000) })
    .then(async (r) => (r.ok ? (await r.text()).slice(0, 2000) : `missing (${r.status})`))
    .catch(() => 'missing (no response)')
  // Files the manifest names are checked directly: a poster need not be linked from the page to be delivered.
  const named = [...manifest.matchAll(/"(?:media|poster)"\s*:\s*"([^"]+)"/g)].map((m) => m[1] ?? '')
  const served = await Promise.all(
    named.map(async (file) => {
      const r = await fetch(new URL(file, url), { method: 'HEAD', signal: AbortSignal.timeout(20_000) }).catch(
        () => undefined,
      )
      return `${file}: ${r === undefined ? 'no response' : `${r.status} ${r.headers.get('content-type') ?? ''}`}`
    }),
  )
  return (
    `Page text:\n${text}\n\nInline scripts and data the page renders from:\n${scripts || 'none'}\n\n` +
    `Linked files: ${links.join(', ')}\n\ndeliverable.json: ${manifest}\n\n` +
    `Files deliverable.json names, fetched directly: ${served.join('; ') || 'none'}`
  )
}

/**
 * The persona's verdict on a delivery against its criteria: approve, or reject with a reason naming what failed
 * (at most 600 characters). Null when Grok gave no verdict; the hirer looks again next tick.
 */
export async function judge(
  persona: Persona,
  job: Brief,
  task: TaskView,
): Promise<{ approve: boolean; reason: string; url: string | undefined } | null> {
  const url = task.deliverables?.at(-1)?.descriptor?.url
  const evidence = url === undefined ? 'No URL was delivered.' : await readDelivery(url)
  const strictness = persona.strict
    ? 'You are strict: reject if any criterion is not clearly and demonstrably met.'
    : 'You are fair and practical: approve unless a criterion is clearly unmet or the page is broken.'
  const verdict = await grok(
    VerdictSchema,
    'You are a client reviewing delivered work against the acceptance criteria you wrote.',
    `You are ${persona.name}. ${persona.voice}\n${strictness}\nJob: ${job.title}\nCriteria:\n` +
      `${job.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nDelivery at ${url ?? '(none)'}:\n${evidence}\n\n` +
      'Fields: approve (boolean), failed (the criterion that failed, if any), reason (one or two sentences, in your ' +
      'voice, naming what you checked).',
  )
  if (verdict === null) return null
  if (verdict.approve) return { approve: true, reason: verdict.reason, url }
  const reason = `${verdict.failed ? `Failed: ${verdict.failed}. ` : ''}${verdict.reason}`.slice(0, 600)
  return { approve: false, reason, url }
}

/** The client's statement to the arbitrator when the worker disputes a rejection. */
export const statementText = (job: Brief) =>
  `As the client: I rejected this delivery because it did not meet the criteria I set. ${job.criteria.join(' ')}`.slice(
    0,
    3900,
  )

/**
 * Whether to pick now: with no quotes, wait for the window or call the request lapsed; with some, wait 20 minutes for
 * a field of quotes unless three are in or the window is about to close.
 */
export function quoteWait(
  job: { postedAt: number; quoteDeadline: number },
  quotes: number,
  at = now(),
): 'wait' | 'lapsed' | 'choose' {
  if (quotes === 0) return at > job.quoteDeadline ? 'lapsed' : 'wait'
  const waiting = at - job.postedAt < 20 * 60 && quotes < 3 && at < job.quoteDeadline - 120
  return waiting ? 'wait' : 'choose'
}

/**
 * A selected worker that never activates: once its activation deadline passes (the listing then waits on the hirer
 * to select again), the hirer withdraws the hire.
 */
export function noShow(task: TaskView, at = now()): boolean {
  const expired = task.nextAction?.action === 'select_worker' || (task.nextAction?.deadline ?? Infinity) < at - 300
  return task.chain?.status === 'open' && expired
}
