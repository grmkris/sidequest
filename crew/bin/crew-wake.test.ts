/** `bun test crew/bin/crew-wake.test.ts`: which held jobs wake a crew worker. */
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkpointPath, finishWake, readCheckpoint, saveCheckpoint, settleNudge, takeNudge } from './inbox-state.ts'
import { openHeld, publicOffers, wakeInbox } from './crew-wake.ts'

test('a settled rejection no longer wakes the worker, but one it may still dispute does', () => {
  const held = [
    { id: 'done', chain: { status: 'completed' }, nextAction: null },
    { id: 'settled-rejection', chain: { status: 'rejected' }, nextAction: null },
    { id: 'disputable', chain: { status: 'rejected' }, nextAction: { actor: 'worker' } },
    { id: 'cancelled', chain: { status: 'cancelled' } },
    { id: 'expired', chain: { status: 'expired' } },
    { id: 'active', chain: { status: 'active' }, nextAction: { actor: 'worker' } },
    { id: 'in-review', chain: { status: 'submitted' }, nextAction: { actor: 'approver' } },
    { id: 'in-dispute', chain: { status: 'disputed' }, nextAction: { actor: 'arbitrator' } },
    { id: 'unknown-turn', chain: { status: 'active' } },
  ]
  // Someone else's turn (review, ruling) waits; a job with no named next actor wakes while it is not done.
  expect(openHeld(held).map((task) => task.id)).toEqual(['disputable', 'active', 'unknown-turn'])
})

