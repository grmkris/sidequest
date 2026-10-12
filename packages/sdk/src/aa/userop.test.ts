import { type Address, type Hex, encodeFunctionData, erc20Abi, getAddress, isHex, recoverAddress, slice } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { decodeExecuteCalldata, executeCalldata } from '../batch.ts'
import vector from './fixtures/base-userop.json' with { type: 'json' }
import {
  type UserOperation,
  approveCall,
  delegatorDigest,
  delegatorTypedData,
  laneNonce,
  nonceKey,
  toBundlerJson,
  toPrivyJson,
  userOpHash,
} from './userop.ts'

/** A fixture field as hex, refused when it is not. */
const hex = (value: string): Hex => {
  if (!isHex(value)) throw new Error('fixture field is not hex')
  return value
}
const ENTRY_POINT = getAddress(vector.entryPoint)

/** The fixture's packed v0.7 operation, unpacked into our shape. */
function unpacked(): UserOperation {
  const p = vector.packed
  const limits = hex(p.accountGasLimits)
  const fees = hex(p.gasFees)
  const pm = hex(p.paymasterAndData)
  return {
    sender: getAddress(p.sender),
    nonce: BigInt(p.nonce),
    callData: hex(p.callData),
    verificationGasLimit: BigInt(slice(limits, 0, 16)),
    callGasLimit: BigInt(slice(limits, 16, 32)),
    preVerificationGas: BigInt(p.preVerificationGas),
    maxPriorityFeePerGas: BigInt(slice(fees, 0, 16)),
    maxFeePerGas: BigInt(slice(fees, 16, 32)),
    paymaster: slice(pm, 0, 20),
    paymasterVerificationGasLimit: BigInt(slice(pm, 20, 36)),
    paymasterPostOpGasLimit: BigInt(slice(pm, 36, 52)),
    paymasterData: slice(pm, 52),
    signature: hex(p.signature),
  }
}

describe('a DeleGator user operation that landed on Base mainnet', () => {
  it('hashes to the userOpHash the EntryPoint emitted', () => {
    expect(userOpHash(unpacked(), vector.chainId, ENTRY_POINT)).toBe(vector.userOpHash)
  })

  it("was signed over the DeleGator's own typed data, not the userOpHash", async () => {
    const op = unpacked()
    const signer = await recoverAddress({
      hash: delegatorDigest(op, vector.chainId, ENTRY_POINT),
      signature: op.signature,
    })
    expect(signer.toLowerCase()).toBe(op.sender.toLowerCase())
    expect(delegatorTypedData(op, vector.chainId, ENTRY_POINT).domain).toEqual({
      name: 'EIP7702StatelessDeleGator',
      version: '1',
      chainId: 8453,
      verifyingContract: op.sender,
    })
  })

  it('carries a DeleGator batch', () => {
    expect(decodeExecuteCalldata(unpacked().callData)?.length).toBeGreaterThan(0)
  })
})

describe('user operation encoding', () => {
  const key = privateKeyToAccount(`0x${'11'.repeat(32)}`)
  const token: Address = '0x00000000000000000000000000000000000000aa'
  const paymaster: Address = '0x777777777777AeC03fd955926DbF81597e66834C'
  const op: UserOperation = {
    sender: key.address,
    nonce: laneNonce(nonceKey('operation-1')),
    callData: executeCalldata([approveCall(token, paymaster, 1_000_000n)]),
    callGasLimit: 100_000n,
    verificationGasLimit: 60_000n,
    preVerificationGas: 50_000n,
    maxFeePerGas: 2n * 10n ** 11n,
    maxPriorityFeePerGas: 2n * 10n ** 9n,
    signature: '0x',
  }

  it('gives each operation its own nonce lane, sequence 0', () => {
    expect(nonceKey('operation-1')).toBe(nonceKey('operation-1'))
    expect(nonceKey('operation-1')).not.toBe(nonceKey('operation-2'))
    expect(nonceKey('operation-1') < 1n << 192n).toBe(true)
    expect(op.nonce & ((1n << 64n) - 1n)).toBe(0n)
    expect(op.nonce >> 64n).toBe(nonceKey('operation-1'))
  })

  it('round-trips a batch and refuses anything that is not one', () => {
    const call = approveCall(token, paymaster, 5n)
    expect(decodeExecuteCalldata(executeCalldata([call]))).toEqual([{ ...call, to: getAddress(call.to) }])
    expect(
      decodeExecuteCalldata(encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [token, 1n] })),
    ).toBeNull()
  })

  it('signs typed data that recovers to the sender, and the hash changes with the paymaster data', async () => {
    const signature = await key.signTypedData(delegatorTypedData(op, 10143, paymaster))
    const signer = await recoverAddress({ hash: delegatorDigest(op, 10143, paymaster), signature })
    expect(signer).toBe(key.address)
    const data: Hex = '0x01'
    const withPaymaster = { ...op, paymaster, paymasterData: data }
    expect(userOpHash(withPaymaster, 10143, paymaster)).not.toBe(userOpHash(op, 10143, paymaster))
  })

  it('leaves the paymaster out of the JSON forms when there is none, and carries the 7702 authorization', () => {
    const auth = { address: paymaster, chainId: 10143, nonce: 3, r: hex('0x01'), s: hex('0x02'), yParity: 1 }
    const bundler = toBundlerJson(op, auth)
    expect(bundler).not.toHaveProperty('paymaster')
    expect(bundler.eip7702Auth).toEqual({
      address: paymaster,
      chainId: '0x279f',
      nonce: '0x3',
      r: '0x01',
      s: '0x02',
      yParity: '0x1',
    })
    expect(toPrivyJson(op)).not.toHaveProperty('paymaster')
    expect(toPrivyJson({ ...op, paymaster, paymasterData: '0x01' })).toMatchObject({
      paymaster,
      paymaster_data: '0x01',
    })
  })
})
