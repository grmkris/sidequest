import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { Board } from './service.ts'
import { fromNodeSqlite } from './store.ts'
import { canonicalJson, termsHash, type OfferTerms } from './terms.ts'

const creator = '0x1111111111111111111111111111111111111111' as const
const worker = '0x3333333333333333333333333333333333333333' as const
const stranger = '0x4444444444444444444444444444444444444444' as const
const REASON = 'The second criterion is not met: the page has no offline mode.'
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

/** A submitted job the approver rejected for Quality at 1600 (rejectedAt 0: never rejected), and its on-chain reason. */
function fixture(input: { rejectedAt?: number; onChainReason?: string } = {}) {
  const rejectedAt = input.rejectedAt ?? 1600
  const onChainReason = input.onChainReason ?? sdk.hashText(REASON)
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const terms: OfferTerms = {
    v: 2,
    mode: 'hire',
    taskId: 'job',
    projectId: null,
    policyVersion: null,
    title: 'Offline multiplayer',
    brief: 'Pair two phones without a server',
    acceptanceCriteria: ['Pairs over local Wi-Fi', 'Works offline'],
    deployment: {
      chainId: base.deployment.chainId,
      core: base.deployment.core,
      holding: base.stack.holding,
      evaluator: base.stack.evaluator,
      identity: base.deployment.identity,
    },
    creator,
    approver: creator,
    token: base.deployment.rewardTokens[0]!,
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
  const read = vi.fn(async ({ functionName }: { functionName: string }) => {
    switch (functionName) {
      case 'paused':
      case 'policyListed':
        return false
      case 'defaultArbitrator':
        return creator
      case 'getJob':
        return { provider: worker, status: 2, submittedAt: 1500, providerAgentId: 1n }
      case 'termsOf':
        return { ...terms, funded: 5n, reviewWindow: 120, disputeWindow: 120, arbitrationWindow: 300 }
      case 'getListing':
        return {
          ...terms,
          policyHash: termsHash(terms),
          feeBps: 0,
          fee: 0n,
          bonus: 0n,
          expiredAt: 4000,
          rewardSettled: false,
          creatorBondSettled: false,
          workerBondReserved: false,
        }
      case 'caseOf':
        return { outcome: 0, rejectedAt, disputedAt: 0, violation: 1 }
      case 'rejectionReasonOf':
        return onChainReason
      default:
        throw new Error(`unexpected chain read: ${functionName}`)
    }
  })
  // SAFETY: the fake RPC answers exactly the chain reads get_task makes for this job.
  const ctx = { ...base, publicClient: { ...base.publicClient, readContract: read } } as sdk.Ctx
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  const board = new Board(sql, {
    network: 'monad-testnet',
    contexts: { main: ctx },
    domain: 'rejection.test',
    uri: 'https://rejection.test',
    manifestBaseUrl: 'https://rejection.test/offers',
    now: () => 1700,
  })
  sql.run(
    'INSERT INTO tasks (id,creator,stack,terms_json,terms_hash,job_id,from_block,created_at) VALUES (?,?,?,?,?,?,?,?)',
    'job',
    creator,
    'main',
    canonicalJson(terms),
    termsHash(terms),
    '71',
    0,
    1,
  )
  sql.run(
    'INSERT INTO reasons (hash, task_id, text, created_at) VALUES (?, ?, ?, ?)',
    sdk.hashText(REASON),
    'job',
    REASON,
    1600,
  )
  return { board, read }
}

it("shows the approver's published reason to the job's parties while the rejection can be disputed (dev gap 17)", async () => {
  const f = fixture()
  expect((await f.board.getTask({ address: worker }, { taskId: 'job' })).chain.status).toBe('rejected-pending')
  const rejection = { violation: 'Quality', reasonHash: sdk.hashText(REASON), reasonText: REASON }
  expect(await f.board.getTask({ address: worker }, { taskId: 'job' })).toMatchObject({ rejection })
  expect(await f.board.getTask({ address: creator }, { taskId: 'job' })).toMatchObject({ rejection })
  // Anyone else, signed in or not, sees the violation in chain and never the text.
  for (const caller of [{ address: stranger }, {}]) {
    const task = await f.board.getTask(caller, { taskId: 'job' })
    expect(task).not.toHaveProperty('rejection')
    expect(task.chain.violation).toBe('Quality')
  }
})

it('counts only text whose hash is the on-chain reason, and reads nothing for a job never rejected', async () => {
  const other = fixture({ onChainReason: sdk.hashText('A different reason the board never stored') })
  expect(await other.board.getTask({ address: worker }, { taskId: 'job' })).toMatchObject({
    rejection: { violation: 'Quality', reasonText: null },
  })
  const f = fixture({ rejectedAt: 0 })
  expect(await f.board.getTask({ address: worker }, { taskId: 'job' })).not.toHaveProperty('rejection')
  expect(f.read.mock.calls.map(([call]) => call.functionName)).not.toContain('rejectionReasonOf')
})