test('migrates a legacy cursor and keeps timestamp and note fields separate across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-cursor-'))
  try {
    const file = join(dir, 'cursor')
    writeFileSync(file, 'v1:967\n')
    expect(readCheckpoint(file)).toEqual({ checkpoint: { cursor: 'v1:967' }, resync: false })
    saveCheckpoint(file, { cursor: 'opaque:next-page', processedAt: '2026-10-16T00:00:00Z', modelNote: 'done' })
    expect(readCheckpoint(file).checkpoint).toEqual({
      cursor: 'opaque:next-page',
      processedAt: '2026-10-16T00:00:00Z',
      modelNote: 'done',
    })
    // readdir order is the filesystem's; the CI runner lists cursor.bak first.
    expect(readdirSync(dir).toSorted()).toEqual(['cursor', 'cursor.bak'])
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('malformed local state resumes the last valid backup until replacement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-cursor-'))
  try {
    const file = join(dir, 'cursor')
    saveCheckpoint(file, { cursor: 'v1:967' })
    writeFileSync(file, 'v1:9672026-10-15T00:48:08Z')
    expect(readCheckpoint(file)).toEqual({ checkpoint: { cursor: 'v1:967' }, resync: false })
    expect(readFileSync(`${file}.bak`, 'utf8')).toContain('v1:967')
    // An interrupted replacement is not a checkpoint.
    writeFileSync(`${file}.123.tmp`, '{"cursor":"v1:999"')
    expect(readCheckpoint(file).checkpoint?.cursor).toBe('v1:967')
    saveCheckpoint(file, { cursor: 'v1:1000' })
    expect(readCheckpoint(file)).toEqual({ checkpoint: { cursor: 'v1:1000' }, resync: false })
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('a malformed first checkpoint resyncs without guessing a timestamp-appended cursor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-cursor-'))
  try {
    const file = join(dir, 'cursor')
    writeFileSync(file, 'v1:9672026-10-15T00:48:08Z')
    expect(readCheckpoint(file)).toEqual({ resync: true })
    expect(() => saveCheckpoint(file, { cursor: 'v1:1\nnotes' })).toThrow()
    expect(readFileSync(file, 'utf8')).toBe('v1:9672026-10-15T00:48:08Z')
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('model failure and skipped runs cannot acknowledge the wake batch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-cursor-'))
  try {
    const file = join(dir, 'wake-cursor')
    saveCheckpoint(file, { cursor: 'v1:1' })
    for (const code of [1, 124, null]) finishWake(file, 'v1:3', code)
    expect(readCheckpoint(file).checkpoint?.cursor).toBe('v1:1')
    finishWake(file, 'v1:3', 0) // exit zero alone is not evidence of event processing
    expect(readCheckpoint(file).checkpoint?.cursor).toBe('v1:1')
    saveCheckpoint(join(dir, 'cursor'), { cursor: 'v1:2' })
    finishWake(file, 'v1:3', 0)
    expect(readCheckpoint(file).checkpoint?.cursor).toBe('v1:2')
    finishWake(file, 'v1:4') // idle filtering completed, no model run needed
    expect(readCheckpoint(file).checkpoint?.cursor).toBe('v1:4')
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('the wake path resumes a backup-only wake checkpoint before the worker cursor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-cursor-'))
  try {
    const wake = join(dir, 'wake-cursor')
    const worker = join(dir, 'cursor')
    saveCheckpoint(wake, { cursor: 'v1:10' })
    rmSync(wake)
    saveCheckpoint(worker, { cursor: 'v1:900' })
    expect(checkpointPath([wake, worker])).toBe(wake)
    expect(readCheckpoint(wake)).toEqual({ checkpoint: { cursor: 'v1:10' }, resync: false })
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('an unusable backup-only wake checkpoint requires recovery instead of bypassing to a newer worker cursor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-cursor-'))
  try {
    const wake = join(dir, 'wake-cursor')
    const worker = join(dir, 'cursor')
    writeFileSync(`${wake}.bak`, '{"cursor":"v1:10"')
    saveCheckpoint(worker, { cursor: 'v1:900' })
    expect(checkpointPath([wake, worker])).toBe(wake)
    expect(readCheckpoint(wake)).toEqual({ resync: true })
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('wake polling with missing primaries replays ten-day events after a model failure and restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-cursor-'))
  try {
    const wake = join(dir, 'wake-cursor')
    writeFileSync(`${wake}.bak`, 'v1:10')
    const expectedCursor = readCheckpoint(wake).checkpoint?.cursor
    const read = async (cursor?: string) => {
      expect(cursor).toBe(expectedCursor)
      // Cursorless polling would omit this ten-day retained event and return only the new candidate.
      return { events: [{ public: false, occurredAt: Date.now() / 1000 - 10 * 86400 }], cursor: 'v1:900' }
    }
    const first = await wakeInbox(dir, read, async () => 0)
    expect(first).toEqual({ reason: '1 inbox event(s)', cursor: 'v1:900' })
    finishWake(wake, first.cursor, 1)
    expect(readFileSync(`${wake}.bak`, 'utf8')).toBe('v1:10')
    expect(await wakeInbox(dir, read, async () => 0)).toEqual(first)
    // Exit zero without committed worker progress also must not promote the unprocessed candidate.
    finishWake(wake, first.cursor, 0)
    expect(readFileSync(`${wake}.bak`, 'utf8')).toBe('v1:10')
    saveCheckpoint(join(dir, 'cursor'), { cursor: 'v1:800' })
    finishWake(wake, first.cursor, 0)
    expect(readCheckpoint(wake).checkpoint?.cursor).toBe('v1:800')
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('wake polling falls back to a worker backup and preserves it on read failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-cursor-'))
  try {
    const worker = join(dir, 'cursor')
    writeFileSync(`${worker}.bak`, 'v1:10')
    const failed = wakeInbox(
      dir,
      async (cursor) => {
        expect(cursor).toBe('v1:10')
        throw new Error('unavailable')
      },
      async () => 0,
    )
    expect(String(await failed.catch((error: unknown) => error))).toContain('unavailable')
    expect(readFileSync(`${worker}.bak`, 'utf8')).toBe('v1:10')
    const restarted = await wakeInbox(
      dir,
      async (cursor) => {
        expect(cursor).toBe('v1:10')
        return { events: [{ public: false }], cursor: 'v1:900' }
      },
      async () => 0,
    )
    expect(restarted).toEqual({ reason: '1 inbox event(s)', cursor: 'v1:900' })
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('backup-only corruption returns a recovery wake reason without a candidate to commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-cursor-'))
  try {
    const wake = join(dir, 'wake-cursor')
    writeFileSync(`${wake}.bak`, '{broken')
    saveCheckpoint(join(dir, 'cursor'), { cursor: 'v1:800' })
    const result = await wakeInbox(
      dir,
      async (cursor) => {
        expect(cursor).toBeUndefined()
        return { events: [], cursor: 'v1:900' }
      },
      async () => 0,
    )
    expect(result.reason).toContain('recovery required')
    expect(result.cursor).toBeUndefined()
    finishWake(wake, result.cursor)
    expect(readFileSync(`${wake}.bak`, 'utf8')).toBe('{broken')
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('a nudge is consumed only by a run that finished its work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-nudge-'))
  try {
    const nudge = join(dir, 'nudge')
    expect(takeNudge(nudge)).toBeUndefined()
    writeFileSync(nudge, 'apply to job 18\n')
    const note = takeNudge(nudge)
    expect(note).toBe('apply to job 18')
    // Set aside while the run goes, so a second pass does not start another run for it.
    expect(existsSync(nudge)).toBe(false)
    settleNudge(nudge, note, 1) // refused for capacity
    expect(readFileSync(nudge, 'utf8')).toBe('apply to job 18\n')
    settleNudge(nudge, takeNudge(nudge), null) // did not start
    expect(readFileSync(nudge, 'utf8')).toBe('apply to job 18\n')
    settleNudge(nudge, takeNudge(nudge), 0)
    expect(existsSync(nudge)).toBe(false)
    // An empty nudge still wakes the member once, then is gone.
    writeFileSync(nudge, '')
    const empty = takeNudge(nudge)
    expect(empty).toBe('')
    settleNudge(nudge, empty, 0)
    expect(existsSync(nudge)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('a nudge written during a failed run is kept beside the one put back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-nudge-'))
  try {
    const nudge = join(dir, 'nudge')
    writeFileSync(nudge, 'first\n')
    const note = takeNudge(nudge)
    writeFileSync(nudge, 'second\n')
    settleNudge(nudge, note, 1)
    expect(readFileSync(nudge, 'utf8')).toBe('second\nfirst\n')
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('public offers are new quote requests and published jobs, not other public job events', () => {
  const offers = publicOffers([
    { public: true, kind: 'request.opened', requestId: 'r1', taskId: null },
    { public: true, kind: 'job.published', taskId: 't1' },
    { public: true, kind: 'job.published', requestId: 'r2', taskId: 't2' },
    { public: true, kind: 'job.completed', taskId: 't3' },
    { public: true, kind: 'job.published', taskId: null },
    { public: false, kind: 'job.published', taskId: 't4' },
  ])
  expect([...offers.requests]).toEqual(['r1', 'r2'])
  // A job published from a picked quote names its worker already; one published outside a board names no task.
  expect([...offers.jobs]).toEqual(['t1'])
})

test('an open job that fits wakes the worker; a public batch without offers does not ask', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-cursor-'))
  try {
    const asked: string[][] = []
    const published = await wakeInbox(
      dir,
      async () => ({ events: [{ public: true, kind: 'job.published', taskId: 't1' }], cursor: 'v1:5' }),
      async ({ jobs }) => {
        asked.push([...jobs])
        return 1
      },
    )
    expect(published).toEqual({ reason: '1 fitting offer(s)', cursor: 'v1:5' })
    const quiet = await wakeInbox(
      dir,
      async () => ({ events: [{ public: true, kind: 'job.completed', taskId: 't1' }], cursor: 'v1:6' }),
      async ({ jobs }) => {
        asked.push([...jobs])
        return 1
      },
    )
    expect(quiet).toEqual({ reason: null, cursor: 'v1:6' })
    expect(asked).toEqual([['t1']])
  } finally {
    rmSync(dir, { recursive: true })
  }
})
