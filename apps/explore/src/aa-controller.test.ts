import * as sdk from '@sidequest/sdk'
import { Schema } from 'effect'
import { encodeAbiParameters, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { BrowserUserOp, type UserOpDependencies, type UserOpView } from './aa-controller.ts'
import { browserAaRpc } from './aa-request.ts'
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
  sequence = 0n
  delegated = true
  reverted = false
  log: string[] = []
  signed: string[] = []
  answer = async (method: string) => {
    this.log.push(method)
    if (method === 'eth_getCode') return this.code()
    if (method === 'eth_blockNumber') return '0x10'
    if (method === 'eth_getLogs') return []
    if (method === 'eth_getUserOperationByHash') return null
    if (method === 'pimlico_getTokenQuotes')
      return { quotes: [{ paymaster: base.admin, exchangeRate: '0x1', postOpGas: '0x1' }] }
    if (method === 'pimlico_getUserOperationGasPrice')
      return { fast: { maxFeePerGas: toHex(1_000_000_000n), maxPriorityFeePerGas: '0x1' } }
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
    if (method === 'eth_sendUserOperation') {
      expect(this.stored?.aa?.built?.op.signature).not.toBe(sdk.ESTIMATE_SIGNATURE)
      expect(this.stored?.aa?.submittedAt).toBe(this.time)
      if (this.lost) throw new Error('lost answer')
      this.hasReceipt = true
      return this.stored!.aa!.built!.userOpHash
    }
    if (method === 'eth_getUserOperationReceipt')
      return this.hasReceipt
        ? { success: !this.reverted, actualGasCost: '0x10', receipt: { transactionHash: txHash } }
        : null
    throw new Error(`Unexpected ${method}`)
  }
  fetcher: typeof fetch = async (_input, init) => {
    const body = Schema.decodeUnknownSync(RequestBody)(JSON.parse(Schema.decodeUnknownSync(Schema.String)(init?.body)))
    const result =
      body.method === 'eth_call'
        ? word(JSON.stringify(body.params).includes('0x35567e1a') ? this.sequence : 0n)
        : await this.answer(body.method)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
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

  it('reconciles a reload and never rebuilds or resends during the 120-second pending window', async () => {
    const f = fixture(),
      controller = new BrowserUserOp(f.deps)
    await controller.load()
    await controller.prepare()
    f.loseSend(true)
    await expect(controller.send()).rejects.toMatchObject({ code: 'uncertain' })
    const original = f.record()?.aa?.built
    const restored = new BrowserUserOp(f.deps)
    await restored.load()
    await restored.send()
    expect(f.log.filter((method) => method === 'eth_sendUserOperation')).toHaveLength(1)
    expect(f.record()?.aa?.built).toEqual(original)
    expect(f.view()?.pending).toBe(true)
    f.clock(1_120_001)
    f.loseSend(false)
    await restored.reconcile()
    await restored.send()
    expect(f.log.filter((method) => method === 'eth_sendUserOperation')).toHaveLength(2)
    expect(f.record()?.aa?.built).toEqual(original)
    expect(f.signed).toHaveLength(1)
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
  const deps = { ...f.deps, sponsor: 'faucet' as const, authorize: async () => authorization }
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
