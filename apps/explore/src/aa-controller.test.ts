import * as sdk from '@sidequest/sdk'
import { Schema } from 'effect'
import { encodeAbiParameters, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { BrowserUserOp, type UserOpDependencies, type UserOpView } from './aa-controller.ts'
import { browserAaRpc } from './aa-request.ts'
import { faucetClaim } from './faucet-claim.ts'
import type { OpRecord } from './components/txJournal.ts'

const key = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const base = sdk.deployment('monad-testnet')
const deployment = { ...base, aa: { ...base.aa!, paymaster: base.admin } }
const txHash = `0x${'ab'.repeat(32)}` as const
const word = (value: bigint) => encodeAbiParameters([{ type: 'uint256' }], [value])
const RequestBody = Schema.Struct({ method: Schema.String, params: Schema.Array(Schema.Unknown) })

class FakeFixture {
  stored: OpRecord | null = null
  currentView: UserOpView | null = null
  time = 1_000_000
  hasReceipt = false
  lost = false
  rejectWrite = false
  reportFails = false
  refused = false
  fee = 1_000_000_000n
  sequence = 0n
  balance = 0n
  delegated = true
  reverted = false
  quietReceipt = false
  quietLogs = false
  log: string[] = []
  signed: string[] = []
  answer = async (method: string) => {
    this.log.push(method)
    if (method === 'eth_getCode') return this.code()
    if (method === 'eth_getBalance') return toHex(this.balance)
    if (method === 'eth_blockNumber') return '0x10'
    if (method === 'eth_getLogs') {
      if (this.quietLogs) throw new Error('quiet logs')
      return []
    }
    if (method === 'eth_getUserOperationByHash') return null
    if (method === 'pimlico_getTokenQuotes')
      return { quotes: [{ paymaster: base.admin, exchangeRate: '0x1', postOpGas: '0x1' }] }
    if (method === 'pimlico_getUserOperationGasPrice')
      return { fast: { maxFeePerGas: toHex(this.fee), maxPriorityFeePerGas: '0x1' } }
    if (method === 'eth_estimateUserOperationGas')
      return {
        callGasLimit: '0x30d40',
        verificationGasLimit: '0xf000',
        preVerificationGas: '0x19000',
        paymasterVerificationGasLimit: '0xb000',
        paymasterPostOpGasLimit: '0xa000',
      }
    if (method === 'pm_getPaymasterStubData' || method === 'pm_getPaymasterData')
      return { paymaster: base.admin, paymasterData: '0x00' }
    if (method === 'eth_sendUserOperation') return this.sendAnswer()
    if (method === 'eth_getUserOperationReceipt') return this.receiptAnswer()
    throw new Error(`Unexpected ${method}`)
  }
  sendAnswer() {
    expect(this.stored?.aa?.built?.op.signature).not.toBe(sdk.ESTIMATE_SIGNATURE)
    expect(this.stored?.aa?.submittedAt).toBe(this.time)
    if (this.lost) throw new Error('lost answer')
    if (this.refused) throw new sdk.AaError('refused', 'gas moved')
    this.hasReceipt = true
    return this.stored!.aa!.built!.userOpHash
  }
  receiptAnswer() {
    if (this.quietReceipt) throw new Error('quiet receipt')
    return this.hasReceipt
      ? { success: !this.reverted, actualGasCost: '0x10', receipt: { transactionHash: txHash } }
      : null
  }
  fetcher: typeof fetch = async (_input, init) => {
    const body = Schema.decodeUnknownSync(RequestBody)(JSON.parse(Schema.decodeUnknownSync(Schema.String)(init?.body)))
    try {
      const result =
        body.method === 'eth_call'
          ? word(JSON.stringify(body.params).includes('0x35567e1a') ? this.sequence : 0n)
          : await this.answer(body.method)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
    } catch (error) {
      if (error instanceof sdk.AaError)
        return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: error.message } })
      throw error
    }
  }
  deps = fixtureDependencies(this)
  code() {
    return this.delegated ? `0xef0100${base.delegation.delegator.slice(2)}` : '0x'
  }
  record() {
    return this.stored
  }
  view() {
    return this.currentView
  }
  clock(value: number) {
    this.time = value
  }
  loseSend(value: boolean) {
    this.lost = value
  }
  rejectPersistence() {
    this.rejectWrite = true
  }
  failReport(value: boolean) {
    this.reportFails = value
  }
  consumeLane() {
    this.sequence = 1n
  }
}
function fixtureDependencies(state: FakeFixture): UserOpDependencies {
  return {
    rpc: browserAaRpc('http://node.invalid', 'http://api.invalid', state.fetcher),
    deployment,
    sender: key.address,
    txs: [{ description: 'Publish a job', chainId: base.chainId, to: base.core, data: '0x1234', value: '0' }],
    minCallGas: 400_000n,
    read: async () => state.stored,
    write: async (next) => {
      if (state.rejectWrite && next.aa?.built !== undefined) throw new Error('storage failed')
      state.stored = structuredClone(next)
    },
    guard: async () => {},
    authorize: async () => undefined,
    sign: async (typedData, description) => {
      state.signed.push(description)
      return key.signTypedData(typedData)
    },
    report: async () => {
      state.log.push('report')
      if (state.reportFails) throw new Error('board unavailable')
    },
    verify: async () => {},
    done: () => {
      state.log.push('done')
    },
    changed: (next) => {
      state.currentView = next
    },
    now: () => state.time,
    pause: async () => {},
  }
}
const fixture = () => new FakeFixture()

