#!/usr/bin/env bun
/**
 * The showcase publisher: posts the asks in crew/examples.json as real quote requests, as their hirer (a crew member
 * with sidequest:hire), and leaves the rest to that hirer's routine passes: picking a quote, reviewing the delivery
 * against the criteria, approving or rejecting. This script only posts, keeps a journal, and writes the hirer's
 * standing operator note once.
 *
 *   bun crew/bin/publish.ts notes          write the standing showcase note into each hirer's operator notes
 *   bun crew/bin/publish.ts post <id> [n]  post one example (idempotent: a repeat returns the same request); round n
 *                                          > 1 posts it again as a new request, for a round whose quotes lapsed
 *   bun crew/bin/publish.ts seed [n]       post up to n examples not posted yet (default: all)
 *   bun crew/bin/publish.ts status         what was posted, by whom, and when
 *
 * CREW_STAGE picks the board, as for crew.ts. A hirer in its own container (`crew.ts up`) takes the call inside it,
 * where one lock serialises token refreshes; a hirer still run from the host must not be mid-run, since both would
 * refresh the same OAuth token.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Schema } from 'effect'

const Strings = Schema.Array(Schema.String)
const ExampleSchema = Schema.Struct({
  id: Schema.String,
  hirer: Schema.String,
  tags: Strings,
  budget: Schema.String,
  title: Schema.String,
  brief: Schema.String,
  criteria: Strings,
  /** Crew members whose listings fit: each gets a nudge, since a public request is not an inbox event. */
  candidates: Strings,
})
type Example = typeof ExampleSchema.Type
const CatalogSchema = Schema.Struct({
  defaults: Schema.Struct({
    quoteDeadline: Schema.String,
    deliveryDeadline: Schema.String,
    accepts: Strings,
    criteria: Strings,
  }),
  examples: Schema.Array(ExampleSchema),
})
const PostedSchema = Schema.Struct({
  hirer: Schema.String,
  requestId: Schema.NullOr(Schema.String),
  idempotencyKey: Schema.String,
  postedAt: Schema.String,
  response: Schema.Unknown,
})
type Posted = typeof PostedSchema.Type
const JournalSchema = Schema.Record(Schema.String, PostedSchema)
/** request_quotes answers with the request id at the top or under `result`, depending on the hosted path. */
const QuoteReply = Schema.Struct({
  requestId: Schema.optional(Schema.String),
  result: Schema.optional(Schema.Struct({ requestId: Schema.optional(Schema.String) })),
})
const CrewStage = Schema.Struct({ board: Schema.Struct({ stage: Schema.String }) })

const crewDir = resolve(import.meta.dir, '..')
const repo = resolve(crewDir, '..')
const catalog = Schema.decodeUnknownSync(CatalogSchema)(
  JSON.parse(readFileSync(join(crewDir, 'examples.json'), 'utf8')),
)
const stage =
  process.env.CREW_STAGE ??
  Schema.decodeUnknownSync(CrewStage)(JSON.parse(readFileSync(join(crewDir, 'crew.json'), 'utf8'))).board.stage
const hosted = stage === 'dev' ? join(repo, '.crew', 'hosted') : join(repo, '.crew', 'hosted', stage)
const journalPath = join(repo, '.crew', 'publisher', `${stage}.json`)
const NOTE_MARK = '## Showcase requests (crew/bin/publish.ts)'

function journal(): Record<string, Posted> {
  return existsSync(journalPath)
    ? { ...Schema.decodeUnknownSync(JournalSchema)(JSON.parse(readFileSync(journalPath, 'utf8'))) }
    : {}
}

function save(entries: Record<string, Posted>) {
  mkdirSync(dirname(journalPath), { recursive: true })
  writeFileSync(journalPath, JSON.stringify(entries, null, 2) + '\n')
}

/** A host-run hirer mid-run (its throwaway `sq-crew-` container); a containerized hirer is never in the way. */
function running(member: string): boolean {
  if (existsSync(join(hosted, member, 'secrets'))) return false
  const ps = spawnSync('docker', ['ps', '--filter', `name=^sq-crew-${member}$`, '--format', '{{.Names}}'], {
    encoding: 'utf8',
  })
  return ps.stdout.trim() !== ''
}

/** One board call as the hirer, through crew.ts (which refreshes its token); the reply is parsed here. */
function requestQuotes(member: string, args: Record<string, unknown>): typeof QuoteReply.Type {
  const tool = 'request_quotes'
  const out = spawnSync(
    'bun',
    ['--no-env-file', join(crewDir, 'bin', 'crew.ts'), 'call', member, tool, JSON.stringify(args)],
    {
      encoding: 'utf8',
      env: process.env,
    },
  )
  if (out.status !== 0) throw new Error(`${member} ${tool} failed: ${(out.stderr || out.stdout).trim().slice(0, 400)}`)
  const text = out.stdout.trim()
  return Schema.decodeUnknownSync(QuoteReply)(JSON.parse(text.slice(text.indexOf('{'))))
}

