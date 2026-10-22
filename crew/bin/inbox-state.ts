/**
 * A member's local wake state: inbox checkpoints, the operator's nudge and the wake a member asks for. Cursor data,
 * timestamps and model notes never share a text field.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Schema } from 'effect'

export const Checkpoint = Schema.Struct({
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

/** A small state file decoded by its schema; a missing or unreadable one is `fallback`. */
export function readJson<A>(path: string, schema: Schema.Decoder<A>, fallback: A): A {
  if (!existsSync(path)) return fallback
  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return fallback
  }
}

/** A time a member wrote, in ms: Unix seconds, Unix ms or ISO 8601 (COMMON.md asks for ISO); NaN when it is none. */
export function stampMs(text: string): number {
  const value = text.trim()
  if (/^\d{10}$/u.test(value)) return Number(value) * 1000
  return /^\d{13}$/u.test(value) ? Number(value) : Date.parse(value)
}

/**
 * A wake the member asked for (`state/wake-at`, a time it wrote before stopping): its text once due, or right away when
 * it is unreadable, so a typo cannot keep a member from its work. Undefined: none asked, or not yet due. Read only.
 */
export function dueWakeAt(path: string, now: number): string | undefined {
  if (!existsSync(path)) return undefined
  const text = readFileSync(path, 'utf8').trim()
  const at = stampMs(text)
  return Number.isNaN(at) || at <= now ? text : undefined
}

/** A run that finished its work (exit 0) consumes the wake it answered; a time it wrote meanwhile asks for the next. */
export function settleWakeAt(path: string, seen: string | undefined, code: number | null): void {
  if (code !== 0 || seen === undefined || !existsSync(path)) return
  if (readFileSync(path, 'utf8').trim() === seen) rmSync(path, { force: true })
}

/** Runs a nudge gets before it is parked for the operator: a nudge that fails every time must not run every pass. */
export const NUDGE_TRIES = 3
/** How long the record of a taken nudge (`nudge.<ms>`) is kept. */
const NUDGE_RECORD_MS = 14 * 86_400_000

/**
 * The operator's nudge (`state/nudge`, crew/bin/publish.ts) is set aside as a run starts, so a second pass does not
 * start a second run for it; it is kept (renamed `nudge.<ms>`) as a record for two weeks. Undefined: there is no nudge.
 */
export function takeNudge(path: string): string | undefined {
  pruneNudgeRecords(path)
  if (!existsSync(path)) return undefined
  const note = readFileSync(path, 'utf8').trim()
  renameSync(path, `${path}.${Date.now()}`)
  return note
}

/**
 * A nudge is consumed only by a run that finished its work (exit 0). A run that failed, timed out or never started puts
 * it back, after any nudge written meanwhile, so the next pass wakes the member for it again; after NUDGE_TRIES runs
 * that failed it is parked as `nudge.failed.<ms>` and the member's `needs-operator` says why.
 */
export function settleNudge(path: string, note: string | undefined, run: 'done' | 'failed' | 'not-started'): void {
  const tries = `${path}.tries`
  if (note === undefined) return
  if (run === 'done') {
    rmSync(tries, { force: true })
    return
  }
  if (run === 'not-started') {
    appendFileSync(path, `${note}\n`, { mode: 0o600 })
    return
  }
  const failed = (existsSync(tries) ? Number(readFileSync(tries, 'utf8')) || 0 : 0) + 1
  if (failed >= NUDGE_TRIES) {
    rmSync(tries, { force: true })
    writeFileSync(`${path}.failed.${Date.now()}`, `${note}\n`, { mode: 0o600 })
    writeFileSync(
      join(dirname(path), 'needs-operator'),
      `a nudge failed ${failed} runs and is parked in ${basename(path)}.failed.*: ${note.slice(0, 200)}\n`,
      { mode: 0o600 },
    )
    return
  }
  writeFileSync(tries, String(failed), { mode: 0o600 })
  appendFileSync(path, `${note}\n`, { mode: 0o600 })
}

function pruneNudgeRecords(path: string) {
  const dir = dirname(path)
  if (!existsSync(dir)) return
  const record = new RegExp(`^${basename(path)}\\.\\d{13}$`, 'u')
  for (const name of readdirSync(dir))
    if (record.test(name) && Date.now() - statSync(join(dir, name)).mtimeMs > NUDGE_RECORD_MS)
      rmSync(join(dir, name), { force: true })
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