describe('persisted browser user-operation sending', () => {
  it('shows the bound before signing, persists the signed op before send, and reports the bundle receipt', async () => {
    const f = fixture(),
      controller = new BrowserUserOp(f.deps)
    await controller.load()
    await controller.prepare()
    expect(f.signed).toEqual([])
    expect(f.view()?.built?.op.callGasLimit).toBe(400_000n)
    await controller.send()
    expect(f.signed[0]).toContain('gas in USDC')
    expect(f.record()?.recorded).toEqual([true])
    expect(f.record()?.hashes).toEqual([txHash])
    expect(f.log.indexOf('eth_sendUserOperation')).toBeLessThan(f.log.indexOf('report'))
    // The real journal is JSON in localStorage: a bigint in the saved receipt failed every save after a landed op.
    expect(() => JSON.stringify(f.record())).not.toThrow()
    expect(f.record()?.aa?.receipt).toEqual({ txHash, status: 'success' })
  })

  it('never sends when the signed operation cannot be persisted', async () => {
    const f = fixture(),
      controller = new BrowserUserOp(f.deps)
    await controller.load()
    await controller.prepare()
    f.rejectPersistence()
    await expect(controller.send()).rejects.toThrow('storage failed')
    expect(f.log).not.toContain('eth_sendUserOperation')
    expect(f.record()?.aa?.built).toBeUndefined()
  })

  it('clears a definite refusal so the next send rebuilds gas and asks for a new signature', async () => {
    const f = fixture()
    const controller = new BrowserUserOp(f.deps)
    await controller.load()
    await controller.prepare()
    f.refused = true
    await expect(controller.send()).rejects.toThrow('Gas prices moved before it went out; review and confirm again.')
    expect(f.record()?.aa).toEqual({ actionId: f.record()!.aa!.actionId, outcome: 'refused', block: '0x10' })
    expect(f.signed).toHaveLength(1)
    f.refused = false
    f.fee++
    await controller.prepare()
    await controller.send()
    expect(f.signed).toHaveLength(2)
    expect(f.log.filter((method) => method === 'eth_sendUserOperation')).toHaveLength(2)
  })

  it('reconciles a reload and never rebuilds or resends during the 120-second pending window', async () => {
    const f = fixture(),
      controller = new BrowserUserOp(f.deps)
    await controller.load()
    await controller.prepare()
    f.loseSend(true)
    await expect(controller.send()).rejects.toMatchObject({ code: 'uncertain' })
    const original = f.record()?.aa?.built
    const restored = new BrowserUserOp(f.deps)
    const originalAction = f.record()!.aa!.actionId
    await restored.load()
    await restored.send()
    expect(f.log.filter((method) => method === 'eth_sendUserOperation')).toHaveLength(1)
    expect(f.record()?.aa?.built).toEqual(original)
    expect(f.view()?.pending).toBe(true)
    f.clock(1_120_001)
    f.loseSend(false)
    await restored.reconcile()
    expect(f.record()?.aa?.built).toBeUndefined()
    await expect(restored.send()).rejects.toThrow('Review the gas cost first.')
    f.fee++
    await restored.prepare()
    await restored.send()
    expect(f.log.filter((method) => method === 'eth_sendUserOperation')).toHaveLength(2)
    expect(f.record()?.aa?.built).not.toEqual(original)
    expect(f.record()?.aa?.actionId).toBe(originalAction)
    expect(f.record()?.aa?.built?.op.nonce).toBe(original!.op.nonce)
    expect(f.signed).toHaveLength(2)
  })

  it('keeps a mined action when reporting fails and retries only the report after reload', async () => {
    const f = fixture(),
      controller = new BrowserUserOp(f.deps)
    await controller.load()
    await controller.prepare()
    f.failReport(true)
    await expect(controller.send()).rejects.toThrow('board unavailable')
    expect(f.record()?.aa?.receipt?.txHash).toBe(txHash)
    f.failReport(false)
    await new BrowserUserOp(f.deps).load()
    expect(f.log.filter((method) => method === 'eth_sendUserOperation')).toHaveLength(1)
    expect(f.record()?.recorded).toEqual([true])
  })

  it('refuses to retry a consumed nonce lane with no receipt evidence', async () => {
    const f = fixture(),
      controller = new BrowserUserOp(f.deps)
    await controller.load()
    await controller.prepare()
    f.loseSend(true)
    await expect(controller.send()).rejects.toMatchObject({ code: 'uncertain' })
    f.consumeLane()
    f.clock(1_120_001)
    await expect(new BrowserUserOp(f.deps).load()).rejects.toThrow('lane was used')
    expect(f.log.filter((method) => method === 'eth_sendUserOperation')).toHaveLength(1)
    expect(f.log.filter((method) => method === 'eth_estimateUserOperationGas')).toHaveLength(1)
    expect(f.signed).toHaveLength(1)
    await expect(controller.prepare()).rejects.toThrow('lane was used')
    await expect(controller.send()).rejects.toThrow('lane was used')
  })
})

