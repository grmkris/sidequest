import { type Address, type Hex, encodeAbiParameters, encodeEventTopics, parseAbi, toHex } from 'viem'
import { expect, it } from 'vitest'
import { deployment } from '../deployment.ts'
import { findUserOpEvent } from './events.ts'
import { AaError, field, quantity, type JsonRpc } from './rpc.ts'

const baseDeployment = deployment('monad-testnet')
const entryPoint = baseDeployment.aa!.entryPoint
const sender: Address = '0x1111111111111111111111111111111111111111'
const paymaster = baseDeployment.admin
const userOpHash: Hex = `0x${'ab'.repeat(32)}`
const txHash: Hex = `0x${'cd'.repeat(32)}`
const abi = parseAbi([
  'event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)',
])

const event = {
  address: entryPoint,
  topics: encodeEventTopics({ abi, eventName: 'UserOperationEvent', args: { userOpHash, sender, paymaster } }),
  data: encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
    [0n, true, 42n, 1n],
  ),
  transactionHash: txHash,
}

const wrongNonce: JsonRpc = async (method) => (method === 'eth_blockNumber' ? '0x1' : [event])

const quiet: JsonRpc = async (method) => {
  if (method === 'eth_blockNumber') return '0x1'
  throw new AaError('unavailable', 'quiet node')
}

const malformed: JsonRpc = async (method) => (method === 'eth_blockNumber' ? '0x1' : [{ ...event, topics: [] }])

const aheadNode: JsonRpc = async (method) => {
  expect(method).toBe('eth_blockNumber')
  return '0x10'
}

it('finds a sender nonce event through provider windows no wider than 100 blocks', async () => {
  const ranges: Array<[bigint, bigint]> = []
  const node: JsonRpc = async (method, params) => {
    if (method === 'eth_blockNumber') return toHex(5_000n)
    const from = quantity(field(params[0], 'fromBlock'), 'from block')
    const to = quantity(field(params[0], 'toBlock'), 'to block')
    ranges.push([from, to])
    if (to - from > 100n) throw new Error('eth_getLogs is limited to a 100 range')
    return from === 4_900n ? [event] : []
  }
  await expect(findUserOpEvent(node, entryPoint, sender, 0n, 0n)).resolves.toEqual({
    txHash,
    success: true,
    userOpHash,
    actualGasCost: 42n,
  })
  expect(ranges.every(([from, to]) => to - from <= 100n)).toBe(true)
  expect(ranges).toHaveLength(50)
})

it('starts at the later of the requested block and the bounded lookback', async () => {
  const ranges: Array<[bigint, bigint]> = []
  const node: JsonRpc = async (method, params) => {
    if (method === 'eth_blockNumber') return '0x1388'
    ranges.push([
      quantity(field(params[0], 'fromBlock'), 'from block'),
      quantity(field(params[0], 'toBlock'), 'to block'),
    ])
    return []
  }
  await findUserOpEvent(node, entryPoint, sender, 0n, 4_950n)
  expect(ranges[0]).toEqual([4_950n, 5_000n])
  expect(ranges).toHaveLength(1)
})

it('covers the exact lookback boundary, current block and early chain without more than 50 queries', async () => {
  for (const latest of [99n, 5_000n, 9_000n]) {
    const ranges: Array<[bigint, bigint]> = []
    const node: JsonRpc = async (method, params) => {
      if (method === 'eth_blockNumber') return toHex(latest)
      ranges.push([
        quantity(field(params[0], 'fromBlock'), 'from block'),
        quantity(field(params[0], 'toBlock'), 'to block'),
      ])
      return []
    }
    expect(await findUserOpEvent(node, entryPoint, sender, 0n, 0n)).toBeNull()
    expect(ranges[0]![0]).toBe(latest > 5_000n ? latest - 5_000n : 0n)
    expect(ranges.at(-1)![1]).toBe(latest)
    expect(ranges.length).toBeLessThanOrEqual(50)
    expect(ranges.every(([from, to]) => to - from <= 100n)).toBe(true)
  }
})
it('ignores removed logs, other EntryPoints, senders and nonces', async () => {
  const otherSender = paymaster
  const node: JsonRpc = async (method) =>
    method === 'eth_blockNumber'
      ? '0x1'
      : [
          { ...event, removed: true },
          { ...event, address: paymaster },
          {
            ...event,
            topics: encodeEventTopics({
              abi,
              eventName: 'UserOperationEvent',
              args: { userOpHash, sender: otherSender, paymaster },
            }),
          },
        ]
  expect(await findUserOpEvent(node, entryPoint, sender, 0n, 0n)).toBeNull()
  expect(await findUserOpEvent(wrongNonce, entryPoint, sender, 1n, 0n)).toBeNull()
})
it('propagates RPC and malformed-log failures instead of proving absence', async () => {
  await expect(findUserOpEvent(quiet, entryPoint, sender, 0n, 0n)).rejects.toMatchObject({ code: 'unavailable' })
  await expect(findUserOpEvent(malformed, entryPoint, sender, 0n, 0n)).rejects.toMatchObject({ code: 'unavailable' })
})
it('makes no log queries when the saved block is ahead of the node', async () => {
  expect(await findUserOpEvent(aheadNode, entryPoint, sender, 0n, 17n)).toBeNull()
})
