import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { decide, findTicket, ready } from './model.ts'
import type { Action } from './model.ts'
import { MissionStore, SimulatedPayments } from './store.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const open = () => {
  const root = join('/tmp', `commons-durable-${crypto.randomUUID()}`)
  mkdirSync(root, { recursive: true })
  roots.push(root)
  return {
    root,
    store: new MissionStore(join(root, 'mission.sqlite')),
    provider: new SimulatedPayments(join(root, 'payments.sqlite')),
  }
}
const step = (store: MissionStore, action: Action, ticketId = '') => {
  const state = store.snapshot()
  return store.command({ id: crypto.randomUUID(), revision: state.revision, action, ticketId })
}
const acceptFirst = (store: MissionStore) => {
  step(store, 'approve')
  step(store, 'start', '01')
  step(store, 'submit', '01')
  step(store, 'accept', '01')
}

describe('durable mission journal', () => {
  it('recovers a provider receipt after the response is lost without paying twice', () => {
    const { root, store, provider } = open()
    step(store, 'approve', '')
    step(store, 'start', '01')
    step(store, 'submit', '01')
    step(store, 'accept', '01')
    const before = store.snapshot()
    store.command({ id: crypto.randomUUID(), revision: before.revision, action: 'lose_reply', ticketId: '01' })
    store.settle('01', provider, true)
    expect(store.snapshot().mission.tickets[0]?.payment).toBe('pending')
    expect(provider.all()).toHaveLength(1)
    store.close()
    provider.close()
    const restarted = new MissionStore(join(root, 'mission.sqlite'))
    const restartedProvider = new SimulatedPayments(join(root, 'payments.sqlite'))
    const pending = restarted.snapshot()
    expect(pending.journal.at(-1)?.event.type).toBe('payment_prepared')
    restarted.command({ id: crypto.randomUUID(), revision: pending.revision, action: 'reconcile', ticketId: '01' })
    restarted.settle('01', restartedProvider)
    expect(restarted.snapshot().mission.tickets[0]?.payment).toBe('confirmed')
    expect(restartedProvider.all()).toHaveLength(1)
    restarted.close()
    restartedProvider.close()
  })

  it('replays the journal after a coordinator restart', () => {
    const { root, store, provider } = open()
    const id = store.snapshot().mission.id
    store.close()
    provider.close()
    const restarted = new MissionStore(join(root, 'mission.sqlite'))
    expect(restarted.snapshot().mission.id).toBe(id)
    expect(restarted.snapshot().revision).toBe(1)
    restarted.close()
  })

  it('recovers a crash after intent commit but before provider dispatch', () => {
    const { root, store, provider } = open()
    acceptFirst(store)
    step(store, 'pay', '01')
    expect(provider.all()).toHaveLength(0)
    const before = store.snapshot()
    store.close()
    const restarted = new MissionStore(join(root, 'mission.sqlite'))
    expect(restarted.snapshot()).toEqual(before)
    expect(provider.all()).toHaveLength(0)
    restarted.settle('01', provider)
    restarted.settle('01', provider)
    expect(provider.all()).toHaveLength(1)
    expect(restarted.snapshot().journal.filter((e) => e.event.type === 'payment_confirmed')).toHaveLength(1)
    restarted.close()
    provider.close()
  })

  it('refuses a side effect without durable intent, and refuses payment before acceptance', () => {
    const { store, provider } = open()
    step(store, 'approve')
    step(store, 'start', '01')
    step(store, 'submit', '01')
    const before = store.snapshot()
    expect(() => store.settle('01', provider)).toThrow('No persisted payment intent')
    expect(() => step(store, 'pay', '01')).toThrow('Only accepted')
    expect(store.snapshot()).toEqual(before)
    expect(provider.all()).toHaveLength(0)
    store.close()
    provider.close()
  })

  it('keeps downstream work blocked during rework and unlocks on acceptance before payment', () => {
    const { store, provider } = open()
    step(store, 'approve')
    step(store, 'start', '01')
    step(store, 'submit', '01')
    step(store, 'revise', '01')
    expect(() => step(store, 'start', '02')).toThrow('prerequisites')
    step(store, 'start', '01')
    step(store, 'submit', '01')
    step(store, 'accept', '01')
    step(store, 'start', '02')
    const mission = store.snapshot().mission
    expect(findTicket(mission, '01').attempt).toBe(2)
    expect(findTicket(mission, '01').payment).toBe('none')
    expect(ready(mission, findTicket(mission, '03'))).toBe(false)
    expect(provider.all()).toHaveLength(0)
    store.close()
    provider.close()
  })

  it('commits one winner across two coordinator handles with the same revision', () => {
    const { root, store, provider } = open()
    step(store, 'approve')
    const second = new MissionStore(join(root, 'mission.sqlite'))
    const revision = second.snapshot().revision
    step(store, 'start', '01')
    expect(() => second.command({ id: 'racing-tab', revision, action: 'start', ticketId: '01' })).toThrow('Another tab')
    expect(findTicket(second.snapshot().mission, '01').attempt).toBe(1)
    second.close()
    store.close()
    provider.close()
  })

  it('deduplicates a lost command response across restart and rejects changed input for that ID', () => {
    const { root, store, provider } = open()
    const command = { id: 'lost-command', revision: 1, action: 'approve', ticketId: '' } as const
    store.command(command)
    const before = store.snapshot()
    store.close()
    const restarted = new MissionStore(join(root, 'mission.sqlite'))
    expect(restarted.command(command)).toEqual(before)
    expect(() => restarted.command({ ...command, action: 'start', ticketId: '01' })).toThrow('reused')
    expect(restarted.snapshot()).toEqual(before)
    restarted.close()
    provider.close()
  })

  it('retains accepted work and pending payment after a simulated provider outage', () => {
    const { root, store, provider } = open()
    acceptFirst(store)
    step(store, 'pay', '01')
    provider.close()
    expect(() => store.settle('01', provider)).toThrow()
    const ticket = findTicket(store.snapshot().mission, '01')
    expect(ticket.status).toBe('accepted')
    expect(ticket.payment).toBe('pending')
    const restored = new SimulatedPayments(join(root, 'payments.sqlite'))
    store.settle('01', restored)
    expect(restored.all()).toHaveLength(1)
    store.close()
    restored.close()
  })

  it('settles all three independent rewards without exceeding the approved cap', () => {
    const { store, provider } = open()
    step(store, 'approve')
    for (const id of ['01', '02', '03']) {
      step(store, 'start', id)
      step(store, 'submit', id)
      step(store, 'accept', id)
      step(store, 'pay', id)
      store.settle(id, provider)
    }
    expect(provider.all().reduce((sum, receipt) => sum + receipt.amount, 0)).toBe(300)
    expect(new Set(provider.all().map((r) => r.worker)).size).toBe(3)
    expect(() => step(store, 'pay', '01')).toThrow('unpaid')
    expect(provider.all()).toHaveLength(3)
    store.close()
    provider.close()
  })

  it('rejects altered provider terms under a saved payment operation', () => {
    const { store, provider } = open()
    acceptFirst(store)
    step(store, 'pay', '01')
    store.settle('01', provider, true)
    const receipt = provider.all()[0]
    if (!receipt) throw new Error('Missing receipt')
    expect(() => provider.pay(receipt.operationId, { worker: 'other-worker', reward: receipt.amount })).toThrow(
      'terms changed',
    )
    expect(provider.all()).toHaveLength(1)
    store.close()
    provider.close()
  })

  it('refuses approval when rewards exceed the declared budget', () => {
    const { store, provider } = open()
    const mission = store.snapshot().mission
    mission.budget = 299
    expect(() => decide(mission, { id: 'budget', revision: 1, action: 'approve', ticketId: '' })).toThrow('budget')
    store.close()
    provider.close()
  })
})
