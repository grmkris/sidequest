import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import {
  type Hex,
  type TransactionReceipt,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  hashTypedData,
  verifyTypedData,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, expect, it, vi } from 'vitest'
import { Board } from './service.ts'
import { fromNodeSqlite } from './store.ts'
import { canonicalJson, termsHash, type OfferTerms } from './terms.ts'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
const sha = 'a'.repeat(40)
const delivery = { kind: 'git' as const, url: 'https://github.com/example/delivery', ref: 'main', sha }

function offer(ctx: sdk.Ctx, creator: Hex): OfferTerms {
  return {
    v: 2,
    mode: 'hire',
    taskId: 'task',
    projectId: null,
    policyVersion: null,
    title: 'Evidence',
    brief: 'Exact CI',
    acceptanceCriteria: ['tests pass'],
    deployment: {
      chainId: ctx.deployment.chainId,
      core: ctx.deployment.core,
      holding: ctx.stack.holding,
      evaluator: ctx.stack.evaluator,
      identity: ctx.deployment.identity,
    },
    creator,
    approver: creator,
    arbitrator: ctx.deployment.arbitrator,
    token: ctx.deployment.rewardTokens[0]!,
    reward: 1n,
    creatorBond: 0n,
    workerBond: 0n,
    deliveryDeadline: 2000,
    windows: { reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 },
    eligibility: null,
    evidencePolicy: { checks: ['test'], trustedProducer: 'github-actions', workflowPath: '.github/workflows/test.yml' },
    quote: null,
    salt: sdk.EMPTY_HASH,
  }
}

function fixture(configured = true) {
  const worker = privateKeyToAccount(generatePrivateKey()),
    attester = privateKeyToAccount(generatePrivateKey()),
    creator = privateKeyToAccount(generatePrivateKey())
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1'),
    terms = offer(base, creator.address)
  const hash = termsHash(terms)
  const read = vi.fn(async ({ functionName }: { functionName: string }) => {
    switch (functionName) {
      case 'paused':
        return false
      case 'getJob':
        return { provider: worker.address, status: 1, submittedAt: 0, providerAgentId: 1n }
      case 'termsOf':
        return { ...terms, funded: 1n, reviewWindow: 120, disputeWindow: 120, arbitrationWindow: 300 }
      case 'getListing':
        return {
          ...terms,
          policyHash: hash,
          feeBps: 0,
          fee: 0n,
          bonus: 0n,
          expiredAt: 4000,
          rewardSettled: false,
          creatorBondSettled: false,
          workerBondReserved: false,
        }
      case 'caseOf':
        return { outcome: 0, rejectedAt: 0, disputedAt: 0, violation: 0 }
      default:
        throw new Error(`Unexpected read ${functionName}`)
    }
  })
  // SAFETY: the fake RPC returns the exact chain facts consumed by submit/evidence preparation.
  const ctx = {
    ...base,
    publicClient: {
      ...base.publicClient,
      readContract: read,
      getBlock: vi.fn().mockResolvedValue({ timestamp: 1000n }),
      getTransactionReceipt: vi.fn(),
      waitForTransactionReceipt: vi.fn(),
    },
  } as sdk.Ctx
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db),
    relaySend = vi.fn(async () => sdk.EMPTY_HASH)
  let conclusion = 'success',
    status = 'completed'
  const fetcher = vi.fn(async () =>
    Response.json({
      check_runs: [{ name: 'test', status, conclusion, head_sha: sha, app: { slug: 'github-actions' } }],
    }),
  )
  vi.stubGlobal('fetch', fetcher)
  const config = {
    network: 'monad-testnet' as const,
    contexts: { main: ctx },
    domain: 'test',
    uri: 'https://test',
    manifestBaseUrl: 'https://test/offers',
    now: () => 1000,
    fetch: fetcher,
    relaySend,
    ...(configured ? { evidence: { attester } } : {}),
  }
  const boot = () => new Board(sql, config),
    board = boot()
  sql.run(
    'INSERT INTO tasks (id,creator,stack,terms_json,terms_hash,job_id,from_block,created_at) VALUES (?,?,?,?,?,?,?,?)',
    'task',
    creator.address,
    'main',
    canonicalJson(terms),
    hash,
    '42',
    0,
    0,
  )
  const submit = (target = delivery) =>
    board.submitWork({ address: worker.address }, { taskId: 'task', deliverable: target })
  return {
    submit,
    board,
    boot,
    db,
    ctx,
    worker,
    attester,
    hash,
    relaySend,
    fetcher,
    fail: () => {
      conclusion = 'failure'
    },
    pending: () => {
      status = 'in_progress'
    },
  }
}

