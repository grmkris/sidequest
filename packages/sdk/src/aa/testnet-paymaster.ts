/** SidequestTestnetPaymaster's v0.7 wire format and getHash abi.encode layout. No keys belong in this module. */
import { type Address, type Hex, concat, encodeAbiParameters, keccak256, pad, size, toHex } from 'viem'
import { type UserOperation, accountGasLimits, gasFees } from './userop.ts'

export interface PaymasterWindow {
  readonly validUntil: bigint
  readonly validAfter: bigint
}

/** The 77-byte suffix after the paymaster and its two uint128 gas limits: uint48 window, then ECDSA signature. */
export function paymasterData(window: PaymasterWindow, signature: Hex): Hex {
  if (size(signature) !== 65) throw new Error('paymaster signature must be 65 bytes')
  return concat([pad(toHex(window.validUntil), { size: 6 }), pad(toHex(window.validAfter), { size: 6 }), signature])
}

/** Exactly the contract's getHash, before the signer adds the EIP-191 personal-message prefix. initCode is empty. */
export function testnetPaymasterHash(
  op: UserOperation,
  chainId: number,
  paymaster: Address,
  validUntil: bigint,
  validAfter: bigint,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint128' },
        { type: 'uint128' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint48' },
        { type: 'uint48' },
      ],
      [
        op.sender,
        op.nonce,
        keccak256('0x'),
        keccak256(op.callData),
        accountGasLimits(op),
        op.paymasterVerificationGasLimit ?? 0n,
        op.paymasterPostOpGasLimit ?? 0n,
        op.preVerificationGas,
        gasFees(op),
        BigInt(chainId),
        paymaster,
        Number(validUntil),
        Number(validAfter),
      ],
    ),
  )
}
