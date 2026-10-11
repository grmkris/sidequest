import { expect, test } from 'bun:test'
import { pipelineInventory, planPipeline, unsetHash, type PendingEpoch, type PipelineRead } from './pipeline-lib.ts'

const hash = `0x${'ab'.repeat(32)}` as const
const other = `0x${'cd'.repeat(32)}` as const
const pending = (): PendingEpoch => ({
  root: hash,
  total: 12n,
  dataHash: other,
  signature: 'signed',
  previous: null,
  leaves: 2,
  sha256: 'fixture',
})
const read = (epoch = 1n, patch: Partial<PipelineRead> = {}): PipelineRead => ({
  epoch,
  root: { root: unsetHash, total: 0n, claimed: 0n, dataHash: unsetHash },
  ended: true,
  fundingFinal: true,
  funded: 0n,
  laterFunded: false,
  anchor: null,
  signature: 'signed',
  ...patch,
})
const prices = (epoch: bigint) => `mining/prices-${epoch}.json`
const pendingKey = (epoch: bigint) => `mining/pending-epoch-${epoch}.json`
const rooted = (epoch: bigint) =>
  read(epoch, { pending: pending(), root: { root: hash, total: 12n, claimed: 0n, dataHash: other } })

test('no price lists waits without actions, and unrelated object keys are ignored', () => {
  expect(planPipeline(['mining/previous-prices-1.json', 'mining/state-1.json'], [])).toEqual({
    actions: [],
    rows: [{ epoch: null, status: 'waiting-prices', next: 'Sign and upload prices in /admin.' }],
    failed: false,
  })
})
test('an ended highest epoch with prices and no pending file computes', () => {
  expect(planPipeline([prices(1n)], [read()]).actions).toEqual([{ kind: 'compute', epoch: 1n }])
})
test('a matching pending file waits for funding, then waits for its root', () => {
  const keys = [prices(1n), pendingKey(1n)]
  expect(planPipeline(keys, [read(1n, { pending: pending() })]).rows[0]?.status).toBe('pending')
  const funded = planPipeline(keys, [read(1n, { pending: pending(), funded: 12n })])
  expect(funded.actions).toEqual([])
  expect(funded.rows[0]?.status).toBe('funded')
})
test('publish a rooted lower epoch before waiting on the higher pending epoch', () => {
  const plan = planPipeline(
    [prices(10n), pendingKey(10n), prices(9n), pendingKey(9n)],
    [rooted(9n), read(10n, { pending: pending(), anchor: null })],
  )
  expect(plan.actions).toEqual([{ kind: 'publish', epoch: 9n }])
  expect(plan.rows.map((row) => [row.epoch, row.status])).toEqual([
    [9n, 'rooted'],
    [10n, 'pending'],
  ])
})
test('publication actions are numeric and all precede the highest computation', () => {
  const plan = planPipeline([prices(11n), pendingKey(10n), pendingKey(9n)], [rooted(10n), read(11n), rooted(9n)])
  expect(plan.actions).toEqual([
    { kind: 'publish', epoch: 9n },
    { kind: 'publish', epoch: 10n },
    { kind: 'compute', epoch: 11n },
  ])
  expect(pipelineInventory([prices(10n), prices(9n), 'mining/prices-01.json']).map((entry) => entry.epoch)).toEqual([
    9n,
    10n,
  ])
})
test('published and empty epochs are terminal and never computed or published again', () => {
  const keys = [prices(9n), pendingKey(9n), prices(10n), 'mining/epoch-10.json']
  const plan = planPipeline(keys, [read(9n, { pending: { ...pending(), root: null, total: 0n } }), rooted(10n)])
  expect(plan.actions).toEqual([])
  expect(plan.rows.map((row) => row.status)).toEqual(['empty', 'published'])
})
test('a changed signature recomputes an unrooted pending epoch', () => {
  expect(
    planPipeline([prices(1n), pendingKey(1n)], [read(1n, { pending: pending(), signature: 'new-signature' })]).actions,
  ).toEqual([{ kind: 'compute', epoch: 1n }])
})
test('a changed anchor recomputes, including a missing previous checkpoint', () => {
  for (const previous of [null, 0n]) {
    const plan = planPipeline(
      [prices(2n), pendingKey(2n)],
      [read(2n, { pending: { ...pending(), previous }, anchor: 1n })],
    )
    expect(plan.actions).toEqual([{ kind: 'compute', epoch: 2n }])
  }
})
test('a rooted target without matching pending root, total or dataHash fails', () => {
  for (const patch of [{ root: other }, { total: 13n }, { dataHash: hash }]) {
    const current = rooted(1n)
    current.root = { ...current.root, ...patch }
    const plan = planPipeline([prices(1n), pendingKey(1n)], [current])
    expect(plan.failed).toBe(true)
    expect(plan.rows[0]?.status).toBe('failed:root-mismatch')
    expect(plan.actions).toEqual([])
  }
  const current = rooted(1n)
  delete current.pending
  expect(planPipeline([prices(1n)], [current]).rows[0]?.status).toBe('failed:root-mismatch')
})
test('any lower unprocessed priced epoch is abandoned when a higher candidate exists', () => {
  const plan = planPipeline([prices(1n), prices(2n)], [read(1n), read(2n)])
  expect(plan.rows[0]?.status).toBe('abandoned')
  expect(plan.actions).toEqual([{ kind: 'compute', epoch: 2n }])
})
test('later funding prevents a missing or stale target replay', () => {
  for (const current of [
    read(1n, { laterFunded: true }),
    read(1n, { laterFunded: true, pending: pending(), anchor: 0n }),
  ]) {
    const plan = planPipeline([prices(1n)], [current])
    expect(plan.actions).toEqual([])
    expect(plan.rows[0]?.status).toBe('abandoned')
    expect(plan.failed).toBe(false)
  }
})
test('an epoch before finality or nonfinal funding waits successfully', () => {
  for (const patch of [{ ended: false }, { fundingFinal: false }, { fundingFinal: false, funded: 12n }]) {
    const plan = planPipeline([prices(1n)], [read(1n, patch)])
    expect(plan.actions).toEqual([])
    expect(plan.failed).toBe(false)
    expect(plan.rows[0]?.next).toContain('Wait')
  }
})
