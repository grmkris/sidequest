import { type UserOperation, paymasterAndData } from './userop.ts'
import { paymasterData, testnetPaymasterHash } from './testnet-paymaster.ts'
import { size } from 'viem'
import { describe, expect, it } from 'vitest'

const paymaster = '0x00000000000000000000000000000000000000bb'
const op: UserOperation = {
  sender: '0x00000000000000000000000000000000000000aa',
  nonce: 7n,
  callData: '0xdeadbeef',
  verificationGasLimit: 200_000n,
  callGasLimit: 300_000n,
  preVerificationGas: 50_000n,
  maxPriorityFeePerGas: 2_000_000_000n,
  maxFeePerGas: 100_000_000_000n,
  paymaster,
  paymasterVerificationGasLimit: 100_000n,
  paymasterPostOpGasLimit: 200_000n,
  signature: '0x',
}
const window = { validUntil: 1_790_000_600n, validAfter: 1_789_999_940n }

describe('SidequestTestnetPaymaster encoding', () => {
  it('matches the contract abi.encode vector, independently generated with cast abi-encode and cast keccak', () => {
    // getHash's 13 static words, including keccak256(empty initCode), packed gas words and two uint128 PM limits.
    const hash = testnetPaymasterHash(op, 10143, paymaster, window.validUntil, window.validAfter)
    expect(hash).toBe('0xd8c55003cbdbea9a162fd58dbbbb761be8344e8e047ff828433e4ca4c13cac67')
    expect(
      testnetPaymasterHash(
        { ...op, signature: '0x1234', paymasterData: '0xab' },
        10143,
        paymaster,
        window.validUntil,
        window.validAfter,
      ),
    ).toBe(hash)
    for (const changed of [
      { ...op, nonce: 8n },
      { ...op, callData: '0xab' as const },
      { ...op, paymasterPostOpGasLimit: 200_001n },
    ])
      expect(testnetPaymasterHash(changed, 10143, paymaster, window.validUntil, window.validAfter)).not.toBe(hash)
  })

  it('encodes 129 bytes in contract order and refuses malformed signatures and uint48 windows', () => {
    const signature = `0x${'ab'.repeat(65)}` as const
    const data = paymasterData(window, signature)
    expect(size(data)).toBe(77)
    expect(data).toBe(`0x00006ab13dd800006ab13b44${signature.slice(2)}`)
    expect(size(paymasterAndData({ ...op, paymasterData: data }))).toBe(129)
    expect(() => paymasterData(window, '0x')).toThrow('65 bytes')
    expect(() => paymasterData({ ...window, validUntil: 1n << 48n }, signature)).toThrow()
  })
})
