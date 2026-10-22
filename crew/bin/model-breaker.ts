/**
 * Which model a member runs on: a circuit breaker over its primary. The primary serves until it refuses for capacity
 * `threshold` runs in a row; the breaker then opens and runs go to the fallback until `cooldownMs` has passed, when one
 * run probes the primary again. A probe that succeeds closes the breaker; a probe refused for capacity opens it for
 * another cooldown. Other failures say nothing about capacity and leave it as it is. The state is a file in the
 * member's home, so a restarted container keeps it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { Schema } from 'effect'
import { saveJson } from './inbox-state.ts'

const Breaker = Schema.Struct({
  /** Capacity refusals in a row on the primary. */
  refusals: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** When the breaker last opened (ms), or null while it is closed. */
  openedAt: Schema.NullOr(Schema.Number),
})
export type Breaker = typeof Breaker.Type

export const CLOSED: Breaker = { refusals: 0, openedAt: null }

export interface BreakerPolicy {
  readonly threshold: number
  readonly cooldownMs: number
}

/** How a run ended, as the breaker counts it. */
export type RunResult = 'ok' | 'capacity' | 'failed'

/** Whether the next run goes to the fallback: the breaker is open and its cooldown has not passed. */
export const onFallback = (breaker: Breaker, policy: BreakerPolicy, now: number): boolean =>
  breaker.openedAt !== null && now - breaker.openedAt < policy.cooldownMs

/** The breaker after a run; a run on the fallback says nothing about the primary. */
export function afterRun(
  breaker: Breaker,
  run: { result: RunResult; onPrimary: boolean },
  policy: BreakerPolicy,
  now: number,
): Breaker {
  if (!run.onPrimary || run.result === 'failed') return breaker
  if (run.result === 'ok') return CLOSED
  const refusals = breaker.refusals + 1
  // A probe after the cooldown (the breaker was open) reopens it at once.
  return breaker.openedAt !== null || refusals >= policy.threshold
    ? { refusals, openedAt: now }
    : { refusals, openedAt: null }
}

/**
 * The primary model's refusal for capacity. In the harness's own model-error events (Codex's `error`/`turn.failed`) a
 * rate limit counts too; stderr, which also carries what the tools the member ran printed, counts only the provider's
 * capacity wording, so a tool or API that rate-limits the member never moves it off its model.
 */
const CAPACITY_EVENT = /\bat capacity\b|\boverloaded\b|\brate.?limit/i
const CAPACITY_STDERR = /\bmodel is at capacity\b|\bmodel is overloaded\b/i

/**
 * Classifies a finished run from its exit code (null: killed, as on its timeout), its JSON event stream (read only for
 * a failed run) and its stderr.
 */
export function runResult(code: number | null, events: () => string, stderr: string): RunResult {
  if (code === 0) return 'ok'
  if (code === null) return 'failed'
  const refused = events()
    .split('\n')
    .some((line) => {
      if (!line.includes('"error"') && !line.includes('"turn.failed"')) return false
      try {
        const event: { type?: string; message?: string; error?: { message?: string } } = JSON.parse(line)
        return (
          (event.type === 'error' || event.type === 'turn.failed') &&
          CAPACITY_EVENT.test(event.message ?? event.error?.message ?? '')
        )
      } catch {
        return false
      }
    })
  return refused || CAPACITY_STDERR.test(stderr) ? 'capacity' : 'failed'
}

export function readBreaker(path: string): Breaker {
  if (!existsSync(path)) return CLOSED
  try {
    return Schema.decodeUnknownSync(Breaker)(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    // An unreadable breaker starts closed: the primary gets the next run, and a refusal counts from there.
    return CLOSED
  }
}

export const saveBreaker = (path: string, breaker: Breaker): void =>
  saveJson(path, Schema.decodeUnknownSync(Breaker)(breaker))
