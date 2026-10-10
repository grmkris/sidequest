import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Schema } from 'effect'
import type { ModelEndpoint } from '@sidequest/board'
import { type ModerationVerdict, classifyContent } from './moderation.ts'
import { placeOf } from './moderator-content.ts'
import { GitHubShip, RateLimited, REPOSITORY, type Shipped } from './maintainer-ship.ts'
import {
  planTriage,
  validTriage,
  type TriageAction,
  type TriageGap,
  type TriageItem,
  type TriagePlan,
} from './maintainer-triage.ts'

/**
 * One Maintainer pass (the CTO role): review the moderator's newest hides and restore clear false positives, mark
 * what shipped on dev, then triage the gaps still open (merge, link, propose). At most `cap` board actions a pass, one of them an
 * unhide. Every public reason and note is a fixed template; model output only chooses among validated actions.
 */
export interface MaintainerOptions {
  readonly board: { call<T>(tool: string, args?: Record<string, unknown>): Promise<T> }
  readonly endpoint: ModelEndpoint
  readonly stateFile: string
  readonly shipSince: string
  readonly log?: (message: string) => void
  readonly classify?: (text: string) => Promise<{ verdict: ModerationVerdict; failed: boolean }>
  readonly plan?: (gaps: readonly TriageGap[], items: readonly TriageItem[]) => Promise<TriagePlan>
  readonly github?: Pick<GitHubShip, 'shipped'>
  readonly now?: () => number
  readonly cap?: number
}

const State = Schema.Struct({
  logCursor: Schema.optionalKey(Schema.String),
  shipSince: Schema.optionalKey(Schema.String),
  shipped: Schema.Array(Schema.String),
  backoffUntil: Schema.optionalKey(Schema.Number),
  triageKey: Schema.optionalKey(Schema.String),
})
type State = { -readonly [K in keyof typeof State.Type]: (typeof State.Type)[K] }
const MissingFile = Schema.Struct({ code: Schema.Literal('ENOENT') })

async function loadState(path: string): Promise<State> {
  try {
    const state = Schema.decodeUnknownSync(State)(JSON.parse(await readFile(path, 'utf8')))
    return { ...state, shipped: [...state.shipped] }
  } catch (error) {
    if (Schema.is(MissingFile)(error)) return { shipped: [] }
    throw new Error('maintainer state could not be read', { cause: error })
  }
}
async function saveState(path: string, state: State): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

const LABEL: Record<string, string> = {
  spam: 'spam',
  prompt_injection: 'prompt injection',
  scam: 'a scam',
  abuse: 'abuse',
}
interface LogEntry {
  seq: number
  action: string
  role: string
  targetKind: string
  targetId: number
  subject?: string
  reason: string
}
interface ThreadMessage {
  id: number
  body: string | null
  hidden: unknown
  badges?: { kind: string }[]
}

type Budget = { left: number }

/** The hidden message a moderator hide names, if it is still hidden and readable to this maintainer. */
async function hiddenMessage(o: MaintainerOptions, entry: LogEntry & { subject: string }) {
  const thread = await o.board.call<{ messages: ThreadMessage[] }>('list_messages', {
    subject: entry.subject,
    before: `c:${entry.targetId + 1}`,
    limit: 1,
  })
  const message = thread.messages.find((m) => m.id === entry.targetId)
  return message === undefined || message.hidden === null || message.body === null ? undefined : message
}

