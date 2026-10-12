import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { decodeFunctionData } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, expect, it, vi } from 'vitest'
import { Board } from './service.ts'
import { fromNodeSqlite } from './store.ts'
import { canonicalJson, termsHash, type OfferTerms } from './terms.ts'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

async function fixture(relayConfigured: boolean) {
  const account = privateKeyToAccount(generatePrivateKey())
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  let spent = false,
    outcome = 3
  const read = vi.fn(async ({ functionName }: { functionName: string }) => {
    switch (functionName) {
      case 'paused':
        return false
      case 'disputedAt':
        return 900
      case 'termsOf':
        return { arbitrator: account.address }
      case 'rulingNonceUsed':
        return spent
      case 'caseOf':
        return { outcome }
      default:
        throw new Error(`Unexpected read ${functionName}`)
    }
  })
  // SAFETY: fake RPCs implement exactly the reads and signature verification used by submitRuling.
  const ctx = {
    ...base,
    publicClient: { ...base.publicClient, readContract: read, verifyTypedData: vi.fn(async () => true) },
  } as sdk.Ctx
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db),
    relaySend = vi.fn(async () => sdk.EMPTY_HASH)
  const board = new Board(sql, {
    network: 'monad-testnet',
    contexts: { main: ctx },
    domain: 'test',
    uri: 'https://test',
    manifestBaseUrl: 'https://test/offers',
    now: () => 1000,
    ...(relayConfigured ? { relay: { account, rpcUrl: 'http://127.0.0.1:1' }, relaySend } : {}),
  })
  const terms: OfferTerms = {
    v: 2,
    mode: 'hire',
    taskId: 'task',
    projectId: null,
    policyVersion: null,
    title: 'Ruling',
    brief: 'Resolve dispute',
    acceptanceCriteria: [],
    deployment: {
      chainId: base.deployment.chainId,
      core: base.deployment.core,
      holding: base.stack.holding,
      evaluator: base.stack.evaluator,
      identity: base.deployment.identity,
    },
    creator: account.address,
    approver: account.address,
    token: base.deployment.rewardTokens[0]!,
    reward: 1n,
    creatorBond: 0n,
    workerBond: 0n,
    deliveryDeadline: 2000,
    windows: { reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 },
    eligibility: null,
    evidencePolicy: null,
    quote: null,
    salt: sdk.EMPTY_HASH,
  }
  sql.run(
    'INSERT INTO tasks (id,creator,stack,terms_json,terms_hash,job_id,from_block,created_at) VALUES (?,?,?,?,?,?,?,?)',
    'task',
    account.address,
    'main',
    canonicalJson(terms),
    termsHash(terms),
    '42',
    0,
    0,
  )
  sql.run(
    'INSERT INTO rulings (task_id,disputed_at,arbitrator,runner,bundle_hash,for_worker,slash_loser,reason_hash,deadline,nonce,signature,tx_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    'task',
    900,
    account.address,
    'test',
    sdk.EMPTY_HASH,
    1,
    0,
    sdk.hashText('reason'),
    2000,
    '7',
    null,
    null,
    1000,
  )
  const submit = () => board.submitRuling({ address: account.address }, { taskId: 'task', signature: '0x1234' })
  return {
    submit,
    ctx,
    db,
    relaySend,
    spent: (cancelled = false) => {
      spent = true
      outcome = cancelled ? 0 : 3
    },
  }
}

it.each([false, true])('prepares the same ruling without broadcasting (relay configured=%s)', async (configured) => {
  const f = await fixture(configured)
  const first = await f.submit(),
    retry = await f.submit()
  expect(retry).toEqual(first)
  expect(first).toMatchObject({ nonce: '7', landed: false, state: 'prepared', relayed: false, txHash: null })
  expect(first.transactions[0]).toMatchObject({
    to: f.ctx.stack.evaluator,
    chainId: f.ctx.deployment.chainId,
    value: '0',
  })
  const call = decodeFunctionData({ abi: sdk.sidequestEvaluatorAbi, data: first.transactions[0]!.data })
  expect(call.functionName).toBe('ruleWithSignature')
  expect(f.db.prepare('SELECT signature FROM rulings').get()).toEqual({ signature: '0x1234' })
  expect(f.relaySend).not.toHaveBeenCalled()
})
it('a spent ruling nonce returns landed state and the known hash while cancellation is refused', async () => {
  const f = await fixture(true)
  await f.submit()
  f.spent()
  expect(await f.submit()).toMatchObject({ landed: true, state: 'landed', txHash: null, nonce: '7' })
  const hash = sdk.hashText('landed')
  f.db
    .prepare(
      "INSERT INTO operations (id,task_id,kind,actor,status,tx_hash,detail,created_at,updated_at) VALUES ('rule','task','rule','actor','confirmed',?,?,1000,1000)",
    )
    .run(hash, JSON.stringify({ reasonHash: sdk.hashText('reason'), forWorker: true, slashLoser: false }))
  expect(await f.submit()).toMatchObject({ landed: true, txHash: hash, nonce: '7' })
  f.spent(true)
  await expect(f.submit()).rejects.toThrow('cancelled')
  expect(f.relaySend).not.toHaveBeenCalled()
})
