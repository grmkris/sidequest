import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { makeHarness, maintainer, alice, arbiter } from './layers.ts'
import { runTool } from '../src/tools.ts'
import { PostMessageOutput, ListMessagesOutput } from '../src/schema/messages.ts'
import { migrate } from '../src/sql/schema.ts'
import { getDisputeThread } from '../src/thread/dispute.ts'
import { testSql } from './sql.ts'
import { PresentationInput } from '../src/schema/presentation.ts'

const source =
  'root = Plan("Review the release", "A small release with evidence.", [AskQuestion("Ready?", ["Ship to dev", "Revise first"])])'
const presentation = { protocol: 'openui', version: 1, source }
const post = (args: unknown, caller: string | undefined = maintainer) =>
  runTool('post_message', caller, args).pipe(Effect.map(Schema.decodeUnknownSync(PostMessageOutput)))
const list = (caller?: string) =>
  runTool('list_messages', caller, { subject: 'lobby' }).pipe(Effect.map(Schema.decodeUnknownSync(ListMessagesOutput)))

it('rejects invalid attachments directly at the schema boundary', () => {
  expect(() => Schema.decodeUnknownSync(PresentationInput)({ ...presentation, source: 'root = Broken()' })).toThrow()
  expect(Schema.decodeUnknownSync(PresentationInput)(presentation)).toEqual(presentation)
})

it.effect('adds the nullable attachment column to an existing message table without changing old content', () =>
  Effect.gen(function* () {
    const { sql } = yield* testSql()
    sql.run(`CREATE TABLE commons_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, subject_kind TEXT NOT NULL,
      board_id TEXT, task_id TEXT, item_id INTEGER, author TEXT NOT NULL, badges_json TEXT NOT NULL,
      body TEXT NOT NULL, reply_to INTEGER, mentions_json TEXT NOT NULL,
      hidden_at INTEGER, hidden_by TEXT, hidden_role TEXT, hidden_reason TEXT, hidden_log_seq INTEGER,
      created_at INTEGER NOT NULL
    )`)
    sql.run(
      "INSERT INTO commons_messages(subject, subject_kind, author, badges_json, body, mentions_json, created_at) VALUES('lobby','lobby',?,'[]','Original message','[]',1)",
      maintainer,
    )
    migrate(sql, maintainer)
    migrate(sql, maintainer)
    expect(sql.all('SELECT seq, body, presentation_json FROM commons_messages')).toEqual([
      { seq: 1, body: 'Original message', presentation_json: null },
    ])
  }),
)

it.effect('posts, persists and reads canonical OpenUI with readable fallback and metadata-only feeds', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    yield* Effect.gen(function* () {
      const result = yield* post({ subject: 'lobby', body: 'Review the release. Ready to ship to dev?', presentation })
      expect(result.message.presentation).toMatchObject({ protocol: 'sidequest.commons-ui', version: 1 })
      const saved = h.sql.all<{ presentation_json: string }>('SELECT presentation_json FROM commons_messages')[0]!
      expect(JSON.parse(saved.presentation_json)).toEqual(result.message.presentation)
      migrate(h.sql, maintainer)
      migrate(h.sql, maintainer)
      expect((yield* list()).messages[0]?.presentation).toEqual(result.message.presentation)
      expect(JSON.stringify(h.events)).not.toContain('Review the release')
      expect(JSON.stringify(h.events)).not.toContain('presentation')
      const legacy = yield* post({ subject: 'lobby', body: 'Plain message' })
      expect(legacy.message.presentation).toBeNull()
    }).pipe(Effect.provide(h.layer))
  }),
)

it.effect('rejects invalid attachments and missing posting authority without consuming quota or writing a row', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    yield* Effect.gen(function* () {
      const invalid = yield* post({
        subject: 'lobby',
        body: 'Fallback',
        presentation: { ...presentation, source: source + ' ignored' },
      }).pipe(Effect.result)
      expect(invalid._tag).toBe('Failure')
      expect((yield* post({ subject: 'lobby', body: 'Fallback', presentation }, alice).pipe(Effect.result))._tag).toBe(
        'Failure',
      )
      expect(h.sql.all('SELECT * FROM commons_messages')).toHaveLength(0)
      expect(h.sql.all("SELECT * FROM commons_rate WHERE key LIKE 'post:%'")).toHaveLength(0)
    }).pipe(Effect.provide(h.layer))
  }),
)

it.effect('moderation hides both formats from public and dispute readers; reviewers can inspect both', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    yield* Effect.gen(function* () {
      const { message } = yield* post({ subject: 'lobby', body: 'Review the release', presentation })
      yield* runTool('hide_content', maintainer, { kind: 'message', id: message.id, reason: 'Review needed' })
      for (const caller of [undefined, alice, arbiter])
        expect((yield* list(caller)).messages[0]).toMatchObject({ body: null, presentation: null })
      expect((yield* list(maintainer)).messages[0]?.presentation).toEqual(message.presentation)
      h.sql.run("UPDATE commons_messages SET subject='job:board:task' WHERE seq=?", message.id)
      expect((yield* getDisputeThread('board', 'task'))[0]).toMatchObject({ body: null, presentation: null })
    }).pipe(Effect.provide(h.layer))
  }),
)

it.effect('corrupt or future attachment rows preserve the readable Markdown body', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    yield* Effect.gen(function* () {
      const { message } = yield* post({ subject: 'lobby', body: 'Still readable', presentation })
      for (const stored of ['{', '{"protocol":"sidequest.commons-ui","version":99}']) {
        h.sql.run('UPDATE commons_messages SET presentation_json=? WHERE seq=?', stored, message.id)
        expect((yield* list()).messages[0]).toMatchObject({ body: 'Still readable', presentation: null })
      }
    }).pipe(Effect.provide(h.layer))
  }),
)
