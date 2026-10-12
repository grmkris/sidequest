/**
 * ERC-4337 v0.7 user operations for MetaMask's EIP7702StatelessDeleGator (ADR-0023): an account whose EIP-7702 code
 * points at the DeleGator sends every action as one batched user operation, and an ERC-20 paymaster takes the gas in
 * USDC. Pure encoders, safe in the browser and the Worker:
 * - the call data is the DeleGator's own `execute` batch (`executeCalldata`);
 * - the account signs the DeleGator's own EIP-712 digest over the packed operation, not the EntryPoint's userOpHash;
 * - each operation gets its own 2D nonce lane (`nonceKey`), so a retry of one operation reuses its nonce and at most one
 *   attempt can ever land, while different operations go out in parallel.
 */
import {
  type Address,
  type Hex,
  concat,
  encodeFunctionData,
  erc20Abi,
  hashTypedData,
  keccak256,
  pad,
  toHex,
} from 'viem'
import { getUserOperationHash } from 'viem/account-abstraction'
import type { Call, SignedAuthorization } from '../batch.ts'

/** An unpacked v0.7 user operation; the account is the EOA itself, so it never has a factory. */
export interface UserOperation {
  readonly sender: Address
  readonly nonce: bigint
  readonly callData: Hex
  readonly callGasLimit: bigint
  readonly verificationGasLimit: bigint
  readonly preVerificationGas: bigint
  readonly maxFeePerGas: bigint
  readonly maxPriorityFeePerGas: bigint
  readonly paymaster?: Address
  readonly paymasterVerificationGasLimit?: bigint
  readonly paymasterPostOpGasLimit?: bigint
  readonly paymasterData?: Hex
  readonly signature: Hex
}

/**
 * The nonce lane of one operation: the top 192 bits of its id's hash. The EntryPoint keeps a sequence per (sender,
 * lane), so an operation's first and only nonce is `lane << 64`.
 */
export function nonceKey(operationId: string): bigint {
  return BigInt(keccak256(toHex(operationId))) >> 64n
}

/** The nonce an operation's attempts all share: sequence 0 of its lane. */
export const laneNonce = (key: bigint): bigint => key << 64n

const u128 = (value: bigint) => pad(toHex(value), { size: 16 })
const EMPTY: Hex = '0x'

/** v0.7 packing: verification gas limit, then call gas limit. */
export const accountGasLimits = (op: UserOperation): Hex =>
  concat([u128(op.verificationGasLimit), u128(op.callGasLimit)])

/** v0.7 packing: max priority fee, then max fee. */
export const gasFees = (op: UserOperation): Hex => concat([u128(op.maxPriorityFeePerGas), u128(op.maxFeePerGas)])

/** v0.7 packing: the paymaster, its verification and post-op gas limits, then its data; `0x` without one. */
export const paymasterAndData = (op: UserOperation): Hex =>
  op.paymaster === undefined
    ? '0x'
    : concat([
        op.paymaster,
        u128(op.paymasterVerificationGasLimit ?? 0n),
        u128(op.paymasterPostOpGasLimit ?? 0n),
        op.paymasterData ?? '0x',
      ])

const PACKED = [
  { name: 'sender', type: 'address' },
  { name: 'nonce', type: 'uint256' },
  { name: 'initCode', type: 'bytes' },
  { name: 'callData', type: 'bytes' },
  { name: 'accountGasLimits', type: 'bytes32' },
  { name: 'preVerificationGas', type: 'uint256' },
  { name: 'gasFees', type: 'bytes32' },
  { name: 'paymasterAndData', type: 'bytes' },
  { name: 'entryPoint', type: 'address' },
] as const

/**
 * What the DeleGator checks in `validateUserOp`: its own domain (name, version 1, the chain, the account itself as
 * verifying contract) over the packed operation and the EntryPoint. The account signs exactly this typed data.
 */
export function delegatorTypedData(op: UserOperation, chainId: number, entryPoint: Address) {
  return {
    domain: { name: 'EIP7702StatelessDeleGator', version: '1', chainId, verifyingContract: op.sender },
    types: { PackedUserOperation: PACKED },
    primaryType: 'PackedUserOperation' as const,
    message: {
      sender: op.sender,
      nonce: op.nonce,
      initCode: EMPTY,
      callData: op.callData,
      accountGasLimits: accountGasLimits(op),
      preVerificationGas: op.preVerificationGas,
      gasFees: gasFees(op),
      paymasterAndData: paymasterAndData(op),
      entryPoint,
    },
  }
}

