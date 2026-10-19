import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { type Address } from 'viem'
import { afterEach, expect, it, vi } from 'vitest'
import { Board } from './service.ts'
import { fromNodeSqlite } from './store.ts'
import { canonicalJson, termsHash, type OfferTerms } from './terms.ts'

const creator = '0x1111111111111111111111111111111111111111' as const
const retired = '0x2222222222222222222222222222222222222222' as const
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixture() {
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const read = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'policyListed' || functionName === 'paused') return false
    if (functionName === 'defaultArbitrator') return creator
    throw new Error(`unexpected chain read: ${functionName}`)
  })
  const ctx = { ...base, publicClient: { ...base.publicClient, readContract: read } } as unknown as sdk.Ctx
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  const boot = () =>
    new Board(sql, {
      network: 'monad-testnet',
      contexts: { main: ctx },
      domain: 'archive.test',
      uri: 'https://archive.test',
      manifestBaseUrl: 'https://archive.test/offers',
      now: () => 1000,
    })
  const board = boot()
  const add = (taskId: string, holding: Address, createdAt: number, jobId: string | null = null) => {
    const terms: OfferTerms = {
      v: 2,
      mode: 'hire',
      taskId,
      projectId: null,
      policyVersion: null,
      title: taskId,
      brief: 'Historical record',
      acceptanceCriteria: [],
      deployment: {
        chainId: ctx.deployment.chainId,
        core: ctx.deployment.core,
        holding,
        evaluator: ctx.stack.evaluator,
        identity: ctx.deployment.identity,
      },
      creator,
      approver: creator,
      token: ctx.deployment.rewardTokens[0]!,
      reward: 5n,
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
      taskId,
      creator,
      'main',
      canonicalJson(terms),
      termsHash(terms),
      jobId,
      0,
      createdAt,
    )
  }
  add('current', ctx.stack.holding, 1)
  add('archived', retired, 3, '62')
  add('archived-unpublished', retired, 4)
  sql.run(
    'INSERT INTO operations (id,task_id,kind,actor,status,tx_hash,detail,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'old-operation',
    'archived',
    'submit',
    creator,
    'confirmed',
    sdk.EMPTY_HASH,
    null,
    0,
    0,
  )
  sql.run(
    'INSERT INTO evidence (id,task_id,submission_hash,verifier,conclusion,tested_sha,checks_json,tx_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    'old-evidence',
    'archived',
    sdk.EMPTY_HASH,
    creator,
    1,
    'sha',
    '[]',
    sdk.EMPTY_HASH,
    0,
  )
  return { board, boot, db, read, ctx }
}

it('excludes archived tasks before list limits while retaining the current pair', async () => {
  const f = fixture()
  expect(f.board.taskIndex({}).map((task) => [task.taskId, task.kind])).toEqual([['current', 'sidequest-v1']])
  expect((await f.board.listTasks({}, { limit: 1 })).map((task) => task.taskId)).toEqual(['current'])
  expect(await f.board.getTask({}, { taskId: 'current' })).toMatchObject({
    taskId: 'current',
    chain: { status: 'awaiting-publish' },
  })
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 3 })
})

it('direct archived reads and action preparations refuse before any RPC, including unpublished recovery', async () => {
  const f = fixture()
  for (const taskId of ['archived', 'archived-unpublished']) {
    await expect(f.board.getTask({ address: creator }, { taskId })).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('archived task'),
    })
    await expect(f.board.prepareActivation({ address: creator }, { taskId })).rejects.toMatchObject({
      code: 'unavailable',
    })
    await expect(f.board.listApplications({ address: creator }, { taskId })).rejects.toThrow('archived task')
  }
  expect(f.read).not.toHaveBeenCalled()
  f.boot()
  expect(f.db.prepare('SELECT status,tx_hash FROM operations WHERE id=?').get('old-operation')).toEqual({
    status: 'confirmed',
    tx_hash: sdk.EMPTY_HASH,
  })
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM evidence').get()).toEqual({ n: 1 })
})

it('archived disputes neither break discovery nor borrow the new main arbitrator', async () => {
  const f = fixture()
  expect(await f.board.listDisputes({ address: creator })).toEqual([])
  expect(f.read.mock.calls).toHaveLength(1)
  expect(f.read).toHaveBeenCalledWith(
    expect.objectContaining({ address: f.ctx.stack.holding, functionName: 'defaultArbitrator' }),
  )
})