it('the first faucet operation carries authorization and only its one faucet call', async () => {
  const f = fixture()
  f.delegated = false
  const signedAuthorization = await key.signAuthorization({
    chainId: base.chainId,
    contractAddress: base.delegation.delegator,
    nonce: 0,
  })
  const authorization: sdk.SignedAuthorization = {
    ...signedAuthorization,
    yParity: signedAuthorization.yParity ?? 0,
  }
  const deps = {
    ...f.deps,
    txs: faucetClaim(base, key.address, 0n).txs,
    sponsor: 'faucet' as const,
    authorize: async () => authorization,
  }
  const controller = new BrowserUserOp(deps)
  await controller.load()
  await controller.prepare()
  expect(f.view()?.built?.authorization).toEqual(authorization)
  expect(f.view()?.built?.maxCost).toBe(0n)
  expect(sdk.decodeExecuteCalldata(f.view()!.built!.op.callData)).toHaveLength(1)
  await controller.send()
  expect(f.signed[0]).toContain('no MON needed')
})

it('a reverted receipt remains saved and cannot cause another broadcast', async () => {
  const f = fixture(),
    controller = new BrowserUserOp(f.deps)
  f.reverted = true
  await controller.load()
  await controller.prepare()
  await expect(controller.send()).rejects.toThrow('Gas was charged')
  await expect(new BrowserUserOp(f.deps).load()).rejects.toThrow('Gas was charged')
  expect(f.log.filter((method) => method === 'eth_sendUserOperation')).toHaveLength(1)
  expect(f.log).not.toContain('report')
})

