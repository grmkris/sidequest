import { type Address, type Hex, decodeFunctionData, encodeAbiParameters, erc20Abi, size, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { decodeExecuteCalldata } from '../batch.ts'
import type { AccountAbstraction } from '../deployment.ts'
import { buildUserOp, sendUserOp, userOpReceipt } from './build.ts'
import { keepsReserve, maxNativeCost, maxTokenCost, missingAccountFunds, nativeLaneFloor } from './fees.ts'
import { AaError, type Json, field, quantity, type JsonRpc } from './rpc.ts'
import { delegatorTypedData, nonceKey } from './userop.ts'

const key = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const PAYMASTER: Address = '0x777777777777AeC03fd955926DbF81597e66834C'
const USDC: Address = '0x534b2f3A21130d7a60830c2Df862319e593943A3'
const aa: AccountAbstraction = {
  entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  paymaster: PAYMASTER,
  paymasterKind: 'pimlico-erc20',
  gasToken: USDC,
  standingApproval: 1_000_000n,
  maxCostPerOp: 100_000n,
  maxNativeCostPerOp: 4n * 10n ** 18n,
  nativeReserve: 10n * 10n ** 18n,
}
const word = (n: bigint) => encodeAbiParameters([{ type: 'uint256' }], [n])
const WORK_TARGET: Address = '0x00000000000000000000000000000000000000bb'
const WORK_DATA: Hex = '0x1234'
const work = { to: WORK_TARGET, value: 0n, data: WORK_DATA }

/** A node, bundler and paymaster that answer like Pimlico on Monad; `log` records every call in order. */
function services(
  over: {
    sequence?: bigint
    allowance?: bigint
    quotedPaymaster?: Address
    rate?: bigint
    /** Extra fields every paymaster answer carries (a stub's limits, a sponsor's own gas). */
    answer?: Record<string, string>
    /** The sender's MON balance and its EntryPoint deposit (wei), for a MON-paid operation. */
    balance?: bigint
    deposit?: bigint
  } = {},
) {
  const log: string[] = []
  const node: JsonRpc = async (method, params) => {
    log.push(`node:${method}`)
    if (method === 'eth_getBalance') return toHex(over.balance ?? 0n)
    if (JSON.stringify(params[0]).includes('0x35567e1a')) return word(over.sequence ?? 0n) // getNonce
    if (JSON.stringify(params[0]).includes('0x70a08231')) return word(over.deposit ?? 0n) // EntryPoint balanceOf
    return word(over.allowance ?? 0n) // allowance
  }
  const bundler: JsonRpc = async (method) => {
    log.push(`bundler:${method}`)
    if (method === 'pimlico_getUserOperationGasPrice')
      return { fast: { maxFeePerGas: toHex(130n * 10n ** 9n), maxPriorityFeePerGas: toHex(2n * 10n ** 9n) } }
    if (method === 'eth_estimateUserOperationGas')
      return {
        callGasLimit: '0x30d40',
        verificationGasLimit: '0xf000',
        preVerificationGas: '0x19000',
        paymasterVerificationGasLimit: '0xb000',
        paymasterPostOpGasLimit: '0xa000',
      }
    throw new Error(`unexpected ${method}`)
  }
  const paymaster: JsonRpc = async (method, params) => {
    log.push(`paymaster:${method}`)
    if (method === 'pimlico_getTokenQuotes')
      return {
        quotes: [
          {
            paymaster: over.quotedPaymaster ?? PAYMASTER,
            exchangeRate: toHex(over.rate ?? 27_888n),
            postOpGas: '0x907e',
          },
        ],
      }
    const context = params[3] ?? null
    return {
      paymaster: PAYMASTER,
      paymasterData: method === 'pm_getPaymasterData' ? '0xfeed' : '0x00',
      context,
      ...over.answer,
    }
  }
  return { node, bundler, paymaster, log }
}

/**
 * The fake estimate's pre-verification gas (0x19000) priced for the limits sent: the call's 10% headroom raises them
 * over the measured ones (Monad bills limits), then the 10% margin.
 */
const MEASURED_LIMITS = 0xf000n + 0x30d40n + 0xb000n + 0xa000n
const sentPvg = (named: bigint) => (((0x19000n * named + MEASURED_LIMITS - 1n) / MEASURED_LIMITS) * 110n + 99n) / 100n
const PADDED_PVG = sentPvg(0xf000n + (0x30d40n * 11n) / 10n + 0xb000n + 0xa000n)

/** Services whose final paymaster answer carries these limits on top of the stub's. */
function raised(limits: Record<string, string>) {
  const s = services()
  const paymaster = s.paymaster
  s.paymaster = async (method, params) => {
    const answer = await paymaster(method, params)
    return method === 'pm_getPaymasterData' ? { ...Object(answer), ...limits } : answer
  }
  return s
}

const build = (s: ReturnType<typeof services>, extra: Partial<Parameters<typeof buildUserOp>[0]> = {}) =>
  buildUserOp({
    aa,
    chainId: 10143,
    ...s,
    sender: key.address,
    calls: () => [work],
    nonceKey: nonceKey('op-1'),
    ...extra,
  })

describe('building a user operation', () => {
  it('quotes, prices, estimates, bounds and fetches the paymaster data, in that order, on the operation lane', async () => {
    const s = services()
    const built = await build(s)
    expect(s.log).toEqual([
      'node:eth_call',
      'paymaster:pimlico_getTokenQuotes',
      'node:eth_call',
      'bundler:pimlico_getUserOperationGasPrice',
      'paymaster:pm_getPaymasterStubData',
      'bundler:eth_estimateUserOperationGas',
      'paymaster:pm_getPaymasterData',
    ])
    expect(built.op.nonce >> 64n).toBe(nonceKey('op-1'))
    expect(built.op.paymasterData).toBe('0xfeed')
    // The estimate's placeholder must be a well-formed 65-byte ECDSA signature: OpenZeppelin reverts on any other length.
    expect(size(built.op.signature)).toBe(65)
    expect(built.op.callGasLimit).toBe((0x30d40n * 11n) / 10n)
    expect(built.op.preVerificationGas).toBe(PADDED_PVG)
    expect(built.maxCost > 0n && built.maxCost <= aa.maxCostPerOp).toBe(true)
  })

  it("keeps the call gas at the batch's floor when the estimate is below it", async () => {
    expect((await build(services(), { minCallGas: 300_000n })).op.callGasLimit).toBe(300_000n)
    expect((await build(services(), { minCallGas: 100_000n })).op.callGasLimit).toBe((0x30d40n * 11n) / 10n)
  })

  it("estimates our testnet paymaster's ops unpaid, then prices pre-verification gas for its limits", async () => {
    // Live on dev: estimating with it attached fails AA50, since the bundler's inflated simulation outgrows the charge.
    const s = services({
      answer: { paymasterVerificationGasLimit: toHex(100_000n), paymasterPostOpGasLimit: toHex(200_000n) },
    })
    const bundler = s.bundler
    let estimated: readonly Json[] = []
    s.bundler = async (method, params) => {
      if (method === 'eth_estimateUserOperationGas') estimated = params
      return bundler(method, params)
    }
    const built = await build(s, { aa: { ...aa, paymasterKind: 'sidequest-testnet' } })
    expect(field(estimated[0], 'paymaster')).toBeUndefined()
    expect(field(estimated[0], 'paymasterData')).toBeUndefined()
    expect(field(field(estimated[2], key.address), 'balance')).toBe(toHex(10n ** 24n))
    expect(built.op.paymasterVerificationGasLimit).toBe(100_000n)
    expect(built.op.paymasterPostOpGasLimit).toBe(200_000n)
    const measured = 0xf000n + 0x30d40n
    const paid = 0xf000n + (0x30d40n * 11n) / 10n + 300_000n
    const scaled = (0x19000n * paid + measured - 1n) / measured
    expect(built.op.preVerificationGas).toBe((scaled * 110n + 99n) / 100n)
  })

  it('prices pre-verification gas for the batch floor, against the limits the bundler measured', async () => {
    // Live on dev, 13 Oct: a SIDE sale's floor (1.03M) far above its estimate was sent 573535 where 715771 was required.
    const s = services({
      answer: { paymasterVerificationGasLimit: toHex(100_000n), paymasterPostOpGasLimit: toHex(200_000n) },
    })
    const built = await build(s, { aa: { ...aa, paymasterKind: 'sidequest-testnet' }, minCallGas: 1_030_000n })
    expect(built.op.callGasLimit).toBe(1_030_000n)
    const measured = 0xf000n + 0x30d40n
    const scaled = (0x19000n * (0xf000n + 1_030_000n + 300_000n) + measured - 1n) / measured
    expect(built.op.preVerificationGas).toBe((scaled * 110n + 99n) / 100n)
  })

  it("estimates a Pimlico paymaster's ops with it attached", async () => {
    const s = services()
    const bundler = s.bundler
    let estimated: readonly Json[] = []
    s.bundler = async (method, params) => {
      if (method === 'eth_estimateUserOperationGas') estimated = params
      return bundler(method, params)
    }
    await build(s)
    expect(field(estimated[0], 'paymaster')).toBe(PAYMASTER)
    expect(estimated).toHaveLength(2)
  })

  it('appends the standing approval only while the paymaster allowance is short', async () => {
    const short = decodeExecuteCalldata((await build(services({ allowance: 99_999n }))).op.callData)!
    expect(short).toHaveLength(2)
    expect(decodeFunctionData({ abi: erc20Abi, data: short[1]!.data }).args).toEqual([PAYMASTER, aa.standingApproval])
    const covered = decodeExecuteCalldata((await build(services({ allowance: 100_000n }))).op.callData)!
    expect(covered).toHaveLength(1)
  })

  it('gives a call builder the ceiling, then the bound, so a gas pull takes just enough', async () => {
    const seen: bigint[] = []
    const built = await build(services(), { calls: (maxCost) => (seen.push(maxCost), [work]) })
    expect(seen).toEqual([aa.maxCostPerOp, built.maxCost])
  })

  it('includes the charged pre-verification margin in paymaster data, the cost bound and the ceiling', async () => {
    const s = services()
    const paymaster = s.paymaster
    let finalGas = 0n
    s.paymaster = async (method, params) => {
      if (method === 'pm_getPaymasterData') finalGas = quantity(field(params[0], 'preVerificationGas'), 'gas')
      return paymaster(method, params)
    }
    const built = await build(s)
    const quote = { paymaster: PAYMASTER, exchangeRate: 27_888n, postOpGas: 0x907en }
    expect(finalGas).toBe(PADDED_PVG)
    expect(built.maxCost).toBe(maxTokenCost(built.op, quote))
    const beforeMargin = maxTokenCost({ ...built.op, preVerificationGas: 0x19000n }, quote)
    expect(built.maxCost).toBeGreaterThan(beforeMargin)
    const capped = services()
    await expect(build(capped, { aa: { ...aa, maxCostPerOp: beforeMargin } })).rejects.toMatchObject({
      code: 'ceiling',
    })
    expect(capped.log).not.toContain('paymaster:pm_getPaymasterData')
  })

  it('prices pre-verification gas for a call-gas floor on the paid and the sponsored path', async () => {
    // Live on dev, 13 Oct: a sponsored faucet claim's floor (400k) above its estimate (227k) was sent 276351 where
    // 292982 was required; the paid path (Pimlico's USDC paymaster on 143) has the same shape.
    const named = 0xf000n + 1_030_000n + 0xb000n + 0xa000n
    const paid = await build(services(), { minCallGas: 1_030_000n })
    expect(paid.op.preVerificationGas).toBe(sentPvg(named))
    const s = services()
    const paymaster = s.paymaster
    let signed = 0n
    s.paymaster = async (method, params) => {
      if (method === 'pm_getPaymasterData') signed = quantity(field(params[0], 'preVerificationGas'), 'gas')
      return paymaster(method, params)
    }
    await build(s, { sponsor: 'faucet', minCallGas: 1_030_000n })
    expect(signed).toBe(sentPvg(named))
  })

  it("refuses final paymaster limits that would cost more than the bound, and keeps the bound when they don't", async () => {
    // Pre-launch review (13 Oct): the cost was bounded before the final answer's limits were merged.
    await expect(build(raised({ paymasterPostOpGasLimit: toHex(900_000n) }))).rejects.toMatchObject({
      code: 'mismatch',
    })
    const same = await build(raised({ paymasterVerificationGasLimit: '0xb000', paymasterPostOpGasLimit: '0xa000' }))
    const quote = { paymaster: PAYMASTER, exchangeRate: 27_888n, postOpGas: 0x907en }
    expect(same.maxCost).toBe(maxTokenCost(same.op, quote))
  })

  it("asks a sponsor to sign the padded pre-verification gas, then keeps the sponsor's own value", async () => {
    // Live on dev (12 Oct): the bare estimate came up 38 gas short at send, because the real signature has fewer zero
    // bytes than the placeholder. Pimlico keeps a higher value it is given and signs over it.
    const s = services()
    const paymaster = s.paymaster
    let finalGas = 0n
    s.paymaster = async (method, params) => {
      if (method === 'pm_getPaymasterData') finalGas = quantity(field(params[0], 'preVerificationGas'), 'gas')
      return paymaster(method, params)
    }
    const built = await build(s, { sponsor: 'faucet' })
    expect(finalGas).toBe(PADDED_PVG)
    expect(built.op.preVerificationGas).toBe(finalGas)
    expect(built.maxCost).toBe(0n)
  })

  it('refuses a landed lane, another paymaster and a cost above the ceiling', async () => {
    await expect(build(services({ sequence: 1n }))).rejects.toMatchObject({ code: 'landed' })
    await expect(build(services({ quotedPaymaster: work.to }))).rejects.toMatchObject({ code: 'mismatch' })
    await expect(build(services({ rate: 10n ** 12n }))).rejects.toMatchObject({ code: 'ceiling' })
    await expect(build(services(), { aa: { ...aa, paymaster: null } })).rejects.toMatchObject({ code: 'no-paymaster' })
  })

  it("never lowers the paymaster's own limits below its stub's, whatever the bundler measured", async () => {
    const stub = { paymasterVerificationGasLimit: '0x186a0', paymasterPostOpGasLimit: '0x30d40' }
    const built = await build(services({ answer: stub }))
    expect(built.op.paymasterVerificationGasLimit).toBe(100_000n)
    expect(built.op.paymasterPostOpGasLimit).toBe(200_000n)
  })

  it("takes a sponsor's own gas limits from its final answer, since its signature covers them", async () => {
    const sponsorGas = { callGasLimit: '0x11170', verificationGasLimit: '0x22270', preVerificationGas: '0x33370' }
    const built = await build(services({ answer: sponsorGas }), { sponsor: 'faucet' })
    expect([built.op.callGasLimit, built.op.verificationGasLimit, built.op.preVerificationGas]).toEqual([
      0x11170n,
      0x22270n,
      0x33370n,
    ])
    const charged = await build(services({ answer: sponsorGas }))
    expect(charged.op.callGasLimit).toBe((0x30d40n * 11n) / 10n)
  })

  it('sponsors a faucet claim through a different verifying paymaster, even before our paymaster is deployed', async () => {
    const s = services()
    const built = await build(s, { sponsor: 'faucet', aa: { ...aa, paymaster: null } })
    expect(s.log).not.toContain('paymaster:pimlico_getTokenQuotes')
    expect(decodeExecuteCalldata(built.op.callData)).toHaveLength(1)
    expect(built.maxCost).toBe(0n)
    expect(built.op.paymaster).toBe(PAYMASTER)
    const other = await build(services(), { sponsor: 'faucet', aa: { ...aa, paymaster: WORK_TARGET } })
    expect(other.op.paymaster).toBe(PAYMASTER)
    await expect(build(services(), { sponsor: 'faucet', chainId: 143 })).rejects.toMatchObject({ code: 'refused' })
  })
})

/** The fake estimate priced for a MON-paid operation: measured unpaid, so only verification and call gas count. */
const NATIVE_MEASURED = 0xf000n + 0x30d40n
const nativePvg = (call: bigint) =>
  (((0x19000n * (0xf000n + call) + NATIVE_MEASURED - 1n) / NATIVE_MEASURED) * 110n + 99n) / 100n
const FAST_FEE = 130n * 10n ** 9n
const MON = 10n ** 18n
const native = (s: ReturnType<typeof services>, extra: Partial<Parameters<typeof buildUserOp>[0]> = {}) =>
  build(s, { payment: 'native', ...extra })

describe('building a MON-paid user operation', () => {
  it('estimates it unpaid, bounds it in wei and asks no paymaster anything', async () => {
    const s = services({ balance: 20n * MON })
    const bundler = s.bundler
    let estimated: readonly Json[] = []
    s.bundler = async (method, params) => {
      if (method === 'eth_estimateUserOperationGas') estimated = params
      return bundler(method, params)
    }
    const seen: bigint[] = []
    const built = await native(s, {
      aa: { ...aa, paymaster: null },
      calls: (maxCost) => (seen.push(maxCost), [work]),
    })
    expect(s.log).toEqual([
      'node:eth_call',
      'bundler:pimlico_getUserOperationGasPrice',
      'bundler:eth_estimateUserOperationGas',
      'node:eth_getBalance',
      'node:eth_call',
    ])
    expect(field(estimated[0], 'paymaster')).toBeUndefined()
    expect(field(field(estimated[2], key.address), 'balance')).toBe(toHex(10n ** 24n))
    expect(built.op.paymaster).toBeUndefined()
    expect(built.op.paymasterVerificationGasLimit).toBeUndefined()
    expect(built.op.paymasterPostOpGasLimit).toBeUndefined()
    const call = (0x30d40n * 11n) / 10n
    expect(built.op.callGasLimit).toBe(call)
    expect(built.op.preVerificationGas).toBe(nativePvg(call))
    // Monad bills the limit: the bound is the EntryPoint's whole prefund, every limit at the max fee.
    expect(built.maxCost).toBe((0xf000n + call + nativePvg(call)) * FAST_FEE)
    expect(built.maxCost).toBe(maxNativeCost(built.op))
    expect(seen).toEqual([aa.maxNativeCostPerOp, built.maxCost])
    expect(decodeExecuteCalldata(built.op.callData)!.map((c) => c.to)).toEqual([WORK_TARGET])
  })

  it('prices pre-verification gas for a call-gas floor, as the token path does', async () => {
    const built = await native(services({ balance: 20n * MON }), { minCallGas: 1_030_000n })
    expect(built.op.callGasLimit).toBe(1_030_000n)
    expect(built.op.preVerificationGas).toBe(nativePvg(1_030_000n))
  })

  it("refuses above the wei ceiling and wherever paying would break Monad's reserve rule", async () => {
    const cost = (await native(services({ balance: 20n * MON }))).maxCost
    const reserve = aa.nativeReserve
    const capped = services({ balance: 20n * MON })
    await expect(native(capped, { aa: { ...aa, maxNativeCostPerOp: cost - 1n } })).rejects.toMatchObject({
      code: 'ceiling',
    })
    expect(capped.log).not.toContain('node:eth_getBalance')
    expect((await native(services({ balance: reserve + cost }))).maxCost).toBe(cost)
    await expect(native(services({ balance: reserve + cost - 1n }))).rejects.toMatchObject({ code: 'ceiling' })
    // An earlier operation's leftover deposit pays first: the account sends only the rest.
    expect((await native(services({ balance: reserve + 1n, deposit: cost - 1n }))).maxCost).toBe(cost)
    // Below the reserve the account may send nothing at all; only a covering deposit lets it go.
    await expect(native(services({ balance: MON }))).rejects.toMatchObject({ code: 'ceiling' })
    expect((await native(services({ balance: MON, deposit: cost }))).maxCost).toBe(cost)
    // Without a reserve the balance must still cover the prefund.
    const free = { ...aa, nativeReserve: 0n }
    await expect(native(services({ balance: cost - 1n }), { aa: free })).rejects.toMatchObject({ code: 'ceiling' })
    expect((await native(services({ balance: cost }), { aa: free })).maxCost).toBe(cost)
  })

  it('refuses where it is not configured, for a sponsored claim and on a landed lane', async () => {
    const rich = { balance: 20n * MON }
    await expect(native(services(rich), { aa: { ...aa, maxNativeCostPerOp: null } })).rejects.toMatchObject({
      code: 'unavailable',
    })
    await expect(native(services(rich), { sponsor: 'faucet' })).rejects.toMatchObject({ code: 'refused' })
    await expect(native(services({ ...rich, sequence: 1n }))).rejects.toMatchObject({ code: 'landed' })
  })

  it('reads the reserve rule and the lane floor the way Monad applies them', () => {
    expect(missingAccountFunds(10n, 3n)).toBe(7n)
    expect(missingAccountFunds(10n, 30n)).toBe(0n)
    expect(keepsReserve(5n, 0n, 10n)).toBe(true)
    expect(keepsReserve(15n, 5n, 10n)).toBe(true)
    expect(keepsReserve(15n, 6n, 10n)).toBe(false)
    expect(nativeLaneFloor(aa)).toBe(14n * MON)
    expect(nativeLaneFloor({ ...aa, maxNativeCostPerOp: null })).toBeNull()
  })
})

const silent: JsonRpc = async () => {
  throw new AaError('unavailable', 'no answer')
}
const refused: JsonRpc = async () => {
  throw new AaError('refused', "AA21 didn't pay prefund")
}

describe('sending a user operation', () => {
  it('sends only a signature from the sender, and reads an unanswered send as uncertain', async () => {
    const built = await build(services())
    const signature = await key.signTypedData(delegatorTypedData(built.op, 10143, aa.entryPoint))
    const ok: JsonRpc = async () => built.userOpHash
    expect(await sendUserOp(ok, built, signature)).toBe(built.userOpHash)
    const stranger = await privateKeyToAccount(`0x${'33'.repeat(32)}`).signTypedData(
      delegatorTypedData(built.op, 10143, aa.entryPoint),
    )
    await expect(sendUserOp(ok, built, stranger)).rejects.toMatchObject({ code: 'bad-signature' })
    await expect(sendUserOp(silent, built, signature)).rejects.toMatchObject({ code: 'uncertain' })
    await expect(sendUserOp(refused, built, signature)).rejects.toMatchObject({ code: 'refused' })
  })

  it('sends a MON-paid first operation with its 7702 authorization and no paymaster fields', async () => {
    const signed = await key.signAuthorization({ chainId: 10143, contractAddress: WORK_TARGET, nonce: 0 })
    const authorization = { ...signed, yParity: signed.yParity ?? 0 }
    const built = await build(services({ balance: 20n * 10n ** 18n }), { payment: 'native', authorization })
    const signature = await key.signTypedData(delegatorTypedData(built.op, 10143, aa.entryPoint))
    let sent: readonly Json[] = []
    const bundler: JsonRpc = async (_method, params) => {
      sent = params
      return built.userOpHash
    }
    expect(await sendUserOp(bundler, built, signature)).toBe(built.userOpHash)
    expect(field(sent[0], 'paymaster')).toBeUndefined()
    expect(field(sent[0], 'paymasterData')).toBeUndefined()
    expect(field(field(sent[0], 'eip7702Auth'), 'address')).toBe(WORK_TARGET)
  })

  it('reads a receipt, or null while the operation is not mined', async () => {
    const tx: Hex = `0x${'ab'.repeat(32)}`
    const mined: JsonRpc = async () => ({ success: true, actualGasCost: '0x10', receipt: { transactionHash: tx } })
    expect(await userOpReceipt(mined, tx)).toEqual({ status: 'success', txHash: tx, actualGasCost: 16n })
    expect(await userOpReceipt(async () => null, tx)).toBeNull()
  })
})