/** The digest an operation's signature must recover over to its sender. */
export const delegatorDigest = (op: UserOperation, chainId: number, entryPoint: Address): Hex =>
  hashTypedData(delegatorTypedData(op, chainId, entryPoint))

/** The EntryPoint's id of the operation (v0.7): what the bundler and the receipt name it by. */
export function userOpHash(op: UserOperation, chainId: number, entryPoint: Address): Hex {
  return getUserOperationHash({
    chainId,
    entryPointAddress: entryPoint,
    entryPointVersion: '0.7',
    userOperation: {
      sender: op.sender,
      nonce: op.nonce,
      callData: op.callData,
      callGasLimit: op.callGasLimit,
      verificationGasLimit: op.verificationGasLimit,
      preVerificationGas: op.preVerificationGas,
      maxFeePerGas: op.maxFeePerGas,
      maxPriorityFeePerGas: op.maxPriorityFeePerGas,
      signature: op.signature,
      ...(op.paymaster === undefined
        ? {}
        : {
            paymaster: op.paymaster,
            paymasterVerificationGasLimit: op.paymasterVerificationGasLimit ?? 0n,
            paymasterPostOpGasLimit: op.paymasterPostOpGasLimit ?? 0n,
            paymasterData: op.paymasterData ?? '0x',
          }),
    },
  })
}

/** A 7702 authorization in the bundler's `eip7702Auth` form (hex quantities). */
export const bundlerAuthorization = (auth: SignedAuthorization) => ({
  address: auth.address,
  chainId: toHex(auth.chainId),
  nonce: toHex(auth.nonce),
  r: auth.r,
  s: auth.s,
  yParity: toHex(auth.yParity),
})

/** The bundler's JSON form: v0.7 unpacked, hex quantities, the 7702 authorization when the op carries one. */
export function toBundlerJson(op: UserOperation, authorization?: SignedAuthorization) {
  return {
    sender: op.sender,
    nonce: toHex(op.nonce),
    callData: op.callData,
    callGasLimit: toHex(op.callGasLimit),
    verificationGasLimit: toHex(op.verificationGasLimit),
    preVerificationGas: toHex(op.preVerificationGas),
    maxFeePerGas: toHex(op.maxFeePerGas),
    maxPriorityFeePerGas: toHex(op.maxPriorityFeePerGas),
    ...(op.paymaster === undefined
      ? {}
      : {
          paymaster: op.paymaster,
          paymasterVerificationGasLimit: toHex(op.paymasterVerificationGasLimit ?? 0n),
          paymasterPostOpGasLimit: toHex(op.paymasterPostOpGasLimit ?? 0n),
          paymasterData: op.paymasterData ?? '0x',
        }),
    signature: op.signature,
    ...(authorization === undefined ? {} : { eip7702Auth: bundlerAuthorization(authorization) }),
  }
}

/**
 * Privy's `eth_signUserOperation` form: snake case and hex quantities. The paymaster fields are left out when there is
 * no paymaster: Privy hashes zeroed fields as 52 zero bytes, which is not the empty `paymasterAndData`.
 */
export function toPrivyJson(op: UserOperation) {
  return {
    sender: op.sender,
    nonce: toHex(op.nonce),
    call_data: op.callData,
    call_gas_limit: toHex(op.callGasLimit),
    verification_gas_limit: toHex(op.verificationGasLimit),
    pre_verification_gas: toHex(op.preVerificationGas),
    max_fee_per_gas: toHex(op.maxFeePerGas),
    max_priority_fee_per_gas: toHex(op.maxPriorityFeePerGas),
    ...(op.paymaster === undefined
      ? {}
      : {
          paymaster: op.paymaster,
          paymaster_data: op.paymasterData ?? '0x',
          paymaster_verification_gas_limit: toHex(op.paymasterVerificationGasLimit ?? 0n),
          paymaster_post_op_gas_limit: toHex(op.paymasterPostOpGasLimit ?? 0n),
        }),
  }
}

/** `token.approve(spender, amount)` as a batch call. */
export const approveCall = (token: Address, spender: Address, amount: bigint): Call => ({
  to: token,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
})