it('retains an uncertain signed attempt beyond 120 seconds when receipt reads fail', async () => {
  const f = fixture()
  const controller = new BrowserUserOp(f.deps)
  await controller.load()
  await controller.prepare()
  f.loseSend(true)
  await expect(controller.send()).rejects.toMatchObject({ code: 'uncertain' })
  const original = f.record()!.aa!.built
  f.quietReceipt = true
  f.clock(1_120_001)
  await expect(controller.reconcile()).rejects.toThrow('receipt is unavailable')
  await expect(controller.prepare()).rejects.toThrow('receipt is unavailable')
  await expect(controller.send()).rejects.toThrow('receipt is unavailable')
  expect(f.record()!.aa!.built).toEqual(original)
  expect(f.signed).toHaveLength(1)
  expect(f.log.filter((method) => method === 'eth_estimateUserOperationGas')).toHaveLength(1)
  expect(f.log.filter((method) => method === 'eth_sendUserOperation')).toHaveLength(1)
})
it('persists spent proof when logs fail and never rebuilds across reload and nonce-provider drift', async () => {
  const f = fixture()
  const controller = new BrowserUserOp(f.deps)
  await controller.load()
  await controller.prepare()
  f.loseSend(true)
  await expect(controller.send()).rejects.toMatchObject({ code: 'uncertain' })
  f.consumeLane()
  f.quietLogs = true
  f.clock(1_120_001)
  await expect(controller.reconcile()).rejects.toThrow('lane was used')
  expect(f.record()!.aa!.spent).toBe(true)
  const original = f.record()!.aa!.built
  f.sequence = 0n
  const restored = new BrowserUserOp(f.deps)
  await expect(restored.load()).rejects.toThrow('lane was used')
  await expect(restored.prepare()).rejects.toThrow('lane was used')
  await expect(restored.send()).rejects.toThrow('lane was used')
  expect(f.record()!.aa!.built).toEqual(original)
  expect(f.signed).toHaveLength(1)
  expect(f.log.filter((method) => method === 'eth_estimateUserOperationGas')).toHaveLength(1)
  expect(f.log.filter((method) => method === 'eth_sendUserOperation')).toHaveLength(1)
})

const MON = 10n ** 18n
const sends = (f: FakeFixture) => f.log.filter((method) => method === 'eth_sendUserOperation')
const paymasterAsked = (f: FakeFixture) =>
  f.log.filter((method) => method.startsWith('pm_') || method === 'pimlico_getTokenQuotes')
async function upgrade(): Promise<sdk.SignedAuthorization> {
  const signed = await key.signAuthorization({
    chainId: base.chainId,
    contractAddress: base.delegation.delegator,
    nonce: 0,
  })
  return { ...signed, yParity: signed.yParity ?? 0 }
}

