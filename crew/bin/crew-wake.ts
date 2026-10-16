import { join } from 'node:path'
import { checkpointPath, readCheckpoint } from './inbox-state.ts'

/**
 * Which held jobs give a crew worker a reason to wake. A job the worker holds on chain is done once it completed, was
 * rejected, cancelled or expired, unless the board still names the worker as the next to act (it may dispute a
 * rejection inside its window). Rejected jobs used to count as open, so a worker woke every ten minutes for jobs long
 * settled and its pass found nothing to do.
 */
const HELD_DONE = new Set(['completed', 'rejected', 'cancelled', 'expired'])

export interface HeldTask {
  readonly chain?: { readonly status?: string }
  readonly nextAction?: { readonly actor?: string } | null
}

/**
 * A held job wakes the worker when the board names it as the next to act; when the board names someone else (the
 * approver reviewing, the arbitrator ruling), it waits; when the board names no one, it wakes only while the job is
 * not done.
 */
export function openHeld<T extends HeldTask>(tasks: readonly T[]): T[] {
  return tasks.filter((task) => {
    const actor = task.nextAction?.actor
    if (actor !== undefined) return actor === 'worker'
    return !HELD_DONE.has(task.chain?.status ?? '')
  })
}

interface InboxEvent {
  public?: boolean
  requestId?: string | null
}

/** Read the wake batch through the same checkpoint selection used by the supervisor. */
export async function wakeInbox(
  state: string,
  readInbox: (cursor?: string) => Promise<{ events?: InboxEvent[]; cursor?: string }>,
  countFitting: (requests: Set<string>) => Promise<number>,
): Promise<{ reason: string | null; cursor?: string }> {
  const saved = checkpointPath([join(state, 'wake-cursor'), join(state, 'cursor')])
  const loaded = saved === undefined ? undefined : readCheckpoint(saved)
  const inbox = await readInbox(loaded?.checkpoint?.cursor)
  if (loaded?.resync === true)
    return { reason: 'inbox recovery required: no usable checkpoint; seven-day diagnostic only' }
  const events = inbox.events ?? []
  const mine = events.filter((event) => event.public !== true)
  if (mine.length > 0) return { reason: `${mine.length} inbox event(s)`, cursor: inbox.cursor }
  const requests = new Set(
    events.flatMap((event) => (event.public === true && event.requestId ? [event.requestId] : [])),
  )
  const fitting = requests.size === 0 ? 0 : await countFitting(requests)
  return { reason: fitting > 0 ? `${fitting} fitting request(s)` : null, cursor: inbox.cursor }
}
