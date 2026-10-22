import { join } from 'node:path'
import { Schema } from 'effect'
import { checkpointPath, readCheckpoint, readJson, saveJson } from './inbox-state.ts'

/**
 * Which held jobs give a crew worker a reason to wake. A job the worker holds on chain is done once it completed, was
 * rejected, cancelled or expired, unless the board still names the worker as the next to act (it may dispute a
 * rejection inside its window). Rejected jobs used to count as open, so a worker woke every ten minutes for jobs long
 * settled and its pass found nothing to do.
 */
const HELD_DONE = new Set(['completed', 'rejected', 'cancelled', 'expired'])

/** A job the member holds, as `list_tasks {role: 'holder'}` summarises it (packages/board/src/service.ts). */
export interface HeldTask {
  readonly taskId?: string
  readonly chain?: { readonly status?: string; readonly submittedAt?: number | null }
  readonly nextAction?: {
    readonly actor?: string
    readonly action?: string
    readonly deadline?: number | null
  } | null
}

/**
 * The worker's turn on a held job: the board names it as the next to act. When the board names someone else (the
 * approver reviewing, the arbitrator ruling), it waits; when the board names no one, the job is open while it is not done.
 */
export function isWorkerTurn(task: HeldTask): boolean {
  const actor = task.nextAction?.actor
  if (actor !== undefined) return actor === 'worker'
  return !HELD_DONE.has(task.chain?.status ?? '')
}

export function openHeld<T extends HeldTask>(tasks: readonly T[]): T[] {
  return tasks.filter(isWorkerTurn)
}

/**
 * A review window that ended in silence: anyone may complete the job, and it is the worker who gets paid, so the worker
 * wakes to collect it (`settlement_actions`). No event announces it; only the board's next action changes. The name is
 * publisher-view.ts's `publisherNextAction`; the other `anyone` settlements refund the creator or follow an event.
 */
const COLLECT = 'complete_after_silence'

/** What held work a member's last successful run saw: when it ran, and each held job's state then. */
const HeldSeen = Schema.Struct({ at: Schema.Number, tasks: Schema.Record(Schema.String, Schema.String) })
export type HeldSeen = typeof HeldSeen.Type
export const NOTHING_SEEN: HeldSeen = { at: 0, tasks: {} }

export interface HeldPolicy {
  /** How long held work that has not changed waits before the member looks at it again. */
  readonly heartbeatMs: number
}

/** A held job's state as far as waking goes; `soon` flips once when its deadline comes within one heartbeat. */
function heldKey(task: HeldTask, now: number, policy: HeldPolicy): string {
  const soon = (task.nextAction?.deadline ?? Infinity) * 1000 - now < policy.heartbeatMs
  return [task.chain?.status, task.nextAction?.action, task.chain?.submittedAt, soon ? 'soon' : '']
    .map((part) => part ?? '')
    .join('|')
}

/**
 * Whether held work wakes a member: once when a job is new to it or its state on the board changed, then again only
 * after a heartbeat. Waking every pass while a job sat unchanged cost a full model run every ten minutes that found
 * nothing to do (Patch on job #18, 22 Oct). Jobs that leave the set never wake. `candidate` is what this check saw;
 * the supervisor records it once a run finishes its work (finishHeld).
 */
export function heldWake(
  held: readonly HeldTask[],
  saved: HeldSeen,
  now: number,
  policy: HeldPolicy,
): { reason: string | null; candidate: HeldSeen } {
  const tasks: Record<string, string> = {}
  for (const task of held)
    if (isWorkerTurn(task) || task.nextAction?.action === COLLECT) tasks[task.taskId ?? ''] = heldKey(task, now, policy)
  const candidate = { at: now, tasks }
  const ids = Object.keys(tasks)
  const changed = ids.filter((id) => saved.tasks[id] !== tasks[id])
  if (changed.length > 0)
    return { reason: `${changed.length} held job(s) new or changed: ${changed.slice(0, 3).join(', ')}`, candidate }
  if (ids.length > 0 && now - saved.at >= policy.heartbeatMs)
    return {
      reason: `${ids.length} held job(s) unchanged for ${Math.round((now - saved.at) / 3_600_000)} h`,
      candidate,
    }
  return { reason: null, candidate }
}

/** The held work last recorded; a missing or unreadable record means nothing seen, so every held job wakes once. */
export const readHeld = (path: string): HeldSeen => readJson(path, HeldSeen, NOTHING_SEEN)

/** Only a run that finished its work (exit 0) records what its check saw; a failed one leaves the held work to wake. */
export function finishHeld(path: string, candidate: HeldSeen | undefined, code: number | null): void {
  if (code === 0 && candidate !== undefined) saveJson(path, Schema.decodeUnknownSync(HeldSeen)(candidate))
}

interface InboxEvent {
  kind?: string
  public?: boolean
  requestId?: string | null
  taskId?: string | null
}

/** Work offered to every inbox: new quote requests, and fixed-price jobs opened for applications. */
export interface Offers {
  readonly requests: ReadonlySet<string>
  readonly jobs: ReadonlySet<string>
}

/** The offers among public events. A job's own events (activated, completed, …) are not offers; only its publishing is. */
export function publicOffers(events: readonly InboxEvent[]): Offers {
  const offers = events.filter((event) => event.public === true)
  return {
    requests: new Set(offers.flatMap((event) => (event.requestId ? [event.requestId] : []))),
    jobs: new Set(
      offers.flatMap((event) =>
        event.kind === 'job.published' && !event.requestId && event.taskId ? [event.taskId] : [],
      ),
    ),
  }
}

/** Read the wake batch through the same checkpoint selection used by the supervisor. */
export async function wakeInbox(
  state: string,
  readInbox: (cursor?: string) => Promise<{ events?: InboxEvent[]; cursor?: string }>,
  countFitting: (offers: Offers) => Promise<number>,
): Promise<{ reason: string | null; cursor?: string | undefined }> {
  const saved = checkpointPath([join(state, 'wake-cursor'), join(state, 'cursor')])
  const loaded = saved === undefined ? undefined : readCheckpoint(saved)
  const inbox = await readInbox(loaded?.checkpoint?.cursor)
  if (loaded?.resync === true)
    return { reason: 'inbox recovery required: no usable checkpoint; seven-day diagnostic only' }
  const events = inbox.events ?? []
  const mine = events.filter((event) => event.public !== true)
  if (mine.length > 0) return { reason: `${mine.length} inbox event(s)`, cursor: inbox.cursor }
  const offers = publicOffers(events)
  const fitting = offers.requests.size + offers.jobs.size === 0 ? 0 : await countFitting(offers)
  return { reason: fitting > 0 ? `${fitting} fitting offer(s)` : null, cursor: inbox.cursor }
}