/** 'next' moves past the entry; 'stop' ends the review this pass, before (failed review) or after (restored) it. */
async function reviewEntry(o: MaintainerOptions, entry: LogEntry, budget: Budget): Promise<'next' | 'stop' | 'done'> {
  const reviewable = entry.action === 'hide' && entry.role === 'moderator' && entry.targetKind === 'message'
  if (!reviewable || entry.subject === undefined) return 'next'
  const message = await hiddenMessage(o, { ...entry, subject: entry.subject })
  if (message === undefined) return 'next'
  const author = [...new Set((message.badges ?? []).map((b) => b.kind))]
  const text = JSON.stringify({ where: placeOf(entry.subject), author, text: message.body })
  const review = await (o.classify ?? classifier(o))(text)
  // Never restore on a failed review: the entry is retried next pass.
  if (review.failed || (review.verdict.verdict === 'keep' && budget.left <= 0)) return 'stop'
  if (review.verdict.verdict !== 'keep') return 'next'
  const category = LABEL[entry.reason.split(':')[0] ?? ''] ?? 'the hidden category'
  await o.board.call('unhide_content', {
    kind: 'message',
    id: entry.targetId,
    reason: `Second review found ordinary marketplace talk, not ${category}; restored by the maintainer.`,
  })
  budget.left -= 1
  ;(o.log ?? (() => {}))(`restored message ${entry.targetId}`)
  return 'done'
}

/** Restores at most one moderator hide a pass that a second classification calls ordinary; never a maintainer's. */
async function reviewHides(o: MaintainerOptions, state: State, budget: Budget): Promise<void> {
  const page = await o.board.call<{ log: LogEntry[] }>('list_roles', {
    ...(state.logCursor === undefined ? {} : { cursor: state.logCursor }),
    limit: 50,
  })
  for (const entry of page.log) {
    const outcome = await reviewEntry(o, entry, budget)
    if (outcome === 'stop') return
    state.logCursor = `c:${entry.seq}`
    if (outcome === 'done') return
  }
}

function classifier(o: MaintainerOptions) {
  return async (text: string) => {
    let failed = false
    const verdict = await classifyContent(o.endpoint, text, () => {
      failed = true
    })
    return { verdict, failed }
  }
}

interface GapDetail {
  gap: TriageGap & { status: string }
  reports: { reporter: string }[]
}

/** Each open gap's distinct reporters, read once a triage. */
async function reportersByGap(o: MaintainerOptions, gaps: readonly TriageGap[]) {
  const reporters = new Map<number, string[]>()
  for (const g of gaps) {
    const detail = await o.board.call<GapDetail>('list_gaps', { gapId: g.id })
    reporters.set(
      g.id,
      detail.reports.map((r) => r.reporter.toLowerCase()),
    )
  }
  return (ids: readonly number[]) => new Set(ids.flatMap((id) => reporters.get(id) ?? [])).size
}

/** A proposal is published only when the moderation prompt keeps its templated title and problem. */
async function applyTriage(o: MaintainerOptions, action: TriageAction, budget: Budget) {
  if (action.tool === 'propose_item') {
    const check = await (o.classify ?? classifier(o))(`${action.args.title}\n${action.args.problem}`)
    if (check.failed || check.verdict.verdict !== 'keep') return
  }
  await settle(o, action.tool, action.args, budget)
}

/** Merges, links and proposals from a validated model plan; skipped when nothing changed since the last triage. */
async function triage(o: MaintainerOptions, state: State, budget: Budget): Promise<void> {
  const { gaps } = await o.board.call<{ gaps: TriageGap[] }>('list_gaps', { status: 'open', limit: 100 })
  const { items } = await o.board.call<{ items: TriageItem[] }>('list_roadmap', { status: 'all' })
  const key = JSON.stringify([gaps.map((g) => [g.id, g.reports, g.itemIds]), items.map((i) => [i.id, i.status])])
  if (gaps.length === 0 || key === state.triageKey) return
  const count = await reportersByGap(o, gaps)
  const plan = await (o.plan ?? ((g, i) => planTriage(o.endpoint, g, i)))(gaps, items)
  for (const action of validTriage(plan, gaps, items, count, budget.left)) await applyTriage(o, action, budget)
  state.triageKey = key
}

const shippedReason = (commit: Shipped) => `Live on dev in ${commit.sha.slice(0, 8)}.`
const commitLink = (commit: Shipped) => `https://github.com/${REPOSITORY}/commit/${commit.sha}`

