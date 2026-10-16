import { afterEach, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { proposedMission } from './model.ts'
import type { Action, RunMode } from './model.ts'
import { forecast } from './simulation.ts'
import { MissionStore, SimulatedPayments } from './store.ts'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})
function fixture(mode: RunMode = 'parallel') {
  const root = mkdtempSync('/tmp/commons-simulator-')
  const path = join(root, 'mission.sqlite')
  let store = new MissionStore(path)
  const provider = new SimulatedPayments(join(root, 'payments.sqlite'))
  cleanup.push(() => {
    store.close()
    provider.close()
    rmSync(root, { recursive: true })
  })
  const step = (action: Action, ticketId = '') =>
    store.command({ id: crypto.randomUUID(), revision: store.snapshot().revision, action, ticketId })
  step('approve')
  step(mode === 'parallel' ? 'run_parallel' : 'run_sequential')
  return {
    step,
    state: () => store.snapshot(),
    provider,
    store: () => store,
    restart: () => {
      store.close()
      store = new MissionStore(path)
    },
  }
}

it('forecasts the fork/join critical path and the sequential queue without changing rewards', () => {
  const mission = proposedMission('forecast')
  const parallel = forecast(mission, 'parallel')
  const sequential = forecast(mission, 'sequential')
  expect(parallel).toMatchObject({ elapsed: 28, reward: 300, criticalPath: ['02', '03', '04'] })
  expect(sequential).toMatchObject({ elapsed: 36, reward: 300, criticalPath: ['01', '02', '03', '04'] })
  expect(parallel.slots.slice(0, 2).map((s) => s.start)).toEqual([0, 0])
  expect(sequential.slots.map((s) => s.start)).toEqual([0, 8, 20, 30])
  expect(mission.approved).toBe(false)
})

it('rejects invalid graphs and durations before forecasting', () => {
  for (const dependency of ['missing', '04']) {
    const mission = proposedMission('invalid')
    mission.tickets[0]!.dependsOn = [dependency]
    expect(() => forecast(mission, 'parallel')).toThrow('cycle or missing')
  }
  const mission = proposedMission('duration')
  mission.tickets[0]!.minutes = 0
  expect(() => forecast(mission, 'parallel')).toThrow('duration')
})

it('runs siblings together but requires both accepted inputs at the join', () => {
  const f = fixture()
  expect(f.state().mission.tickets.map((t) => t.status)).toEqual(['running', 'running', 'waiting', 'waiting'])
  for (let i = 0; i < 8; i++) f.step('advance')
  expect(f.state().mission.tickets.map((t) => t.status)).toEqual(['review', 'running', 'waiting', 'waiting'])
  f.step('accept', '01')
  for (let i = 0; i < 4; i++) f.step('advance')
  expect(() => f.step('advance')).toThrow('Review')
  expect(f.state().mission.tickets[2]?.status).toBe('waiting')
  f.step('accept', '02')
  expect(f.state().mission.tickets[2]?.status).toBe('running')
  expect(f.state().mission.tickets[0]?.payment).toBe('none')
  expect(() => f.step('submit', '03')).toThrow('simulator')
  expect(() => f.step('run_sequential')).toThrow('before manually')
})

it('keeps independent work queued in sequential mode until review accepts the current ticket', () => {
  const f = fixture('sequential')
  for (let i = 0; i < 8; i++) f.step('advance')
  expect(f.state().mission.tickets.map((t) => t.status)).toEqual(['review', 'waiting', 'waiting', 'waiting'])
  expect(() => f.step('advance')).toThrow('Review')
  f.step('revise', '01')
  expect(f.state().mission.tickets.map((t) => t.status)).toEqual(['running', 'waiting', 'waiting', 'waiting'])
  expect(f.state().mission.tickets[0]?.attempt).toBe(2)
  expect(f.state().mission.simulation?.progress['01']).toBe(0)
  for (let i = 0; i < 8; i++) f.step('advance')
  f.step('accept', '01')
  expect(f.state().mission.tickets[1]?.status).toBe('running')
})

it('recovers active progress after restart and a power cut without repeating attempts or accepted work', () => {
  const f = fixture()
  for (let i = 0; i < 8; i++) f.step('advance')
  f.step('accept', '01')
  f.step('interrupt')
  const saved = f.state()
  expect(() => f.step('advance')).toThrow('Resume')
  f.restart()
  expect(f.state()).toEqual(saved)
  f.step('resume')
  f.step('advance')
  expect(f.state().mission.tickets[0]).toMatchObject({ status: 'accepted', attempt: 1 })
  expect(f.state().mission.tickets[1]).toMatchObject({ status: 'running', attempt: 1 })
  expect(f.state().mission.simulation).toMatchObject({ elapsed: 9, progress: { '01': 8, '02': 9 } })
})

for (const mode of ['parallel', 'sequential'] as const) {
  it(`finishes ${mode} at its forecast, preserves the old journal, and fences old payment commands`, () => {
    const f = fixture(mode)
    const oldId = f.state().mission.id
    for (let guard = 0; guard < 100 && f.state().mission.simulation?.status !== 'complete'; guard++) {
      for (const ticket of f.state().mission.tickets.filter((t) => t.status === 'review')) f.step('accept', ticket.id)
      if (f.state().mission.tickets.some((t) => t.status === 'running')) f.step('advance')
    }
    expect(f.state().mission.simulation).toMatchObject({ elapsed: mode === 'parallel' ? 28 : 36, status: 'complete' })
    expect(() => f.step('new_run')).toThrow('settle')
    const oldCommand = { id: crypto.randomUUID(), revision: f.state().revision, action: 'pay', ticketId: '01' } as const
    f.store().command(oldCommand)
    f.store().settle('01', f.provider, true)
    expect(f.state().mission.tickets[0]?.payment).toBe('pending')
    f.store().settle('01', f.provider)
    for (const ticketId of ['02', '03', '04']) {
      f.step('pay', ticketId)
      f.store().settle(ticketId, f.provider)
    }
    expect(f.provider.all()).toHaveLength(4)
    const history = f.state().journal
    f.step('new_run')
    expect(f.state().mission.id).not.toBe(oldId)
    expect(f.state().journal.slice(0, history.length)).toEqual(history)
    expect(() => f.store().command(oldCommand)).toThrow('earlier run')
    expect(f.provider.all()).toHaveLength(4)
  })
}

it('deduplicates a saved clock tick after restart and rejects a stale competing tick', () => {
  const f = fixture()
  const command = { id: 'tick-response-lost', revision: f.state().revision, action: 'advance', ticketId: '' } as const
  f.store().command(command)
  f.restart()
  f.store().command(command)
  expect(f.state().mission.simulation?.elapsed).toBe(1)
  expect(() => f.store().command({ ...command, id: 'other-tab' })).toThrow('Another tab')
  expect(f.state().mission.simulation?.elapsed).toBe(1)
})
