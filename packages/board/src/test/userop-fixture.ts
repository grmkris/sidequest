/** Unit-test fixture only: in-memory SQLite, signed local test account, and fake JSON-RPC fetch. */
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import {
  type Hex,
  type Address,
  encodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  parseAbi,
  decodeFunctionData,
  toHex,
  isHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { AgentSigning } from '../agent-signing.ts'
import { AgentStore } from '../agents.ts'
import { GrantStore } from '../grants.ts'
import { fromNodeSqlite } from '../store.ts'
import { UserOpStore } from '../userop-store.ts'
import { UserOpDesk } from '../userop-desk.ts'
import type { Json } from '@sidequest/sdk'

const nonceAbi = parseAbi(['function getNonce(address sender,uint192 key) view returns (uint256)'])
const operatorAccount = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const operator: Address = operatorAccount.address
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)

export function userOpFixture() {
  const db = new DatabaseSync(':memory:')
  const sql = fromNodeSqlite(db)
  const clock = { now: 1_800_000_000 }
  const responses: { receipt: Json; logs: Json[]; receipts: Record<string, Json> } = {
    receipt: null,
    logs: [],
    receipts: {},
  }
  const state = {
    ...responses,
    sends: 0,
    signs: 0,
    estimates: 0,
    fee: 1_000_000_000n,
    sequence: 0n,
    code: 'delegated',
    uncertain: false,
    refused: false,
    ceiling: false,
    balance: 5_000_000n,
    disabled: false,
    hash: sdk.EMPTY_HASH,
    receipts: responses.receipts,
  }
  const base = sdk.context('monad-testnet', 'main', 'http://unused.invalid')
  const deployment = {
    ...base.deployment,
    agentSweep: base.deployment.identity,
    aa: { ...base.deployment.aa!, paymaster: base.deployment.attester },
  }
  const client = {
    ...base.publicClient,
    // SAFETY: the fixture responds to the only view methods exercised by the desk and batch builders.
    readContract: (async (input: { functionName: string }) => {
      const values: Record<string, Json | bigint | readonly (bigint | boolean)[]> = {
        disabledDelegations: state.disabled,
        callCounts: 0n,
        getAvailableAmount: [5_000_000n, false, 0n],
        balanceOf: state.balance,
        minimumCreatorBond: 1n,
        unfilledForfeitBps: 0,
        CANCEL_GRACE: 1,
        treasury: operator,
        availableOf: 100n,
      }
      if (!(input.functionName in values)) throw new Error(`Unexpected contract read ${input.functionName}`)
      return values[input.functionName]
    }) as sdk.Ctx['publicClient']['readContract'],
    getCode: async (): Promise<Hex> =>
      state.code === 'delegated' ? `0xef0100${deployment.delegation.delegator.slice(2)}` : '0x',
    getTransactionCount: async () => 0,
  }
  const context: sdk.Ctx = { ...base, deployment, publicClient: client }
  const agents = new AgentStore(sql, () => clock.now)
  agents.create({
    id: 'agent',
    operator,
    privyUserId: 'user',
    name: 'Agent',
    registry: deployment.identity,
    chainId: deployment.chainId,
  })
  agents.bindWallet('agent', 'wallet', account.address)
  sql.run("UPDATE agents SET state='active',agent_id='7' WHERE id='agent'")
  const grants = new GrantStore(sql, context)
  const budget = grants.prepare(operator, {
    kind: 'gas-allowance',
    delegator: operator,
    agent: account.address,
    token: deployment.aa.gasToken,
    amount: 5_000_000n,
    periodSeconds: 604800,
    start: clock.now,
    salt: 1n,
  })
  sql.run("UPDATE grants SET status='live',signature='0x1234' WHERE delegation_hash=?", budget.hash)
  const store = new UserOpStore(sql, () => clock.now)
  const signing = new AgentSigning(
    sql,
    context,
    {
      signTypedData: async (_wallet, data) => {
        // SAFETY: AgentSigning validates this fixture's typed data before requesting the local signature.
        const typed = JSON.parse(data) as Parameters<typeof account.signTypedData>[0]
        return account.signTypedData(typed)
      },
      signAuthorization: async (_wallet, address, chainId, nonce) =>
        account.signAuthorization({ contractAddress: address, chainId, nonce }),
      signUserOperation: async (_wallet, _contract, chainId, op) => {
        state.signs++
        expectStored(op.sender)
        return account.sign({ hash: sdk.delegatorDigest(op, chainId, deployment.aa.entryPoint) })
      },
    },
    () => clock.now,
  )
  function expectStored(sender: string) {
    if (sql.all('SELECT id FROM userop_operations WHERE sender=?', sender.toLowerCase()).length === 0)
      throw new Error('Operation was not persisted')
  }
  function send(params: Json[]): Json {
    state.sends++
    // SAFETY: sdk.toBundlerJson emits this sender and the journal already has the signed bytes.
    const op = params[0] as { sender: Hex }
    expectStored(op.sender)
    const row = sql.all<{ status: string; userop_hash: Hex }>(
      'SELECT status,userop_hash FROM userop_operations WHERE sender=? ORDER BY updated_at DESC',
      op.sender.toLowerCase(),
    )[0]!
    if (row.status !== 'uncertain') throw new Error('Send uncertainty was not journaled')
    state.hash = row.userop_hash
    if (state.uncertain) throw new Error('Network timeout')
    if (state.refused) throw new sdk.AaError('refused', 'test refusal')
    return row.userop_hash
  }
  async function answer(method: string, params: Json[]): Promise<Json> {
    switch (method) {
      case 'eth_getCode':
        return state.code === 'delegated' ? `0xef0100${deployment.delegation.delegator.slice(2)}` : '0x'
      case 'eth_getTransactionCount':
        return '0x0'
      case 'eth_blockNumber':
        return '0x1388'
      case 'eth_getLogs':
        return state.logs
      case 'eth_call': {
        // SAFETY: the SDK emits this RPC call object with canonical hex data.
        const call = params[0] as { data: Hex }
        const fn = decodeFunctionData({ abi: [...nonceAbi, ...erc20Abi], data: call.data }).functionName
        return fn === 'getNonce'
          ? encodeFunctionResult({ abi: nonceAbi, functionName: 'getNonce', result: state.sequence })
          : encodeFunctionResult({ abi: erc20Abi, functionName: 'allowance', result: 0n })
      }
      case 'pimlico_getUserOperationGasPrice':
        return { fast: { maxFeePerGas: toHex(state.fee), maxPriorityFeePerGas: '0x1' } }
      case 'pimlico_getTokenQuotes':
        return {
          quotes: [
            {
              paymaster: deployment.aa.paymaster,
              exchangeRate: state.ceiling ? '0xffffffffffffffff' : '0xf4240',
              postOpGas: '0x0',
            },
          ],
        }
      case 'pm_getPaymasterStubData':
      case 'pm_getPaymasterData':
        return {
          paymaster: deployment.aa.paymaster,
          paymasterData: '0x1234',
          paymasterVerificationGasLimit: '0x100',
          paymasterPostOpGasLimit: '0x100',
        }
      case 'eth_estimateUserOperationGas':
        state.estimates++
        return { callGasLimit: '0x100', verificationGasLimit: '0x100', preVerificationGas: '0x100' }
      case 'eth_sendUserOperation':
        return send(params)
      case 'eth_getUserOperationReceipt':
        return isHex(params[0]) ? (state.receipts[params[0]] ?? state.receipt) : state.receipt
      default:
        throw new Error(`Unexpected RPC ${method}`)
    }
  }
  const fetcher: typeof fetch = async (url, init) => {
    // SAFETY: sdk.jsonRpc generates this JSON request body; the fixture never reaches the network.
    const request = JSON.parse(await new Request(url, init).text()) as { id: number; method: string; params: Json[] }
    try {
      return Response.json({ jsonrpc: '2.0', id: request.id, result: await answer(request.method, request.params) })
    } catch (error) {
      if (error instanceof sdk.AaError)
        return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error.message } })
      throw error
    }
  }
  const rpc = sdk.jsonRpc('http://unused.invalid', 'unit RPC', fetcher)
  const desk = new UserOpDesk({
    context,
    signing,
    store,
    now: () => clock.now,
    rpc: { node: rpc, bundler: rpc, paymaster: rpc },
  })
  const id: Hex = `0x${'ab'.repeat(32)}`
  const settle = {
    to: context.stack.holding,
    value: 0n,
    data: encodeFunctionData({ abi: sdk.sidequestHoldingAbi, functionName: 'settle', args: [1n] }),
  }
  return {
    db,
    sql,
    context,
    agents,
    signing,
    store,
    grants,
    budget,
    desk,
    state,
    clock,
    account,
    operator,
    operatorAccount,
    input: { id, agentId: 'agent', calls: [settle] },
  }
}
