/** `bun test crew/bin/model-breaker.test.ts`: which model a member's next run uses. */
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLOSED, afterRun, onFallback, readBreaker, runResult, saveBreaker } from './model-breaker.ts'

const policy = { threshold: 3, cooldownMs: 60 * 60_000 }
const primary = (result: 'ok' | 'capacity' | 'failed') => ({ result, onPrimary: true })
const log = (text: string) => () => text
const unread = () => {
  throw new Error('a successful or killed run is classified without reading its log')
}

test('the breaker opens after three capacity refusals in a row on the primary', () => {
  let b = CLOSED
  b = afterRun(b, primary('capacity'), policy, 1)
  b = afterRun(b, primary('capacity'), policy, 2)
  expect(onFallback(b, policy, 3)).toBe(false)
  b = afterRun(b, primary('capacity'), policy, 3)
  expect(b).toEqual({ refusals: 3, openedAt: 3 })
  expect(onFallback(b, policy, 4)).toBe(true)
})

test('a success on the fallback does not send the member back to a primary still at capacity', () => {
  const open = { refusals: 3, openedAt: 0 }
  expect(afterRun(open, { result: 'ok', onPrimary: false }, policy, 10)).toEqual(open)
  expect(onFallback(open, policy, policy.cooldownMs - 1)).toBe(true)
})

test('after the cooldown one run probes the primary: success closes, a refusal reopens', () => {
  const open = { refusals: 3, openedAt: 0 }
  const later = policy.cooldownMs
  expect(onFallback(open, policy, later)).toBe(false)
  expect(afterRun(open, primary('ok'), policy, later)).toEqual(CLOSED)
  const reopened = afterRun(open, primary('capacity'), policy, later)
  expect(reopened).toEqual({ refusals: 4, openedAt: later })
  expect(onFallback(reopened, policy, later + 1)).toBe(true)
})

test('other failures leave the count alone; a primary success resets it', () => {
  let b = afterRun(CLOSED, primary('capacity'), policy, 1)
  b = afterRun(b, primary('failed'), policy, 2)
  expect(b).toEqual({ refusals: 1, openedAt: null })
  expect(afterRun(b, primary('ok'), policy, 3)).toEqual(CLOSED)
})

test('a run is classified from its exit code, its Codex events and its stderr', () => {
  const capacity =
    '{"type":"turn.failed","error":{"message":"Selected model is at capacity. Please try a different model."}}'
  expect(runResult(0, unread, '')).toBe('ok')
  expect(runResult(null, unread, '')).toBe('failed')
  expect(runResult(1, log(`{"type":"thread.started"}\n${capacity}\n`), '')).toBe('capacity')
  expect(runResult(1, log('{"type":"error","message":"Selected model is at capacity."}'), '')).toBe('capacity')
  expect(runResult(1, log(''), 'error: 429 rate limit reached for model')).toBe('capacity')
  expect(runResult(1, log('{"type":"turn.failed","error":{"message":"stream disconnected"}}'), '')).toBe('failed')
  // A model that only writes about capacity in its work is not refused.
  expect(runResult(1, log('{"type":"item.completed","item":{"text":"the model is at capacity"}}'), '')).toBe('failed')
})

test('the breaker survives a restart and an unreadable file starts closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-breaker-'))
  try {
    const path = join(dir, 'model-breaker.json')
    expect(readBreaker(path)).toEqual(CLOSED)
    saveBreaker(path, { refusals: 3, openedAt: 42 })
    expect(readBreaker(path)).toEqual({ refusals: 3, openedAt: 42 })
    writeFileSync(path, '{broken')
    expect(readBreaker(path)).toEqual(CLOSED)
  } finally {
    rmSync(dir, { recursive: true })
  }
})
