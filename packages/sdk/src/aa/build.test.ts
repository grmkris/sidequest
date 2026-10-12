import { type Address, type Hex, decodeFunctionData, encodeAbiParameters, erc20Abi, size, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { decodeExecuteCalldata } from '../batch.ts'
import type { AccountAbstraction } from '../deployment.ts'
import { buildUserOp, sendUserOp, userOpReceipt } from './build.ts'
import { maxTokenCost } from './fees.ts'
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
  } = {},
) {
  const log: string[] = []
  const node: JsonRpc = async (method, params) => {
    log.push(`node:${method}`)
    if (JSON.stringify(params[0]).includes('0x35567e1a')) return word(over.sequence ?? 0n) // getNonce
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
    expect(built.op.preVerificationGas).toBe((0x19000n * 110n + 99n) / 100n)
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
    const unpaid = 0xf000n + (0x30d40n * 11n) / 10n
    const scaled = (0x19000n * (unpaid + 300_000n) + unpaid - 1n) / unpaid
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
    expect(finalGas).toBe((0x19000n * 11n + 9n) / 10n)
    expect(built.maxCost).toBe(maxTokenCost(built.op, quote))
    const beforeMargin = maxTokenCost({ ...built.op, preVerificationGas: 0x19000n }, quote)
    expect(built.maxCost).toBeGreaterThan(beforeMargin)
    const capped = services()
    await expect(build(capped, { aa: { ...aa, maxCostPerOp: beforeMargin } })).rejects.toMatchObject({
      code: 'ceiling',
    })
    expect(capped.log).not.toContain('paymaster:pm_getPaymasterData')
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
    expect(finalGas).toBe((0x19000n * 110n + 99n) / 100n)
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

  it('reads a receipt, or null while the operation is not mined', async () => {
    const tx: Hex = `0x${'ab'.repeat(32)}`
    const mined: JsonRpc = async () => ({ success: true, actualGasCost: '0x10', receipt: { transactionHash: tx } })
    expect(await userOpReceipt(mined, tx)).toEqual({ status: 'success', txHash: tx, actualGasCost: 16n })
    expect(await userOpReceipt(async () => null, tx)).toBeNull()
  })
})
