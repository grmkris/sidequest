/** `bun test crew/bin/crew-wake.test.ts`: which held jobs wake a crew worker. */
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NUDGE_TRIES,
  checkpointPath,
  dueWakeAt,
  finishWake,
  readCheckpoint,
  saveCheckpoint,
  settleNudge,
  settleWakeAt,
  takeNudge,
} from './inbox-state.ts'
import {
  type HeldSeen,
  type HeldTask,
  NOTHING_SEEN,
  finishHeld,
  heldWake,
  openHeld,
  publicOffers,
  readHeld,
  wakeInbox,
} from './crew-wake.ts'

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
    settleNudge(nudge, note, 'failed') // refused for capacity
    expect(readFileSync(nudge, 'utf8')).toBe('apply to job 18\n')
    settleNudge(nudge, takeNudge(nudge), 'not-started')
    expect(readFileSync(nudge, 'utf8')).toBe('apply to job 18\n')
    settleNudge(nudge, takeNudge(nudge), 'done')
    expect(existsSync(nudge)).toBe(false)
    // An empty nudge still wakes the member once, then is gone.
    writeFileSync(nudge, '')
    const empty = takeNudge(nudge)
    expect(empty).toBe('')
    settleNudge(nudge, empty, 'done')
    expect(existsSync(nudge)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('a nudge that fails every run is parked for the operator after three tries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-nudge-'))
  try {
    const nudge = join(dir, 'nudge')
    writeFileSync(nudge, 'deploy the site\n')
    for (let run = 1; run < NUDGE_TRIES; run++) {
      settleNudge(nudge, takeNudge(nudge), 'failed')
      settleNudge(nudge, takeNudge(nudge), 'not-started') // a skipped pass is not a try
      expect(readFileSync(nudge, 'utf8')).toBe('deploy the site\n')
    }
    settleNudge(nudge, takeNudge(nudge), 'failed')
    expect(existsSync(nudge)).toBe(false)
    expect(readdirSync(dir).some((name) => /^nudge\.failed\.\d+$/u.test(name))).toBe(true)
    expect(readFileSync(join(dir, 'needs-operator'), 'utf8')).toContain('a nudge failed 3 runs')
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
    settleNudge(nudge, note, 'failed')
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

const MINUTE = 60_000
const policy = { heartbeatMs: 180 * MINUTE }
/** 22 Oct 2026, 08:00 UTC; job #18's delivery deadline is six days later. */
const T0 = Date.UTC(2026, 9, 22, 8)
const job18: HeldTask = {
  taskId: '7178ea079fc7822f',
  chain: { status: 'active', submittedAt: null },
  nextAction: { actor: 'worker', action: 'submit_work', deadline: T0 / 1000 + 6 * 86_400 },
}

/** Each pass of the member loop: the check, and a successful run recording what it saw whenever the check woke it. */
function passes(held: readonly HeldTask[], minutes: readonly number[], seen: HeldSeen = NOTHING_SEEN) {
  return minutes.map((at) => {
    const check = heldWake(held, seen, T0 + at * MINUTE, policy)
    if (check.reason !== null) seen = check.candidate
    return check.reason
  })
}

test('an active job waiting on a check wakes its worker once, then only after a three-hour heartbeat', () => {
  // Job #18 on 22 Oct: Patch held it as a draft and ran every ten minutes to find nothing new.
  const reasons = passes([job18], [0, 10, 20, 170, 180, 190])
  expect(reasons[0]).toBe('1 held job(s) new or changed: 7178ea079fc7822f')
  expect(reasons.slice(1, 4)).toEqual([null, null, null])
  expect(reasons[4]).toBe('1 held job(s) unchanged for 3 h')
  expect(reasons[5]).toBeNull()
})

/** A submitted job whose next step is `action` by `actor`. */
const submitted = (actor: string, action: string): HeldTask => ({
  taskId: 't',
  chain: { status: 'submitted', submittedAt: 100 },
  nextAction: { actor, action, deadline: null },
})

test('a review that ends in silence wakes the worker once to collect; other settlements do not wake it', () => {
  const seen = heldWake([job18], NOTHING_SEEN, T0, policy).candidate
  // Submitted: the approver's turn, so nothing wakes the worker during review.
  expect(heldWake([submitted('approver', 'approve_or_reject')], seen, T0 + MINUTE, policy).reason).toBeNull()
  const silent = heldWake([submitted('anyone', 'complete_after_silence')], seen, T0 + 2 * MINUTE, policy)
  expect(silent.reason).toBe('1 held job(s) new or changed: t')
  expect(
    heldWake([submitted('anyone', 'complete_after_silence')], silent.candidate, T0 + 3 * MINUTE, policy).reason,
  ).toBeNull()
  for (const action of ['settle_missed_delivery', 'settle_rejection', 'settle_arbitration_timeout'])
    expect(heldWake([submitted('anyone', action)], NOTHING_SEEN, T0, policy).reason).toBeNull()
})

test('a rejection the worker may dispute wakes it once, and again as its window nears its end', () => {
  const rejected: HeldTask = {
    taskId: 'r',
    chain: { status: 'rejected-pending', submittedAt: 100 },
    nextAction: { actor: 'worker', action: 'dispute_or_wait', deadline: T0 / 1000 + 86_400 },
  }
  const reasons = passes([rejected], [0, 10, 170, 180, 21 * 60 + 10, 21 * 60 + 20])
  expect(reasons.map((reason) => reason?.split(':')[0] ?? null)).toEqual([
    '1 held job(s) new or changed',
    null,
    null,
    '1 held job(s) unchanged for 3 h',
    // Inside the last heartbeat before the dispute window closes: one more look, not one every pass.
    '1 held job(s) new or changed',
    null,
  ])
})

test('jobs that leave the held set never wake, and the next look forgets them', () => {
  const other: HeldTask = { ...job18, taskId: 'other' }
  const seen = heldWake([job18, other], NOTHING_SEEN, T0, policy).candidate
  const after = heldWake([job18], seen, T0 + 10 * MINUTE, policy)
  expect(after.reason).toBeNull()
  expect(Object.keys(after.candidate.tasks)).toEqual(['7178ea079fc7822f'])
  expect(heldWake([], seen, T0 + 300 * MINUTE, policy).reason).toBeNull()
})

test('what a run saw survives a restart, is recorded only after a run that finished, and a broken file starts over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-held-'))
  try {
    const path = join(dir, 'held.json')
    expect(readHeld(path)).toEqual(NOTHING_SEEN)
    const { candidate } = heldWake([job18], readHeld(path), T0, policy)
    for (const code of [1, 124, null]) finishHeld(path, candidate, code)
    expect(existsSync(path)).toBe(false)
    finishHeld(path, candidate, 0)
    expect(readHeld(path)).toEqual(candidate)
    expect(heldWake([job18], readHeld(path), T0 + 10 * MINUTE, policy).reason).toBeNull()
    writeFileSync(path, '{"at":"soon"}')
    expect(readHeld(path)).toEqual(NOTHING_SEEN)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('a wake a member asks for is due at its time, and only the run that finished its work consumes it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-wake-at-'))
  try {
    const path = join(dir, 'wake-at')
    expect(dueWakeAt(path, T0)).toBeUndefined()
    writeFileSync(path, '2026-10-22T08:45:00Z\n')
    expect(dueWakeAt(path, T0)).toBeUndefined()
    const seen = dueWakeAt(path, T0 + 45 * MINUTE)
    expect(seen).toBe('2026-10-22T08:45:00Z')
    settleWakeAt(path, seen, 1) // a failed run asks again next pass
    expect(existsSync(path)).toBe(true)
    settleWakeAt(path, seen, 0)
    expect(existsSync(path)).toBe(false)
    // Unix seconds work too.
    writeFileSync(path, String(T0 / 1000 + 60))
    expect(dueWakeAt(path, T0 + MINUTE)).toBe(String(T0 / 1000 + 60))
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('a time written during the run is kept for the next wake, and an unreadable one is due at once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-wake-at-'))
  try {
    const path = join(dir, 'wake-at')
    writeFileSync(path, '2026-10-22T08:00:00Z')
    const seen = dueWakeAt(path, T0)
    writeFileSync(path, '2026-10-22T09:00:00Z\n') // the run asks to come back in an hour
    settleWakeAt(path, seen, 0)
    expect(dueWakeAt(path, T0)).toBeUndefined()
    expect(dueWakeAt(path, T0 + 60 * MINUTE)).toBe('2026-10-22T09:00:00Z')
    writeFileSync(path, 'in an hour')
    expect(dueWakeAt(path, T0)).toBe('in an hour')
    settleWakeAt(path, 'in an hour', 0)
    expect(existsSync(path)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true })
  }
})