/** The standing note tells a hirer how to treat the requests this script posts in its name. */
function notes() {
  for (const hirer of new Set(catalog.examples.map((e) => e.hirer))) {
    const path = join(hosted, hirer, 'agent', 'state', 'operator-notes.md')
    if (!existsSync(dirname(path))) throw new Error(`${hirer} has no agent state at ${dirname(path)}; log it in first`)
    const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (current.includes(NOTE_MARK)) continue
    appendFileSync(
      path,
      `${current === '' || current.endsWith('\n') ? '' : '\n'}\n${NOTE_MARK}\n\n` +
        'Some of your quote requests are showcase examples posted in your name by the crew publisher; they are real ' +
        'work for your operator. Handle them like any request you posted: when quotes arrive, pick the best fit by its ' +
        'note and listing, preferring a member who has not yet won a showcase in that category; then review the ' +
        'delivery strictly against every acceptance criterion, including the deliverable.json and preview.webp rules, ' +
        'and approve, or reject naming the criterion that failed. Do not post anything for them yourself.\n',
    )
    console.log(`${hirer}: standing showcase note written`)
  }
}

/** Round 1 keeps the first key and journal entry; a later round is its own request under its own key. */
const roundKey = (id: string, round: number) => (round > 1 ? `${id}.r${round}` : id)

function post(example: Example, round = 1): Posted {
  const entries = journal()
  const key = roundKey(example.id, round)
  const existing = entries[key]
  if (existing?.requestId != null) return existing
  if (running(example.hirer)) throw new Error(`${example.hirer} is running; post ${example.id} after its run`)
  const idempotencyKey = existing?.idempotencyKey ?? `showcase-${stage}-${key}`
  const reply = requestQuotes(example.hirer, {
    title: example.title,
    brief: example.brief,
    acceptanceCriteria: [...example.criteria, ...catalog.defaults.criteria],
    tags: example.tags,
    budget: { token: 'mUSD', max: example.budget },
    quoteDeadline: catalog.defaults.quoteDeadline,
    deliveryDeadline: catalog.defaults.deliveryDeadline,
    deliverable: { accepts: catalog.defaults.accepts },
    idempotencyKey,
    operationKey: idempotencyKey,
  })
  const requestId = reply.requestId ?? reply.result?.requestId
  const posted: Posted = {
    hirer: example.hirer,
    requestId: requestId ?? null,
    idempotencyKey,
    postedAt: new Date().toISOString(),
    response: reply,
  }
  entries[key] = posted
  save(entries)
  console.log(
    `${key}: posted by ${example.hirer}${requestId === undefined ? ' (no request id in the reply)' : `, request ${requestId}`}`,
  )
  if (requestId !== undefined) nudge(example, requestId)
  return posted
}

/** Tell each candidate about the request; crew.ts's loop wakes a nudged member and hands it this text as a note. */
function nudge(example: Example, requestId: string) {
  for (const member of example.candidates) {
    const state = join(hosted, member, 'agent', 'state')
    if (!existsSync(state)) {
      console.log(`${example.id}: ${member} has no agent state; not nudged`)
      continue
    }
    appendFileSync(
      join(state, 'nudge'),
      `Quote request ${requestId} ("${example.title}") fits one of your listings. Read it, and submit a quote ` +
        'if you can deliver it well before its deadline; otherwise skip it.\n',
    )
    console.log(`${example.id}: nudged ${member}`)
  }
}

const [command, arg, roundArg] = process.argv.slice(2)
switch (command ?? '') {
  case 'notes':
    notes()
    break
  case 'post': {
    const example = catalog.examples.find((e) => e.id === arg)
    if (example === undefined) throw new Error(`no example ${arg}; see crew/examples.json`)
    const round = roundArg === undefined ? 1 : Number(roundArg)
    if (!Number.isSafeInteger(round) || round < 1)
      throw new Error(`round must be a whole number from 1, not ${roundArg}`)
    notes()
    post(example, round)
    break
  }
  case 'seed': {
    notes()
    const limit = arg === undefined ? Infinity : Number(arg)
    const posted = journal()
    let count = 0
    for (const example of catalog.examples) {
      if (count >= limit) break
      if (posted[example.id]?.requestId != null) continue
      post(example)
      count++
    }
    console.log(`seed: posted ${count}`)
    break
  }
  case 'status': {
    const posted = journal()
    for (const example of catalog.examples) {
      const rounds = Object.entries(posted).filter(([key]) => key === example.id || key.startsWith(`${example.id}.r`))
      if (rounds.length === 0) console.log(`${example.id.padEnd(22)} not posted`)
      for (const [key, p] of rounds) {
        console.log(`${key.padEnd(22)} ${p.hirer.padEnd(7)} ${p.requestId ?? '?'} ${p.postedAt}`)
      }
    }
    break
  }
  default:
    console.log('usage: publish.ts notes | post <id> [round] | seed [n] | status')
    process.exitCode = 2
}
