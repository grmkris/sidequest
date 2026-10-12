import { afterEach, expect, it } from 'vitest'
import * as sdk from '@sidequest/sdk'
import { encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem'
import { UserOpDesk } from './userop-desk.ts'
import { userOpFixture } from './test/userop-fixture.ts'
const fixtures: ReturnType<typeof userOpFixture>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.db.close()
})
function fixture() {
  const f = userOpFixture()
  fixtures.push(f)
  return f
}
const txHash = `0x${'cd'.repeat(32)}` as const

it('persists before every RPC/sign/send and duplicate concurrent submits send only once across desk instances', async () => {
  const f = fixture()
  const other = new UserOpDesk(f.desk.deps)
  const results = await Promise.all([f.desk.submit(f.input), other.submit(f.input)])
  expect(results.map((r) => r.status)).toEqual(['pending', 'pending'])
  expect(f.state.sends).toBe(1)
  expect(f.state.signs).toBe(1)
  expect(f.store.attempts(f.input.id)[0]).toMatchObject({ sent_at: f.clock.now, outcome: 'pending' })
  await expect(f.desk.submit({ ...f.input, calls: [] })).rejects.toThrow('identity')
})
it('finishes by bundler receipt, survives restart and does not require a renewed gas budget to reconcile', async () => {
  const f = fixture()
  await f.desk.submit(f.input)
  f.state.receipt = { success: true, actualGasCost: '0x99', receipt: { transactionHash: txHash } }
  f.sql.run("UPDATE grants SET status='revoked'")
  expect(await f.desk.submit(f.input)).toMatchObject({ status: 'confirmed', txHash, actualGasCost: '153' })
  expect(f.state.sends).toBe(1)
  expect(await f.desk.operation(f.input.id)).toMatchObject({ status: 'confirmed', txHash })
})
it('waits for pending and uncertain sends for 120 seconds; read polling does not reset the timeout', async () => {
  const f = fixture()
  f.state.uncertain = true
  expect(await f.desk.submit(f.input)).toMatchObject({ status: 'pending', txHash: null })
  expect(f.store.require(f.input.id).status).toBe('uncertain')
  f.clock.now += 100
  await f.desk.operation(f.input.id)
  f.clock.now += 19
  await f.desk.submit(f.input)
  expect(f.state.sends).toBe(1)
  f.clock.now++
  expect(await f.desk.operation(f.input.id)).toMatchObject({ status: 'dropped' })
  expect(f.state.sends).toBe(1)
})
it('rebuilds a dropped attempt on its original nonce lane and finds a receipt for an older hash', async () => {
  const f = fixture()
  await f.desk.submit(f.input)
  const first = f.state.hash
  f.clock.now += 120
  f.state.fee++
  await f.desk.submit(f.input)
  const attempts = f.store.attempts(f.input.id)
  expect(attempts).toHaveLength(2)
  expect(attempts[0]!.userop_hash).toBe(first)
  f.state.receipts[first] = { success: true, actualGasCost: '0x1', receipt: { transactionHash: txHash } }
  expect(await f.desk.operation(f.input.id)).toMatchObject({ status: 'confirmed', userOpHash: first, txHash })
  expect(f.state.sends).toBe(2)
  expect(new Set(attempts.map((a) => JSON.parse(a.built_json).op.nonce)).size).toBe(1)
})
it('reuses identical signed bytes after a drop, without creating a duplicate signed hash', async () => {
  const f = fixture()
  await f.desk.submit(f.input)
  f.clock.now += 120
  await f.desk.submit(f.input)
  expect(f.state.sends).toBe(2)
  expect(f.state.signs).toBe(1)
  expect(f.store.attempts(f.input.id)).toHaveLength(1)
  expect(f.store.attempts(f.input.id)[0]!.sent_at).toBe(f.clock.now)
})
it('never rebuilds a spent lane even without its event, and resolves its matching EntryPoint event', async () => {
  const f = fixture()
  await f.desk.submit(f.input)
  f.state.sequence = 1n
  f.clock.now += 121
  expect(await f.desk.submit(f.input)).toMatchObject({ status: 'pending' })
  expect(f.state.sends).toBe(1)
  expect(f.store.require(f.input.id).status).toBe('spent')
  f.state.sequence = 0n
  f.clock.now += 121
  expect(await new UserOpDesk(f.desk.deps).submit(f.input)).toMatchObject({ status: 'pending' })
  expect(f.state.sends).toBe(1)
  expect(f.state.estimates).toBe(1)
  const event = parseAbi([
    'event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)',
  ])
  const topics = encodeEventTopics({
    abi: event,
    eventName: 'UserOperationEvent',
    args: { userOpHash: f.state.hash, sender: f.account.address, paymaster: f.context.deployment.aa!.paymaster! },
  })
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
    [sdk.laneNonce(sdk.nonceKey(f.input.id)), false, 44n, 55n],
  )
  f.state.logs = [{ address: f.context.deployment.aa!.entryPoint, topics, data, transactionHash: txHash }]
  expect(await f.desk.operation(f.input.id)).toMatchObject({ status: 'reverted', txHash, actualGasCost: '44' })
  expect(f.state.sends).toBe(1)
})
it('journals a first-op 7702 authorization for an active undelegated agent', async () => {
  const f = fixture()
  f.state.code = 'empty'
  await f.desk.submit(f.input)
  expect(f.store.require(f.input.id).authorization_json).toContain(f.context.deployment.delegation.delegator)
  expect(f.state.sends).toBe(1)
})
it('keeps the payout gas reserve and prefix overhead despite a smaller bundler estimate', async () => {
  const f = fixture()
  await f.desk.submit(f.input)
  expect(BigInt(JSON.parse(f.store.require(f.input.id).built_json!).op.callGasLimit)).toBeGreaterThanOrEqual(1_340_000n)
})
it('refuses above-ceiling gas and missing gas budget before any signature or send', async () => {
  const f = fixture()
  f.state.ceiling = true
  await expect(f.desk.submit(f.input)).rejects.toMatchObject({ reason: 'aa-ceiling' })
  expect(f.store.require(f.input.id).status).toBe('building')
  expect(f.state.sends).toBe(0)
  expect(f.state.signs).toBe(0)
  f.sql.run("UPDATE grants SET status='revoked'")
  await expect(f.desk.submit(f.input)).rejects.toMatchObject({ reason: 'gas-budget-required' })
})
it('marks bundler refusals retryable, and does not turn service read failures into a new send', async () => {
  const f = fixture()
  f.state.refused = true
  await expect(f.desk.submit(f.input)).rejects.toMatchObject({ reason: 'aa-refused' })
  expect(f.store.require(f.input.id).status).toBe('dropped')
  expect(f.state.sends).toBe(1)
  expect(await f.desk.operation('missing')).toBeUndefined()
})
