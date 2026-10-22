/**
 * A member's local wake state: inbox checkpoints and the operator's nudge. Cursor data, timestamps and model notes never
 * share a text field.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Schema } from 'effect'

const Checkpoint = Schema.Struct({
  cursor: Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/^\S+$/u)),
  processedAt: Schema.optionalKey(Schema.String),
  modelNote: Schema.optionalKey(Schema.String),
})
export type Checkpoint = typeof Checkpoint.Type

/** Legacy plain files contain only the server's v1 cursor; never repair concatenated notes or timestamps. */
function decode(text: string): Checkpoint {
  const value = text.trim()
  return /^v1:\d{1,15}$/u.test(value) ? { cursor: value } : Schema.decodeUnknownSync(Checkpoint)(JSON.parse(value))
}

export function readCheckpoint(path: string): { checkpoint?: Checkpoint; resync: boolean } {
  try {
    return { checkpoint: decode(readFileSync(path, 'utf8')), resync: false }
  } catch {
    // Resume the last acknowledged backup, including retained events older than the cursorless lookback.
    try {
      return { checkpoint: decode(readFileSync(`${path}.bak`, 'utf8')), resync: false }
    } catch {
      return { resync: existsSync(path) || existsSync(`${path}.bak`) }
    }
  }
}

/**
 * Pick the highest-priority checkpoint even when only its recovery copy remains. The wake checkpoint must win over
 * the worker checkpoint: falling back to a newer worker cursor would acknowledge retained wake events that have not
 * been processed yet.
 */
export function checkpointPath(paths: readonly string[]): string | undefined {
  return paths.find((path) => existsSync(path) || existsSync(`${path}.bak`))
}

function atomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, path)
}

/** A small state file written whole or not at all. */
export const saveJson = (path: string, value: unknown): void => atomic(path, `${JSON.stringify(value)}\n`)

/**
 * The operator's nudge (`state/nudge`, crew/bin/publish.ts) is set aside as a run starts, so a second pass does not
 * start a second run for it; it is kept (renamed `nudge.<ms>`) as a record. Undefined: there is no nudge.
 */
export function takeNudge(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  const note = readFileSync(path, 'utf8').trim()
  renameSync(path, `${path}.${Date.now()}`)
  return note
}

/**
 * A nudge is consumed only by a run that finished its work (exit 0). A run that failed, timed out or never started puts
 * it back, after any nudge written meanwhile, so the next pass wakes the member for it again.
 */
export function settleNudge(path: string, note: string | undefined, code: number | null): void {
  if (note === undefined || code === 0) return
  appendFileSync(path, `${note}\n`, { mode: 0o600 })
}

/** Call only after processing the batch; a restart sees either the old checkpoint or the complete new one. */
export function saveCheckpoint(path: string, value: Checkpoint): void {
  const text = `${JSON.stringify(Schema.decodeUnknownSync(Checkpoint)(value))}\n`
  atomic(path, text)
  atomic(`${path}.bak`, text)
}

/** A failed model must never promote the wake check's unprocessed candidate cursor. */
export function finishWake(path: string, candidate: string | undefined, code?: number | null): void {
  if (code !== undefined) {
    if (code !== 0) return
    const worker = readCheckpoint(path.replace(/wake-cursor$/u, 'cursor'))
    if (worker.resync || worker.checkpoint === undefined) return
    saveCheckpoint(path, worker.checkpoint)
  } else if (candidate !== undefined) {
    saveCheckpoint(path, { cursor: candidate, processedAt: new Date().toISOString() })
  }
}

if (import.meta.main) {
  const [command, path, payload] = Bun.argv.slice(2)
  if (path === undefined) throw new Error('usage: inbox-state.ts read|commit <path> [checkpoint JSON]')
  if (command === 'read') {
    const { checkpoint, resync } = readCheckpoint(path)
    console.log(JSON.stringify({ ...(resync ? {} : { cursor: checkpoint?.cursor }), resync, lastValid: checkpoint }))
  } else if (command === 'commit' && payload !== undefined) {
    saveCheckpoint(path, Schema.decodeUnknownSync(Checkpoint)(JSON.parse(payload)))
  } else throw new Error('usage: inbox-state.ts read|commit <path> [checkpoint JSON]')
}
