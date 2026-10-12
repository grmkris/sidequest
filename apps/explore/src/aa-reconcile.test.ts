import * as sdk from '@sidequest/sdk'
import { Schema } from 'effect'
import { type Hex, encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem'
import { expect, it } from 'vitest'
import { browserAaRpc, reconcileUserOp } from './aa-request.ts'

const deployment = sdk.deployment('monad-testnet')
const actionId = 'persisted-job'
const op: sdk.UserOperation = {
  sender: deployment.admin,
  nonce: sdk.laneNonce(sdk.nonceKey(actionId)),
  callData: sdk.executeCalldata([{ to: deployment.core, value: 0n, data: '0x1234' }]),
  callGasLimit: 100_000n,
  verificationGasLimit: 200_000n,
  preVerificationGas: 50_000n,
  maxFeePerGas: 100n,
  maxPriorityFeePerGas: 1n,
  signature: sdk.ESTIMATE_SIGNATURE,
}
const built: sdk.BuiltUserOp = {
  op,
  chainId: deployment.chainId,
  entryPoint: deployment.aa!.entryPoint,
  maxCost: 100n,
  userOpHash: sdk.userOpHash(op, deployment.chainId, deployment.aa!.entryPoint),
}
const txHash: Hex = `0x${'ab'.repeat(32)}`
const eventAbi = parseAbi([
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
])
const Request = Schema.Struct({
  method: Schema.Literals(['eth_getUserOperationReceipt', 'eth_getUserOperationByHash', 'eth_getLogs', 'eth_call']),
})
const event = (nonce: bigint, hash: Hex = built.userOpHash) => ({
  transactionHash: txHash,
  topics: encodeEventTopics({
    abi: eventAbi,
    eventName: 'UserOperationEvent',
    args: { userOpHash: hash, sender: op.sender, paymaster: deployment.admin },
  }),
  data: encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
    [nonce, true, 100n, 1n],
  ),
})
function fixture(options: { unavailable?: boolean; consumed?: boolean; logs?: ReturnType<typeof event>[] } = {}) {
  const methods: string[] = []
  const fetcher: typeof fetch = async (_input, init) => {
    const body = Schema.decodeUnknownSync(Request)(JSON.parse(Schema.decodeUnknownSync(Schema.String)(init?.body)))
    methods.push(body.method)
    if (body.method === 'eth_getUserOperationReceipt' && options.unavailable) throw new Error('receipt service down')
    const results = {
      eth_getUserOperationReceipt: null,
      eth_getUserOperationByHash: null,
      eth_getLogs: options.logs ?? [],
      eth_call: encodeAbiParameters([{ type: 'uint256' }], [options.consumed ? 1n : 0n]),
    }
    const result = results[body.method]
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
  }
  return { rpc: browserAaRpc('http://node.invalid', 'http://api.invalid', fetcher), methods }
}
it('recovers the original bundle event even when the bundler receipt service is down', async () => {
  const f = fixture({ unavailable: true, consumed: true, logs: [event(op.nonce)] })
  expect(await reconcileUserOp(f.rpc, built, { actionId, block: '0x10', submittedAt: 1 }, 200_000)).toEqual({
    at: 'receipt',
    receipt: { txHash, status: 'success' },
  })
})
it('does not use an event for another nonce or operation hash as proof', async () => {
  const f = fixture({ consumed: true, logs: [event(op.nonce + 1n), event(op.nonce, txHash)] })
  expect(await reconcileUserOp(f.rpc, built, { actionId, block: '0x10', submittedAt: 1 }, 200_000)).toEqual({
    at: 'unknown',
  })
})
it('requires working receipt service and the full 120 seconds before dropped proof', async () => {
  const down = fixture({ unavailable: true })
  expect(await reconcileUserOp(down.rpc, built, { actionId, submittedAt: 1 }, 200_000)).toEqual({ at: 'unknown' })
  const f = fixture()
  expect(await reconcileUserOp(f.rpc, built, { actionId, submittedAt: 1 }, 120_000)).toEqual({ at: 'pending' })
  expect(f.methods).not.toContain('eth_getUserOperationByHash')
  expect(await reconcileUserOp(f.rpc, built, { actionId, submittedAt: 1 }, 120_001)).toEqual({ at: 'dropped' })
})
