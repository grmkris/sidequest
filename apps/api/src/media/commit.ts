/**
 * Every media write is one atomic batch that also writes its log row (ADR-0029). A write names a guard: an INSERT that
 * must not collide, or an UPDATE that must match the revision the caller read. The log row's time is
 * `CASE WHEN changes() > 0`, so a guard that touched nothing fails NOT NULL and rolls the whole batch back. The log is
 * unique per actor and operationKey, so a retry, even after a lost reply, answers the first result.
 */
import { BoardError } from '@sidequest/board'
import { type AsyncSql, type Statement, stmt } from '@sidequest/indexer'
import { Schema } from 'effect'
import { actorName, type MediaActor } from './access.ts'
import type { GroupKind } from './rows.ts'

export interface WriteContext {
  readonly actor: MediaActor
  readonly operationKey: string
  readonly tool: string
  readonly args: object
  readonly now: number
}

export interface Change<R> {
  readonly action: string
  readonly target: string
  /** Must change the rows it names, or the batch rolls back with `refused`. */
  readonly guard?: Statement
  readonly writes: readonly Statement[]
  readonly result: R
  readonly refused: BoardError
}

const ENVELOPE = new Set(['operationKey', 'managedAgentId'])
const isRecord = (value: unknown): value is Record<string, unknown> => value instanceof Object && !Array.isArray(value)

/** The arguments as one canonical string: keys sorted, transport keys left out. */
const canonical = (args: object): string =>
  JSON.stringify(args, (key, value: unknown) =>
    ENVELOPE.has(key)
      ? undefined
      : isRecord(value)
        ? Object.fromEntries(
            Object.keys(value)
              .toSorted()
              .map((name) => [name, value[name]]),
          )
        : value,
  )

async function digestOf(args: object): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(args)))
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const Stored = Schema.fromJsonString(Schema.Struct({ digest: Schema.String, result: Schema.Unknown }))

async function replayOf(sql: AsyncSql, ctx: WriteContext, digest: string): Promise<{ result: unknown } | undefined> {
  const [row] = await sql.all<{ result_json: string }>(
    'SELECT result_json FROM media_log WHERE actor = ? AND operation_key = ?',
    actorName(ctx.actor),
    ctx.operationKey,
  )
  if (row === undefined) return undefined
  const stored = Schema.decodeUnknownSync(Stored)(row.result_json)
  if (stored.digest !== digest)
    throw new BoardError('conflict', 'this operationKey was used with different arguments; use a new key')
  return { result: stored.result }
}

const OPERATION_KEY = /^[\x21-\x7e]{1,128}$/

/** Runs a change once per actor and operationKey. */
export async function commit<R>(sql: AsyncSql, ctx: WriteContext, change: Change<R>): Promise<R> {
  if (!OPERATION_KEY.test(ctx.operationKey))
    throw new BoardError('invalid', 'operationKey must be 1–128 printable characters')
  const digest = await digestOf(ctx.args)
  const earlier = await replayOf(sql, ctx, digest)
  if (earlier !== undefined)
    // SAFETY: the log holds the result this same change produced for these arguments.
    return earlier.result as R
  const at = change.guard === undefined ? '?' : 'CASE WHEN changes() > 0 THEN ? END'
  const log = stmt(
    `INSERT INTO media_log (actor, actor_kind, operator, operation_key, tool, action, target, result_json, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${at})`,
    actorName(ctx.actor),
    ctx.actor.kind,
    ctx.actor.kind === 'agent' ? ctx.actor.operator.toLowerCase() : null,
    ctx.operationKey,
    ctx.tool,
    change.action,
    change.target,
    JSON.stringify({ digest, result: change.result }),
    ctx.now,
  )
  try {
    await sql.batch([...(change.guard === undefined ? [] : [change.guard]), log, ...change.writes])
  } catch {
    const replay = await replayOf(sql, ctx, digest)
    if (replay !== undefined)
      // SAFETY: as above: a concurrent call with the same key and arguments committed first.
      return replay.result as R
    throw change.refused
  }
  return change.result
}

export const stale = (what: string) =>
  new BoardError('conflict', `${what} changed since you read it, or is gone; read it again and retry with a new key`)

/** A named section or campaign must exist, of that kind. */
export async function checkGroup(sql: AsyncSql, id: string | null | undefined, kind: GroupKind): Promise<void> {
  if (id === null || id === undefined) return
  const [row] = await sql.all<{ kind: GroupKind }>('SELECT kind FROM media_groups WHERE id = ?', id)
  if (row?.kind !== kind) throw new BoardError('invalid', `no ${kind} "${id}"`)
}
