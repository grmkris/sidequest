import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrivyServer, PrivyServerError } from './privy-server.ts'
import { type UserOperation, executeCalldata, laneNonce, nonceKey } from './index.ts'

afterEach(() => vi.unstubAllGlobals())

const delegator = '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B'
const op: UserOperation = {
  sender: '0x1111111111111111111111111111111111111111',
  nonce: laneNonce(nonceKey('op-1')),
  callData: executeCalldata([{ to: '0x2222222222222222222222222222222222222222', value: 0n, data: '0x' }]),
  callGasLimit: 200_000n,
  verificationGasLimit: 120_000n,
  preVerificationGas: 60_000n,
  maxFeePerGas: 102_000_000_000n,
  maxPriorityFeePerGas: 2_000_000_000n,
  paymaster: '0x3333333333333333333333333333333333333333',
  paymasterVerificationGasLimit: 50_000n,
  paymasterPostOpGasLimit: 40_000n,
  paymasterData: '0xabcd',
  signature: '0x',
}

function server(reply: unknown) {
  const requests: Request[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    requests.push(new Request(url, init))
    return Response.json(reply)
  })
  const privy = new PrivyServer({ appId: 'app', appSecret: 'secret', sign: async () => 'authorization-signature' })
  return { privy, requests }
}

describe('Privy user-operation signing', () => {
  it("asks for the delegated contract's signature with the chain in hex and the operation in snake case", async () => {
    const signature = `0x${'ab'.repeat(65)}`
    const { privy, requests } = server({ method: 'eth_signUserOperation', data: { signature, encoding: 'hex' } })
    expect(await privy.signUserOperation('wallet-1', delegator, 10143, op, 'key-1')).toBe(signature)
    const [request] = requests
    expect(request?.url).toBe('https://api.privy.io/v1/wallets/wallet-1/rpc')
    expect(request?.headers.get('privy-idempotency-key')).toBe('key-1')
    expect(request?.headers.get('privy-authorization-signature')).toBe('authorization-signature')
    expect(await request?.json()).toEqual({
      method: 'eth_signUserOperation',
      params: {
        contract: delegator,
        chain_id: '0x279f',
        user_operation: {
          sender: op.sender,
          nonce: `0x${op.nonce.toString(16)}`,
          call_data: op.callData,
          call_gas_limit: '0x30d40',
          verification_gas_limit: '0x1d4c0',
          pre_verification_gas: '0xea60',
          max_fee_per_gas: '0x17bfac7c00',
          max_priority_fee_per_gas: '0x77359400',
          paymaster: op.paymaster,
          paymaster_data: '0xabcd',
          paymaster_verification_gas_limit: '0xc350',
          paymaster_post_op_gas_limit: '0x9c40',
        },
      },
    })
  })

  it('refuses a reply without a 65-byte signature', async () => {
    for (const data of [{}, { signature: '0x1234' }, { signature: 42 }]) {
      const { privy } = server({ data })
      await expect(privy.signUserOperation('wallet-1', delegator, 10143, op, 'key-1')).rejects.toThrow(PrivyServerError)
    }
  })
})
