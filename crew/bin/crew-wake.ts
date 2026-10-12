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

export function openHeld<T extends HeldTask>(tasks: readonly T[]): T[] {
  return tasks.filter((task) => task.nextAction?.actor === 'worker' || !HELD_DONE.has(task.chain?.status ?? ''))
}