describe('MON-paid user operations', () => {
  it('upgrades and batches a MON-only wallet in one operation, asking no paymaster and persisting the lane', async () => {
    const f = fixture()
    f.balance = 20n * MON
    f.delegated = false
    const authorization = await upgrade()
    const controller = new BrowserUserOp({ ...f.deps, payment: 'native', authorize: async () => authorization })
    await controller.load()
    expect(f.record()?.aa?.payment).toBe('native')
    expect(controller.payment).toBe('native')
    await controller.prepare()
    const built = f.view()!.built!
    expect(built.op.paymaster).toBeUndefined()
    expect(built.authorization).toEqual(authorization)
    expect(sdk.decodeExecuteCalldata(built.op.callData)).toHaveLength(1)
    expect(built.maxCost).toBe(sdk.maxNativeCost(built.op))
    expect(f.signed).toEqual([])
    await controller.send()
    expect(f.signed[0]).toContain('MON gas')
    expect(f.signed[0]).not.toContain('USDC')
    expect(paymasterAsked(f)).toEqual([])
    expect(f.record()?.aa?.payment).toBe('native')
    expect(f.record()?.aa?.built?.op.eip7702Auth?.address).toBe(base.delegation.delegator)
    expect(f.record()?.recorded).toEqual([true])
    expect(f.log.indexOf('eth_sendUserOperation')).toBeLessThan(f.log.indexOf('report'))
  })

  it('keeps the MON lane across a refusal and a reload, and never resends in the pending window', async () => {
    const f = fixture()
    f.balance = 20n * MON
    const controller = new BrowserUserOp({ ...f.deps, payment: 'native' })
    await controller.load()
    const actionId = f.record()!.aa!.actionId
    await controller.prepare()
    f.refused = true
    await expect(controller.send()).rejects.toThrow('Gas prices moved before it went out')
    expect(f.record()?.aa).toEqual({ actionId, payment: 'native', outcome: 'refused', block: '0x10' })
    f.refused = false
    // A reload opened for USDC rebuilds the saved action on its own lane, on the same nonce.
    const restored = new BrowserUserOp({ ...f.deps, payment: 'token' })
    await restored.load()
    await restored.prepare()
    expect(f.view()?.built?.op.paymaster).toBeUndefined()
    f.loseSend(true)
    await expect(restored.send()).rejects.toMatchObject({ code: 'uncertain' })
    expect(f.record()?.aa?.payment).toBe('native')
    const again = new BrowserUserOp(f.deps)
    await again.load()
    await again.send()
    expect(sends(f)).toHaveLength(2)
    expect(f.signed).toHaveLength(2)
    expect(BigInt(f.record()!.aa!.built!.op.nonce)).toBe(sdk.laneNonce(sdk.nonceKey(actionId)))
    expect(paymasterAsked(f)).toEqual([])
  })

  it("refuses before signing above the MON ceiling or past Monad's reserve", async () => {
    const short = fixture()
    short.balance = 10n * MON
    const reserve = new BrowserUserOp({ ...short.deps, payment: 'native' })
    await reserve.load()
    await expect(reserve.prepare()).rejects.toMatchObject({ code: 'ceiling' })
    const dear = fixture()
    dear.balance = 1_000n * MON
    dear.fee = 10n ** 13n
    const ceiling = new BrowserUserOp({ ...dear.deps, payment: 'native' })
    await ceiling.load()
    await expect(ceiling.prepare()).rejects.toMatchObject({ code: 'ceiling' })
    expect(short.signed.concat(dear.signed)).toEqual([])
    expect(sends(short).concat(sends(dear))).toEqual([])
  })

  it('refuses a saved operation whose lane and paymaster disagree', async () => {
    const f = fixture()
    f.balance = 20n * MON
    const controller = new BrowserUserOp({ ...f.deps, payment: 'native' })
    await controller.load()
    await controller.prepare()
    f.loseSend(true)
    await expect(controller.send()).rejects.toMatchObject({ code: 'uncertain' })
    const { payment: _payment, ...asUsdc } = f.stored!.aa!
    f.stored = { ...f.stored!, aa: asUsdc }
    await expect(new BrowserUserOp(f.deps).load()).rejects.toThrow('differs from the reviewed')
    const paid = fixture()
    const usdc = new BrowserUserOp(paid.deps)
    await usdc.load()
    await usdc.prepare()
    paid.loseSend(true)
    await expect(usdc.send()).rejects.toMatchObject({ code: 'uncertain' })
    paid.stored = { ...paid.stored!, aa: { ...paid.stored!.aa!, payment: 'native' } }
    await expect(new BrowserUserOp(paid.deps).load()).rejects.toThrow('differs from the reviewed')
    expect(sends(f)).toHaveLength(1)
    expect(sends(paid)).toHaveLength(1)
  })
})
