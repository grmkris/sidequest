/**
 * Acting as the Safe that owns Sidequest v1 (threshold 1): an owner calls `execTransaction` itself with a pre-validated
 * signature (`r` = the owner, `s` = 0, `v` = 1), which the Safe accepts because the caller is that owner. No Safe
 * transaction service. Every call is decoded back from the exact calldata before it is signed (`describe`), so what
 * the page shows is what goes out. Pure, so it is unit-tested (safe.test.ts).
 */
import {
  type Abi,
  type Address,
  type Hex,
  concat,
  decodeFunctionData,
  encodeFunctionData,
  encodePacked,
  getAddress,
  hexToBigInt,
  hexToNumber,
  pad,
  size,
  slice,
  zeroAddress,
} from 'viem'

/** The Safe functions this page uses (Safe v1.3/v1.4 share them). */
export const safeAbi = [
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'execTransaction',
    stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'signatures', type: 'bytes' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
] as const

/**
 * Safe's canonical MultiSendCallOnly v1.4.1, at this address on every chain (D13; it has code on Monad testnet and
 * mainnet). The Safe DELEGATECALLs it to make several plain calls in one transaction: all of them happen, or none. It
 * refuses a nested DELEGATECALL, so the calls inside stay plain calls.
 */
export const MULTI_SEND_CALL_ONLY: Address = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2'

const multiSendAbi = [
  {
    type: 'function',
    name: 'multiSend',
    stateMutability: 'payable',
    inputs: [{ name: 'transactions', type: 'bytes' }],
    outputs: [],
  },
] as const

/** `multiSend` calldata for plain calls made in order: each packed as operation 0, to, value 0, length, data. */
export function multiSend(calls: ReadonlyArray<{ to: Address; data: Hex }>): Hex {
  const packed = concat(
    calls.map((c) =>
      encodePacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [0, c.to, 0n, BigInt(size(c.data)), c.data]),
    ),
  )
  return encodeFunctionData({ abi: multiSendAbi, functionName: 'multiSend', args: [packed] })
}

/** The calls packed in `multiSend` calldata, or null when it is not well-formed. */
export function unpackMultiSend(data: Hex): Array<{ operation: number; to: Address; value: bigint; data: Hex }> | null {
  let packed: Hex
  try {
    const decoded = decodeFunctionData({ abi: multiSendAbi, data })
    packed = decoded.args[0]
  } catch {
    return null
  }
  const calls: Array<{ operation: number; to: Address; value: bigint; data: Hex }> = []
  let at = 0
  const end = size(packed)
  while (at < end) {
    if (end - at < 85) return null
    const length = Number(hexToBigInt(slice(packed, at + 53, at + 85)))
    if (end - at - 85 < length) return null
    calls.push({
      operation: hexToNumber(slice(packed, at, at + 1)),
      to: getAddress(slice(packed, at + 1, at + 21)),
      value: hexToBigInt(slice(packed, at + 21, at + 53)),
      data: length === 0 ? '0x' : slice(packed, at + 85, at + 85 + length),
    })
    at += 85 + length
  }
  return calls.length > 0 ? calls : null
}

/** The owner's pre-validated signature: valid only when that owner sends the transaction. */
export const preValidated = (owner: Address): Hex =>
  concat([pad(owner, { size: 32 }), pad('0x00', { size: 32 }), '0x01'])

/** A contract call before it is wrapped: which contract (by name, for people), the ABI and the function with args. */
export interface Call {
  contract: string
  to: Address
  abi: Abi
  functionName: string
  args?: readonly unknown[]
}

export const calldata = (c: Call): Hex =>
  encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args ?? [] } as never)

/**
 * `execTransaction` on `safe` for `inner`, from `owner`: no refund and no gas price, so a failing inner call fails
 * the whole transaction instead of being recorded as a failed Safe transaction. Operation 0 is a plain call; 1 is
 * used only to DELEGATECALL MultiSendCallOnly (`atomically`).
 */
export function execTransaction(owner: Address, inner: { to: Address; data: Hex; operation?: 0 | 1 }): Hex {
  return encodeFunctionData({
    abi: safeAbi,
    functionName: 'execTransaction',
    args: [inner.to, 0n, inner.data, inner.operation ?? 0, 0n, 0n, 0n, zeroAddress, zeroAddress, preValidated(owner)],
  })
}

/** One `execTransaction` that makes `calls` in order through MultiSendCallOnly: all happen, or none (D13). */
export const atomically = (owner: Address, calls: ReadonlyArray<{ to: Address; data: Hex }>): Hex =>
  execTransaction(owner, { to: MULTI_SEND_CALL_ONLY, data: multiSend(calls), operation: 1 })

/** A call as people read it: the function and each argument by name, decoded from the calldata itself. */
export function describe(abi: Abi, data: Hex): { functionName: string; args: Array<[string, string]> } {
  const { functionName, args = [] } = decodeFunctionData({ abi, data })
  const fn = abi.find(
    (item) => item.type === 'function' && item.name === functionName && item.inputs.length === args.length,
  )
  const inputs = fn !== undefined && fn.type === 'function' ? fn.inputs : []
  return { functionName, args: args.map((value, i) => [inputs[i]?.name || `arg${i}`, show(value)]) }
}

function show(value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return `[${value.map(show).join(', ')}]`
  if (value !== null && typeof value === 'object')
    return `{ ${Object.entries(value)
      .map(([k, v]) => `${k}: ${show(v)}`)
      .join(', ')} }`
  return String(value)
}