it('submit preparation carries the exact signed evidence in the worker batch, with no relay or receipt wait', async () => {
  const f = fixture(),
    prepared = await f.submit(),
    signed = prepared.evidenceAttestation!
  expect(signed.attestation).toMatchObject({
    jobId: '42',
    submissionHash: prepared.deliverableHash,
    policyHash: f.hash,
    repo: sdk.hashText(delivery.url),
    testedSha: `0x${sha.padStart(64, '0')}`,
    conclusion: 1,
  })
  expect(prepared.transactions).toHaveLength(2)
  expect(decodeFunctionData({ abi: sdk.coreAbi, data: prepared.transactions[0]!.data }).functionName).toBe('submit')
  expect(prepared.transactions[1]).toMatchObject({ ...sdk.attachEvidenceCall(f.ctx, signed), value: '0' })
  expect(
    await verifyTypedData({
      address: f.attester.address,
      domain: sdk.evaluatorDomain(f.ctx.deployment.chainId, f.ctx.stack.evaluator),
      types: sdk.evidenceTypes,
      primaryType: 'EvidenceAttestation',
      message: { ...signed.attestation, jobId: 42n, validUntil: BigInt(signed.attestation.validUntil) },
      signature: signed.signature,
    }),
  ).toBe(true)
  expect(f.db.prepare('SELECT tx_hash FROM evidence').get()).toEqual({ tx_hash: '' })
  expect(f.relaySend).not.toHaveBeenCalled()
  expect(f.ctx.publicClient.waitForTransactionReceipt).not.toHaveBeenCalled()
})
it('a restarted board reuses the same persisted signed attestation and refreshes legacy rows', async () => {
  const f = fixture(),
    first = await f.submit()
  const retry = await f.boot().requestEvidence({ address: f.worker.address }, { taskId: 'task' })
  expect(retry).toMatchObject({ reused: true, txHash: null, evidenceAttestation: first.evidenceAttestation })
  f.db.prepare('UPDATE evidence SET checks_json=?').run(JSON.stringify({ checks: [], missing: [] }))
  expect(await f.board.requestEvidence({ address: f.worker.address }, { taskId: 'task' })).toMatchObject({
    reused: false,
    txHash: null,
  })
})
it('failed checks produce signed failure evidence; running checks and no attester allow advisory-free submission', async () => {
  const f = fixture()
  f.fail()
  expect((await f.submit()).evidenceAttestation?.attestation.conclusion).toBe(2)
  const g = fixture()
  g.pending()
  const pending = await g.submit()
  expect(pending).toMatchObject({
    evidenceAttestation: null,
    evidenceUnavailable: 'checks are still running; ask again when they finish',
  })
  expect(pending.transactions).toHaveLength(1)
  const absent = await fixture(false).submit()
  expect(absent.evidenceAttestation).toBeNull()
  expect(absent.transactions).toHaveLength(1)
})
it('evidence is bound to the requested candidate even when another deliverable is newer', async () => {
  const f = fixture(),
    first = await f.submit()
  await f.submit({ ...delivery, sha: 'b'.repeat(40) })
  const exact = await f.board.requestEvidence(
    { address: f.worker.address },
    { taskId: 'task', submissionHash: first.deliverableHash },
  )
  expect(exact.evidenceAttestation.attestation.submissionHash).toBe(first.deliverableHash)
})

function evidenceReceipt(ctx: sdk.Ctx, signed: sdk.SignedEvidenceAttestation, digest: Hex): TransactionReceipt {
  // SAFETY: canonical receipt metadata and exact ABI-encoded event fields are sufficient for this observation test.
  return {
    status: 'success',
    transactionHash: sdk.hashText('evidence receipt'),
    blockNumber: 100n,
    from: signed.verifier,
    logs: [
      {
        address: ctx.stack.evaluator,
        logIndex: 0,
        topics: encodeEventTopics({
          abi: sdk.sidequestEvaluatorAbi,
          eventName: 'EvidenceAttached',
          args: { jobId: 42n, verifier: signed.verifier },
        }),
        data: encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'bytes32' },
            { type: 'bytes32' },
            { type: 'bytes32' },
            { type: 'uint8' },
            { type: 'uint64' },
          ],
          [
            digest,
            signed.attestation.submissionHash,
            signed.attestation.policyHash,
            signed.attestation.testedSha,
            signed.attestation.conclusion,
            BigInt(signed.attestation.validUntil),
          ],
        ),
      },
    ],
  } as TransactionReceipt
}
it('receipt observation records a hash only for the configured evaluator and exact signed digest', async () => {
  const f = fixture(),
    prepared = await f.submit(),
    signed = prepared.evidenceAttestation!
  const digest = hashTypedData({
    domain: sdk.evaluatorDomain(f.ctx.deployment.chainId, f.ctx.stack.evaluator),
    types: sdk.evidenceTypes,
    primaryType: 'EvidenceAttestation',
    message: { ...signed.attestation, jobId: 42n, validUntil: BigInt(signed.attestation.validUntil) },
  })
  // Stop after receipt observation so this test does not exercise the unrelated enriched task read.
  vi.spyOn(f.board, 'getTask').mockRejectedValue(new Error('observation complete'))
  const correct = evidenceReceipt(f.ctx, signed, digest)
  for (const receipt of [
    evidenceReceipt(f.ctx, signed, sdk.EMPTY_HASH),
    { ...correct, status: 'reverted' as const },
    { ...correct, logs: correct.logs.map((log) => ({ ...log, address: f.worker.address })) },
  ]) {
    vi.mocked(f.ctx.publicClient.getTransactionReceipt).mockResolvedValueOnce(receipt)
    await expect(
      f.board.reportTransaction({ address: f.worker.address }, { taskId: 'task', txHash: correct.transactionHash }),
    ).rejects.toThrow('observation complete')
    expect(f.db.prepare('SELECT tx_hash FROM evidence').get()).toEqual({ tx_hash: '' })
  }
  vi.mocked(f.ctx.publicClient.getTransactionReceipt).mockResolvedValueOnce(correct)
  await expect(
    f.board.reportTransaction({ address: f.worker.address }, { taskId: 'task', txHash: correct.transactionHash }),
  ).rejects.toThrow('observation complete')
  expect(f.db.prepare('SELECT tx_hash FROM evidence').get()).toEqual({ tx_hash: correct.transactionHash })
})
