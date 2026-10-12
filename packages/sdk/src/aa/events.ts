import { type Address, type Hex, decodeEventLog, encodeEventTopics, parseAbi, toHex } from 'viem'
import { AaError, type Json, type JsonRpc, field, hexField, quantity } from './rpc.ts'

const eventAbi = parseAbi([
  'event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)',
])
const WINDOW = 100n
const LOOKBACK = 5_000n

export interface UserOpEvent {
  readonly txHash: Hex
  readonly success: boolean
  readonly userOpHash: Hex
  readonly actualGasCost: bigint
}

function readEvent(log: Json, entryPoint: Address, sender: Address, nonce: bigint): UserOpEvent | null {
  if (field(log, 'removed') === true) return null
  if (hexField(field(log, 'address'), 'event address').toLowerCase() !== entryPoint.toLowerCase()) return null
  const values = field(log, 'topics')
  if (!Array.isArray(values) || values.length !== 4) throw new AaError('unavailable', 'Invalid event topics')
  // SAFETY: the event has exactly four topics and hexField validates each one before ABI decoding.
  const topics = values.map((topic) => hexField(topic, 'event topic')) as [Hex, Hex, Hex, Hex]
  const { args } = decodeEventLog({ abi: eventAbi, data: hexField(field(log, 'data'), 'event data'), topics })
  if (args.sender.toLowerCase() !== sender.toLowerCase() || args.nonce !== nonce) return null
  const txHash = hexField(field(log, 'transactionHash'), 'event transaction')
  if (txHash.length !== 66) throw new AaError('unavailable', 'Invalid event transaction')
  return { txHash, success: args.success, userOpHash: args.userOpHash, actualGasCost: args.actualGasCost }
}

async function scanWindow(
  node: JsonRpc,
  entryPoint: Address,
  sender: Address,
  nonce: bigint,
  range: readonly [bigint, bigint],
): Promise<UserOpEvent | null> {
  const [from, to] = range
  const topics = encodeEventTopics({ abi: eventAbi, eventName: 'UserOperationEvent', args: { sender } })
  const logs = await node('eth_getLogs', [{ address: entryPoint, fromBlock: toHex(from), toBlock: toHex(to), topics }])
  if (!Array.isArray(logs)) throw new AaError('unavailable', 'Missing EntryPoint logs')
  for (const log of logs) {
    const event = readEvent(log, entryPoint, sender, nonce)
    if (event !== null) return event
  }
  return null
}

/**
 * Scan from max(fromBlock, latest - 5000) through latest in at most 50 RPC ranges. Monad limits the endpoint
 * difference to 100; adjacent ranges share their boundary block so the inclusive lookback fits in 50 requests.
 */
export async function findUserOpEvent(
  node: JsonRpc,
  entryPoint: Address,
  sender: Address,
  nonce: bigint,
  fromBlock: bigint,
): Promise<UserOpEvent | null> {
  const latest = quantity(await node('eth_blockNumber', []), 'latest block')
  const floor = latest > LOOKBACK ? latest - LOOKBACK : 0n
  const start = fromBlock > floor ? fromBlock : floor
  for (let window = 0; window < 50; window++) {
    const from = start + BigInt(window) * WINDOW
    if (from > latest) break
    const to = from + WINDOW < latest ? from + WINDOW : latest
    const event = await scanWindow(node, entryPoint, sender, nonce, [from, to])
    if (event !== null) return event
    if (to === latest) break
  }
  return null
}
