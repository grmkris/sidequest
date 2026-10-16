import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Schema } from 'effect'
import type { ModelEndpoint } from '@sidequest/board'
import { BoardApiError } from '@sidequest/sdk'
import { type ModerationVerdict, classifyContent } from './moderation.ts'
import { eventTarget, targetText } from './moderator-content.ts'

const Cursor = Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/^\S+$/u))
const Event = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  cursor: Cursor,
  next: Schema.optionalKey(Schema.Struct({ tool: Schema.String, args: Schema.Record(Schema.String, Schema.Unknown) })),
})
const Page = Schema.Struct({
  events: Schema.Array(Event),
  cursor: Schema.NullOr(Cursor),
  gap: Schema.optionalKey(Schema.Boolean),
})
const CursorState = Schema.Record(Schema.String, Cursor)
const MissingFile = Schema.Struct({ code: Schema.Literal('ENOENT') })
export type ModeratorEvent = typeof Event.Type

export interface ModeratorOptions {
  readonly board: { call<T>(tool: string, args?: Record<string, unknown>): Promise<T> }
  readonly endpoint: ModelEndpoint
  readonly cursorFile: string
  /** Each board/account has an independent inbox cursor, even with one state file. */
  readonly cursorKey?: string
  readonly log?: (message: string) => void
  readonly classify?: (text: string) => Promise<ModerationVerdict>
}

const ALLOWED_NEXT = new Set(['list_messages', 'get_roadmap_item', 'list_gaps'])
const MODERATION_KINDS = new Set(['message.posted', 'roadmap.proposed', 'gap.reported'])

const decodeCursors = (text: string) => Schema.decodeUnknownSync(CursorState)(JSON.parse(text))

async function loadCursors(path: string): Promise<{ cursors: Record<string, string>; resync: boolean }> {
  try {
    return { cursors: decodeCursors(await readFile(path, 'utf8')), resync: false }
  } catch (error) {
    // A failed replacement can leave a corrupt current file. The previous atomic snapshot is the last
    // acknowledged cursor; if it is also unavailable, a cursorless read is the documented resync path.
    try {
      return { cursors: decodeCursors(await readFile(`${path}.bak`, 'utf8')), resync: false }
    } catch (backupError) {
      return { cursors: {}, resync: !Schema.is(MissingFile)(error) || !Schema.is(MissingFile)(backupError) }
    }
  }
}

async function saveCursors(path: string, cursors: Record<string, string>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(cursors)}\n`, { mode: 0o600 })
  await rename(temporary, path)
  // Store only decoded, successfully processed state in the recovery copy; never copy a corrupt input.
  await writeFile(temporary, `${JSON.stringify(cursors)}\n`, { mode: 0o600 })
  await rename(temporary, `${path}.bak`)
}

async function readEventText(
  options: ModeratorOptions,
  next: NonNullable<ModeratorEvent['next']>,
  target: ReturnType<typeof eventTarget>,
): Promise<string | null> {
  // Thread message ids are sequence ids. A subject-only read returns the newest 50,
  // so anchor an ascending one-message page immediately before this exact event target.
  // targetText still rejects a missing/mismatched target, leaving the cursor unchanged.
  const args =
    target.kind === 'message' && next.tool === 'list_messages'
      ? { ...next.args, after: `c:${target.id - 1}`, limit: 1 }
      : next.args
  const content = await options.board.call<unknown>(next.tool, args)
  return targetText(target, content)
}

async function handleEvent(options: ModeratorOptions, event: ModeratorEvent): Promise<void> {
  const log = options.log ?? (() => {})
  if (!MODERATION_KINDS.has(event.kind)) return
  if (event.next === undefined || !ALLOWED_NEXT.has(event.next.tool)) {
    log(`ignored ${event.id}: next tool is not allowlisted`)
    return
  }
  const target = eventTarget(event.id, event.kind)
  const text = await readEventText(options, event.next, target)
  if (text === null) return
  let modelFailed = false
  const classify =
    options.classify ??
    ((value: string) =>
      classifyContent(options.endpoint, value, (message) => {
        modelFailed = true
        log(message)
      }))
  const verdict = await classify(text)
  if (modelFailed) throw new Error('moderator model failed; cursor unchanged')
  if (verdict.verdict !== 'hide' || verdict.category === 'ok') return
  try {
    await options.board.call('hide_content', { ...target, reason: `${verdict.category}: ${verdict.reason}` })
  } catch (error) {
    if (!(error instanceof BoardApiError) || error.code !== 'conflict' || !/already hidden/iu.test(error.message))
      throw error
    log(`already hidden: ${event.id}`)
  }
}

async function retryEvent(options: ModeratorOptions, event: ModeratorEvent): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await handleEvent(options, event)
      return true
    } catch {
      options.log?.(`event ${event.id} failed (${attempt}/3)`)
    }
  }
  options.log?.(`retry ${event.id} next pass after 3 attempts`)
  return false
}

async function inbox(options: ModeratorOptions, previous: string | undefined) {
  const args = {
    ...(previous === undefined ? {} : { cursor: previous }),
    kinds: [...MODERATION_KINDS],
    includePublic: false,
  }
  try {
    return Schema.decodeUnknownSync(Page)(await options.board.call<unknown>('inbox', args))
  } catch (error) {
    // Only the server cursor refusal permits a cursorless diagnostic. Its seven-day window cannot
    // prove all retained events were processed, so it never replaces an existing checkpoint.
    if (
      previous !== undefined &&
      error instanceof BoardApiError &&
      error.code === 'invalid' &&
      error.message === 'invalid: cursor must be a value returned by inbox'
    ) {
      options.log?.('inbox cursor rejected; resyncing cursorless')
      await options.board.call<unknown>('inbox', { kinds: [...MODERATION_KINDS], includePublic: false })
      throw new Error(
        'inbox recovery required: cursor rejected; seven-day diagnostic cannot acknowledge retained events; cursor unchanged',
        { cause: error },
      )
    }
    throw error
  }
}

export async function moderateOnce(options: ModeratorOptions): Promise<number> {
  const { cursors, resync } = await loadCursors(options.cursorFile)
  const key = options.cursorKey ?? 'default'
  const page = await inbox(options, cursors[key])
  if (resync || page.gap === true) {
    throw new Error('inbox recovery required: missing checkpoints or retention gap; cursor unchanged')
  }
  for (const event of page.events) {
    // Replayed completed hides are skipped by targetText or accepted as already-hidden conflicts.
    if (!(await retryEvent(options, event))) throw new Error('moderator batch incomplete; cursor unchanged')
  }
  const cursor = page.cursor ?? page.events.at(-1)?.cursor
  if (cursor !== undefined) {
    cursors[key] = cursor
    await saveCursors(options.cursorFile, cursors)
  }
  return page.events.length
}
