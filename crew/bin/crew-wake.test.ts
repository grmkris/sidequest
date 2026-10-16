/** `bun test crew/bin/crew-wake.test.ts`: which held jobs wake a crew worker. */
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finishWake, readCheckpoint, saveCheckpoint } from './inbox-state.ts'
import { openHeld } from './crew-wake.ts'

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
    expect(readdirSync(dir)).toEqual(['cursor', 'cursor.bak'])
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('malformed local state requests cursorless resync and keeps the last valid cursor until replacement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-cursor-'))
  try {
    const file = join(dir, 'cursor')
    saveCheckpoint(file, { cursor: 'v1:967' })
    writeFileSync(file, 'v1:9672026-10-15T00:48:08Z')
    expect(readCheckpoint(file)).toEqual({ checkpoint: { cursor: 'v1:967' }, resync: true })
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
