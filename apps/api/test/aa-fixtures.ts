import * as Schema from 'effect/Schema'
import {
  type Address,
  type Hex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  parseAbi,
} from 'viem'
import {
  type Call,
  type Json,
  type JsonRpc,
  type UserOperation,
  aaConfig,
  deployment,
  executeCalldata,
  toBundlerJson,
} from '@sidequest/sdk'

export const testnet = deployment('monad-testnet')
export const mainnet = {
  ...testnet,
  ...aaConfig('monad-mainnet'),
  network: 'monad-mainnet' as const,
  testnetFaucet: null,
}
export const paymaster: Address = '0x00000000000000000000000000000000000000bb'
export const sender: Address = '0x00000000000000000000000000000000000000aa'
export const charged = { ...testnet, aa: { ...testnet.aa!, paymaster } }
export const signerKey: Hex = `0x${'22'.repeat(32)}` // Synthetic unit-test key, never used by a provider.
const pricingAbi = parseAbi([
  'function exchangeRate() view returns (uint256)',
  'function postOpGas() view returns (uint256)',
])
const word = (n: bigint) => encodeAbiParameters([{ type: 'uint256' }], [n])
export const work: Call = { to: testnet.core, value: 0n, data: '0x12345678' }
export const approve = (amount = 1_000_000n): Call => ({
  to: charged.aa.gasToken,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [paymaster, amount] }),
})
export const operation = (calls: readonly Call[] = [work, approve()]): UserOperation => ({
  sender,
  nonce: 0n,
  callData: executeCalldata(calls),
  signature: '0x',
  callGasLimit: 300_000n,
  verificationGasLimit: 200_000n,
  preVerificationGas: 50_000n,
  maxFeePerGas: 100_000_000_000n,
  maxPriorityFeePerGas: 2_000_000_000n,
  paymaster,
  paymasterVerificationGasLimit: 100_000n,
  paymasterPostOpGasLimit: 200_000n,
})
export const paymasterParams = (op = operation()): Json[] => [
  toBundlerJson(op),
  charged.aa.entryPoint,
  '0x279f',
  { token: charged.aa.gasToken },
]

export function node(over: { balance?: bigint; allowance?: bigint; failPull?: boolean } = {}): {
  rpc: JsonRpc
  calls: Json[][]
} {
  const calls: Json[][] = []
  const rpc: JsonRpc = async (method, params) => {
    calls.push([method, ...params])
    // SAFETY: fixture callers emit the standard eth_call object; contract responses are encoded independently.
    const call = params[0] as { to: Address; from?: Address; data: Hex }
    if (call.from !== undefined) {
      if (over.failPull === true) throw new Error('delegation not redeemable')
      return '0x'
    }
    if (call.to === paymaster) {
      const decoded = decodeFunctionData({ abi: pricingAbi, data: call.data })
      return word(decoded.functionName === 'exchangeRate' ? 28_000n : 125_000n)
    }
    const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data })
    return word(decoded.functionName === 'balanceOf' ? (over.balance ?? 1_000_000n) : (over.allowance ?? 0n))
  }
  return { rpc, calls }
}

export function answering(
  result: Json,
  error = false,
): { fetcher: typeof fetch; calls: { url: string; method: string; params: readonly Json[] }[] } {
  const calls: { url: string; method: string; params: readonly Json[] }[] = []
  const fetcher: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      // SAFETY: the tested adapter always writes a JSON-RPC body; this capture is only a test double.
      const body = JSON.parse(Schema.decodeUnknownSync(Schema.String)(init?.body)) as {
        method: string
        params: readonly Json[]
      }
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      calls.push({ url, method: body.method, params: body.params })
      return Response.json({ jsonrpc: '2.0', id: 1, ...(error ? { error: result } : { result }) })
    },
    { preconnect: () => undefined },
  )
  return { fetcher, calls }
}
