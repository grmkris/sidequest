import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import * as sdk from '@sidequest/sdk'
import { AgentRegistration } from './agent-registration.ts'
import { AgentSigning } from './agent-signing.ts'
import { AgentStore } from './agents.ts'
import { fromNodeSqlite } from './store.ts'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  const deployment = sdk.deployment('monad-testnet')
  const operator = privateKeyToAccount(generatePrivateKey()).address
  const account = privateKeyToAccount(generatePrivateKey())
  let now = 1000
  const call = vi.fn(async () => ({
    data: encodeFunctionResult({ abi: sdk.identityAbi, functionName: 'register', result: 41n }),
  }))
  const readContract = vi.fn(async (args: { functionName: string }) =>
    args.functionName === 'ownerOf' ? operator : account.address,
  )
  const receipt: TransactionReceipt = {
    status: 'success',
    blockNumber: 20n,
    transactionHash: sdk.EMPTY_HASH,
    logs: [],
    blockHash: sdk.EMPTY_HASH,
    contractAddress: null,
    cumulativeGasUsed: 1n,
    effectiveGasPrice: 1n,
    from: operator,
    gasUsed: 1n,
    logsBloom: '0x',
    to: operator,
    transactionIndex: 0,
    type: 'eip7702',
  }
  const getTransactionReceipt = vi.fn(async () => receipt)
  // SAFETY: unit-only chain reads implement just the methods used by registration.
  const context = {
    ...sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1'),
    publicClient: {
      ...sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1').publicClient,
      call,
      readContract,
      getTransactionReceipt,
    },
  } as sdk.Ctx
  const agents = new AgentStore(sql, () => now)
  agents.create({
    id: 'quill',
    operator,
    privyUserId: 'did:privy:operator',
    name: 'Quill',
    registry: deployment.identity,
    chainId: deployment.chainId,
  })
  agents.bindWallet('quill', 'privy-wallet', account.address)
  agents.advance('quill', 'upgraded')
  agents.advance('quill', 'grants-live')
  const signTypedData = vi.fn(async (_wallet: string, data: string) => {
    // SAFETY: the SDK produces the viem EIP-712 envelope in this unit fixture.
    return account.signTypedData(JSON.parse(data) as Parameters<typeof account.signTypedData>[0])
  })
  const signing = new AgentSigning(sql, context, { signTypedData, signAuthorization: vi.fn() }, () => now)
  const boot = () =>
    new AgentRegistration({ sql, context, signing, now: () => now, publicOrigin: 'https://board.example' })
  const minted = (
    id = 41n,
    owner: Address = operator,
    uri = 'https://board.example/profiles/quill.json',
    registry: Address = deployment.identity,
  ) => {
    receipt.logs = [
      {
        address: registry,
        blockHash: sdk.EMPTY_HASH,
        blockNumber: 20n,
        logIndex: 0,
        transactionHash: sdk.EMPTY_HASH,
        transactionIndex: 0,
        removed: false,
        // SAFETY: both indexed scalar arguments are supplied, so no wildcard or OR topics occur.
        topics: encodeEventTopics({ abi: sdk.identityAbi, eventName: 'Registered', args: { agentId: id, owner } }) as [
          Hex,
          ...Hex[],
        ],
        data: encodeAbiParameters([{ type: 'string' }], [uri]),
      },
    ]
  }
  return {
    sql,
    agents,
    operator,
    account,
    call,
    readContract,
    receipt,
    getTransactionReceipt,
    signTypedData,
    boot,
    minted,
    clock: (value: number) => {
      now = value
    },
    context,
  }
}

it('freezes exactly register and wallet binding with an agent-signed predicted consent and no operator grant', async () => {
  const f = fixture()
  const batch = await f.boot().prepare('quill', f.operator, 'create-registration')
  expect(batch).toMatchObject({
    predictedAgentId: '41',
    deadline: 1300,
    agentURI: 'https://board.example/profiles/quill.json',
  })
  expect(batch.calls).toHaveLength(2)
  expect(
    batch.calls.every(
      (call) => call.value === '0' && call.to.toLowerCase() === f.context.deployment.identity.toLowerCase(),
    ),
  ).toBe(true)
  expect(decodeFunctionData({ abi: sdk.identityAbi, data: batch.calls[0]!.data })).toMatchObject({
    functionName: 'register',
    args: [batch.agentURI],
  })
  expect(decodeFunctionData({ abi: sdk.identityAbi, data: batch.calls[1]!.data }).args?.slice(0, 3)).toEqual([
    41n,
    f.account.address,
    1300n,
  ])
  expect(f.call.mock.calls[0]).toEqual([
    { account: f.operator, to: f.context.deployment.identity.toLowerCase(), data: batch.calls[0]!.data },
  ])
  expect(f.agents.get('quill').agent_id).toBeNull()
  expect(f.sql.all('SELECT * FROM grants')).toEqual([])
})