/** The live trailer commits not yet handled, or none while GitHub's rate limit holds. */
async function liveCommits(o: MaintainerOptions, state: State): Promise<Shipped[]> {
  const now = (o.now ?? (() => Math.floor(Date.now() / 1000)))()
  if ((state.backoffUntil ?? 0) > now) return []
  const github = o.github ?? new GitHubShip(fetch, process.env.GITHUB_TOKEN)
  try {
    return await github.shipped(state.shipSince!, new Set(state.shipped))
  } catch (error) {
    if (!(error instanceof RateLimited)) throw error
    state.backoffUntil = error.resetAt
    return []
  }
}

/** Marks the gaps and items named by live trailer commits, then items whose linked gaps are now all fixed. */
async function ship(o: MaintainerOptions, state: State, budget: Budget): Promise<void> {
  const commits = await liveCommits(o, state)
  for (const commit of commits) {
    if (budget.left < commit.gaps.length + commit.items.length * 2) return
    for (const gapId of commit.gaps)
      await settle(o, 'set_gap_status', { gapId, status: 'fixed', reason: shippedReason(commit) }, budget)
    for (const itemId of commit.items) await shipItem(o, itemId, byCommit(commit), budget)
    state.shipped = [...state.shipped, commit.sha].slice(-200)
  }
  if (commits.length > 0) await shipCoveredItems(o, budget)
}

async function settle(o: MaintainerOptions, tool: string, args: object, budget: Budget) {
  try {
    await o.board.call(tool, { ...args })
    budget.left -= 1
    ;(o.log ?? (() => {}))(`${tool} done`)
  } catch (error) {
    ;(o.log ?? (() => {}))(`${tool} refused: ${error instanceof Error ? error.message.slice(0, 160) : 'unavailable'}`)
  }
}

/** Ships an item with a public reason and a note in its thread: a named commit, or the gaps that fixed it. */
async function shipItem(o: MaintainerOptions, itemId: number, why: { reason: string; note: string }, budget: Budget) {
  await settle(o, 'set_item_status', { itemId, status: 'shipped', reason: why.reason }, budget)
  await settle(o, 'post_message', { subject: `roadmap:${itemId}`, body: why.note }, budget)
}
const byCommit = (commit: Shipped) => ({ reason: shippedReason(commit), note: `Shipped on dev: ${commitLink(commit)}` })
const BY_GAPS = {
  reason: 'Every linked gap is fixed on dev.',
  note: 'Shipped on dev: every gap linked to this item is fixed; each gap names its commit.',
}

/** Items still open, planned or building whose linked gaps all read fixed. */
async function shipCoveredItems(o: MaintainerOptions, budget: Budget) {
  const { items } = await o.board.call<{ items: (TriageItem & { gapIds: number[] })[] }>('list_roadmap', {
    status: 'all',
  })
  for (const item of items) {
    if (!['open', 'planned', 'building'].includes(item.status) || item.gapIds.length === 0) continue
    const statuses = await Promise.all(
      item.gapIds.map(async (gapId) => (await o.board.call<GapDetail>('list_gaps', { gapId })).gap.status),
    )
    if (statuses.every((status) => status === 'fixed') && budget.left >= 2) await shipItem(o, item.id, BY_GAPS, budget)
  }
}

/** One pass; the state file keeps the role-log cursor, shipped commits and any GitHub backoff. */
export async function maintainOnce(o: MaintainerOptions): Promise<void> {
  const state = await loadState(o.stateFile)
  state.shipSince ??= o.shipSince
  const budget = { left: o.cap ?? 10 }
  try {
    await reviewHides(o, state, budget)
    // Ship before triage: a gap a deployed commit already fixed must not become a new proposal.
    await ship(o, state, budget)
    await triage(o, state, budget)
  } finally {
    await saveState(o.stateFile, state)
  }
}