it('binds a batch that landed unrecorded from chain state instead of preparing a second mint', async () => {
  const f = fixture()
  const batch = await f.boot().prepare('quill', f.operator, 'first')
  // The page lost its receipt after the batch landed; the consent deadline has passed, so a fresh batch would mint 42.
  f.clock(5000)
  const landed: Record<string, string> = { ownerOf: f.operator, tokenURI: batch.agentURI }
  // SAFETY: the fixture's mock is typed for addresses; tokenURI's string answer is compared as a string only.
  f.readContract.mockImplementation(
    async (args: { functionName: string }) => (landed[args.functionName] ?? f.account.address) as `0x${string}`,
  )
  await expect(f.boot().prepare('quill', f.operator, 'retry')).rejects.toThrow('already registered')
  expect(f.agents.get('quill')).toMatchObject({ agent_id: '41', state: 'active' })
  // Another owner, URI or wallet on the predicted ID proves nothing: the retry prepares normally.
  const g = fixture()
  await g.boot().prepare('quill', g.operator, 'first')
  g.clock(5000)
  const elsewhere: Record<string, string> = { ownerOf: g.operator, tokenURI: 'https://elsewhere.example' }
  // SAFETY: as above, a string URI through the address-typed mock.
  g.readContract.mockImplementation(
    async (args: { functionName: string }) => (elsewhere[args.functionName] ?? g.account.address) as `0x${string}`,
  )
  await expect(g.boot().prepare('quill', g.operator, 'retry')).resolves.toMatchObject({ predictedAgentId: '41' })
  expect(g.agents.get('quill').agent_id).toBeNull()
})

it('returns the identical batch across reconstruction and renews only expired consent under the same key', async () => {
  const f = fixture()
  const first = await f.boot().prepare('quill', f.operator, 'batch')
  expect(await f.boot().prepare('quill', f.operator, 'batch')).toEqual(first)
  expect(f.signTypedData).toHaveBeenCalledTimes(1)
  expect(f.call).toHaveBeenCalledTimes(1)
  f.clock(1300)
  const next = await f.boot().prepare('quill', f.operator, 'batch')
  expect(next.deadline).toBe(1600)
  expect(next.calls[1]).not.toEqual(first.calls[1])
  expect(f.signTypedData).toHaveBeenCalledTimes(2)
})

it('persists the prediction and provider request before signing and retries the same request after failure', async () => {
  const f = fixture()
  f.signTypedData.mockRejectedValueOnce(new Error('provider uncertain'))
  await expect(f.boot().prepare('quill', f.operator, 'batch')).rejects.toThrow('provider uncertain')
  expect(f.sql.all('SELECT * FROM agent_operation_steps')).toHaveLength(1)
  expect(f.sql.all('SELECT * FROM agent_sign_requests')).toHaveLength(1)
  await f.boot().prepare('quill', f.operator, 'batch')
  expect(f.call).toHaveBeenCalledTimes(1)
  expect(f.signTypedData.mock.calls[0]).toEqual(f.signTypedData.mock.calls[1])
})

it('records the matched receipt, verifies both historical and current binding, and resumes active idempotently', async () => {
  const f = fixture()
  await f.boot().prepare('quill', f.operator, 'batch')
  f.minted()
  const hash = f.receipt.transactionHash
  expect(await f.boot().record('quill', f.operator, hash)).toMatchObject({ state: 'active', agent_id: '41' })
  expect(await f.boot().record('quill', f.operator, hash)).toMatchObject({ state: 'active', agent_id: '41' })
  expect(f.readContract).toHaveBeenCalledWith(
    expect.objectContaining({ functionName: 'getAgentWallet', blockNumber: 20n }),
  )
})

it.each(['revert', 'race', 'owner', 'registry', 'uri', 'wallet', 'current-owner'])(
  'refuses %s receipts without recording a mint',
  async (failure) => {
    const f = fixture()
    await f.boot().prepare('quill', f.operator, 'batch')
    f.minted()
    if (failure === 'revert') f.receipt.status = 'reverted'
    if (failure === 'race') f.minted(42n)
    if (failure === 'owner') f.minted(41n, f.account.address)
    if (failure === 'registry') f.minted(41n, f.operator, undefined, f.account.address)
    if (failure === 'uri') f.minted(41n, f.operator, 'https://elsewhere.example/profile')
    if (failure === 'wallet') f.readContract.mockResolvedValue(f.operator)
    if (failure === 'current-owner')
      f.readContract.mockImplementation(async (args) =>
        args.functionName === 'ownerOf' ? f.account.address : f.account.address,
      )
    await expect(f.boot().record('quill', f.operator, f.receipt.transactionHash)).rejects.toMatchObject({
      code: 'conflict',
    })
    expect(f.agents.get('quill')).toMatchObject({ agent_id: null, state: 'grants-live' })
  },
)

it('rejects another operator and refuses an unprepared receipt', async () => {
  const f = fixture()
  f.minted()
  await expect(f.boot().prepare('quill', f.account.address, 'batch')).rejects.toThrow('another operator')
  await expect(f.boot().record('quill', f.operator, f.receipt.transactionHash)).rejects.toMatchObject({
    code: 'conflict',
  })
  expect(f.call).not.toHaveBeenCalled()
  expect(f.signTypedData).not.toHaveBeenCalled()
})
