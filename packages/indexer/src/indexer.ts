/**
 * One indexing run (spec §5 `apps/indexer`, plan S4): under a lease, read finalized logs of the core, every Holding
 * and every evaluator from the checkpoint, decode them, and commit in ONE batch per page: the new events, every
 * affected job re-folded from all its events, and the advanced checkpoint. A crash before the batch changes
 * nothing; a crash after it is a completed page. A replayed page inserts no event twice and folds to the same rows.
 *
 * Only finalized blocks are indexed (Monad answers the `finalized` tag), so a reorg should never reach D1; the
 * guard still compares the hash of the last indexed block with the chain and rewinds if they differ.
 */
import { type Contracts, type IndexedEvent, decode } from './events.ts'
import { hydrateForeignOffers, type OfferHydrationConfig } from './foreign-offers.ts'
import { byChainOrder, foldJob } from './fold.ts'
import type { ChainHead, LogSource } from './source.ts'
import { type AsyncSql, type Statement, DERIVED_TABLES, stmt } from './store.ts'

export interface IndexerConfig {
  readonly contracts: Contracts
  readonly deployBlock: number
  readonly source: LogSource
  readonly head: ChainHead
  readonly runner: string
  readonly now?: () => number
  /** Pages per run (each page is one atomic batch). */
  readonly maxPages?: number
  readonly leaseSeconds?: number
  /** How far to rewind when the last indexed block's hash no longer matches the chain. */
  readonly rewindBlocks?: number
  /** Event blocks without a stored time to look up per run (newest first), through `head.blockTimestamp`. */
  readonly backfillBlocks?: number
  /** Optional host discovery, run under this chain lease after folding finalized jobs. */
  readonly offers?: OfferHydrationConfig
}

export interface RunResult {
  readonly lease: boolean
  readonly pages: number
  readonly events: number
  readonly protocolEvents: number
  readonly jobs: number
  readonly nextBlock: number | null
  /** Every block finalized when this run began is indexed, so work that must not run on a stalled index may follow it. */
  readonly caughtUp: boolean
  readonly rewound: boolean
  /** Block times looked up for events indexed before block times were stored. */
  readonly backfilled: number
  readonly cutover: boolean
  /** A stale config acquired the lease but made no indexed-state writes. */
  readonly reason?: 'stale-generation'
}

interface EventRow {
  contract: string
  block: number
  log_index: number
  tx_hash: string
  job_id: string | null
  name: string
  args_json: string
}

const toEvent = (chainId: number, r: EventRow): IndexedEvent => ({
  chainId,
  contract: r.contract,
  block: r.block,
  logIndex: r.log_index,
  txHash: r.tx_hash,
  jobId: r.job_id,
  name: r.name,
  args: JSON.parse(r.args_json) as IndexedEvent['args'],
})

async function takeLease(sql: AsyncSql, cfg: IndexerConfig, now: number): Promise<boolean> {
  const id = `indexer:${cfg.contracts.chainId}`
  await sql.batch([
    stmt(
      `INSERT INTO lease (id, holder, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
       WHERE lease.expires_at <= ? OR lease.holder = excluded.holder`,
      id,
      cfg.runner,
      now + (cfg.leaseSeconds ?? 120),
      now,
    ),
  ])
  const [row] = await sql.all<{ holder: string }>('SELECT holder FROM lease WHERE id = ?', id)
  return row?.holder === cfg.runner
}

export async function releaseLease(sql: AsyncSql, cfg: IndexerConfig): Promise<void> {
  await sql.batch([
    stmt('DELETE FROM lease WHERE id = ? AND holder = ?', `indexer:${cfg.contracts.chainId}`, cfg.runner),
  ])
}

/** Abort the whole atomic batch if a slow RPC outlived this runner's lease. */
function leaseGuard(cfg: IndexerConfig): Statement {
  const now = (cfg.now ?? (() => Math.floor(Date.now() / 1000)))()
  // NULL violates lease.holder's NOT NULL constraint only when ownership has been lost.
  return stmt(
    `INSERT INTO lease (id, holder, expires_at) SELECT ?, NULL, 0
    WHERE NOT EXISTS (SELECT 1 FROM lease WHERE id = ? AND holder = ? AND expires_at > ?)`,
    `indexer:${cfg.contracts.chainId}`,
    `indexer:${cfg.contracts.chainId}`,
    cfg.runner,
    now,
  )
}

const eventKey = (e: IndexedEvent) => `${e.contract}:${e.block}:${e.logIndex}`

/** Re-folds `jobIds` from their stored events plus `fresh` (deduplicated by event identity). */
async function refold(
  sql: AsyncSql,
  cfg: IndexerConfig,
  jobIds: Iterable<string>,
  fresh: readonly IndexedEvent[],
): Promise<Statement[]> {
  const chainId = cfg.contracts.chainId
  const out: Statement[] = []
  for (const jobId of jobIds) {
    const stored = (
      await sql.all<EventRow>('SELECT * FROM events WHERE chain_id = ? AND job_id = ?', chainId, jobId)
    ).map((r) => toEvent(chainId, r))
    const all = new Map(stored.map((e) => [eventKey(e), e]))
    for (const e of fresh) if (e.jobId === jobId) all.set(eventKey(e), e)
    out.push(...foldJob(cfg.contracts, chainId, jobId, [...all.values()].toSorted(byChainOrder)))
  }
  return out
}

/** Drops everything from `block` on and re-folds the jobs it touched; the checkpoint moves back to `block`. */
async function rewindTo(sql: AsyncSql, cfg: IndexerConfig, block: number, now: number): Promise<void> {
  const chainId = cfg.contracts.chainId
  const touched = await sql.all<{ job_id: string }>(
    'SELECT DISTINCT job_id FROM events WHERE chain_id = ? AND block >= ?',
    chainId,
    block,
  )
  const deleteLater = stmt('DELETE FROM events WHERE chain_id = ? AND block >= ?', chainId, block)
  // Fold from the events that remain below `block`.
  const statements: Statement[] = []
  for (const { job_id } of touched) {
    const kept = (
      await sql.all<EventRow>(
        'SELECT * FROM events WHERE chain_id = ? AND job_id = ? AND block < ?',
        chainId,
        job_id,
        block,
      )
    ).map((r) => toEvent(chainId, r))
    statements.push(...foldJob(cfg.contracts, chainId, job_id, kept))
  }
  await sql.batch([
    leaseGuard(cfg),
    deleteLater,
    stmt('DELETE FROM protocol_events WHERE chain_id = ? AND block >= ?', chainId, block),
    ...statements,
    stmt(
      'INSERT OR REPLACE INTO checkpoint (chain_id, next_block, block_hash, core_address, deployment_block, updated_at) VALUES (?, ?, NULL, ?, ?, ?)',
      chainId,
      block,
      cfg.contracts.core,
      cfg.deployBlock,
      now,
    ),
  ])
}

/** Replaces one chain generation atomically. The checkpoint is written in the same batch as the wipe. */
async function cutover(sql: AsyncSql, cfg: IndexerConfig, now: number): Promise<void> {
  await resetIndex(sql, cfg, { coreAddress: cfg.contracts.core, deploymentBlock: cfg.deployBlock, now })
}

function idleRun(lease: boolean, nextBlock: number | null): RunResult {
  return {
    lease,
    pages: 0,
    events: 0,
    protocolEvents: 0,
    jobs: 0,
    nextBlock,
    caughtUp: false,
    rewound: false,
    backfilled: 0,
    cutover: false,
  }
}

export async function runOnce(sql: AsyncSql, cfg: IndexerConfig): Promise<RunResult> {
  const now = (cfg.now ?? (() => Math.floor(Date.now() / 1000)))()
  const chainId = cfg.contracts.chainId
  if (!(await takeLease(sql, cfg, now))) return idleRun(false, null)
  const addresses = [...cfg.contracts.roles.keys()]
  const { cp, didCutover, rewound, stale } = await deploymentCheckpoint(sql, cfg, now)
  if (stale) return { ...idleRun(true, cp?.next_block ?? null), reason: 'stale-generation' }
  let next = cp?.next_block ?? cfg.deployBlock
  const finalized = await cfg.head.finalizedBlock()
  let pages = 0
  let events = 0
  let protocolEvents = 0
  const jobs = new Set<string>()
  while (pages < (cfg.maxPages ?? 5) && next <= finalized) {
    const page = await cfg.source.logs({ fromBlock: next, toBlock: finalized + 1, addresses })
    const fresh = page.logs.map((l) => decode(cfg.contracts, l)).filter((e): e is IndexedEvent => e !== undefined)
    const pageJobs = new Set(fresh.flatMap((e) => (e.jobId === null ? [] : [e.jobId])))
    const upTo = Math.min(Math.max(page.nextBlock, next), finalized + 1)
    const hash = await cfg.head.blockHash(upTo - 1)
    const eventBlocks = new Set(fresh.map((e) => e.block))
    await sql.batch([
      leaseGuard(cfg),
      ...fresh.map(eventStatement),
      ...(page.blockTimes ?? [])
        .filter((b) => eventBlocks.has(b.block))
        .map((b) =>
          stmt(
            'INSERT OR IGNORE INTO block_times (chain_id, block, timestamp) VALUES (?, ?, ?)',
            chainId,
            b.block,
            b.timestamp,
          ),
        ),
      ...(await refold(sql, cfg, pageJobs, fresh)),
      stmt(
        'INSERT OR REPLACE INTO checkpoint (chain_id, next_block, block_hash, core_address, deployment_block, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        chainId,
        upTo,
        hash,
        cfg.contracts.core,
        cfg.deployBlock,
        now,
      ),
    ])
    pages++
    const jobEvents = fresh.filter((e) => e.jobId !== null).length
    events += jobEvents
    protocolEvents += fresh.length - jobEvents
    for (const j of pageJobs) jobs.add(j)
    if (upTo === next) break // no progress possible now
    next = upTo
  }
  if (cfg.offers !== undefined) await hydrateForeignOffers(sql, chainId, cfg.offers, now)
  const backfilled = await backfillBlockTimes(sql, cfg)
  return {
    lease: true,
    pages,
    events,
    protocolEvents,
    jobs: jobs.size,
    nextBlock: next,
    caughtUp: next > finalized,
    rewound,
    backfilled,
    cutover: didCutover,
  }
}

/** Looks up the times of a few event blocks that have none (indexed before block times were stored), newest first. */
async function backfillBlockTimes(sql: AsyncSql, cfg: IndexerConfig): Promise<number> {
  const lookup = cfg.head.blockTimestamp?.bind(cfg.head)
  if (lookup === undefined) return 0
  const chainId = cfg.contracts.chainId
  const missing = await sql.all<{ block: number }>(
    `SELECT DISTINCT e.block FROM (
       SELECT chain_id, block FROM events UNION ALL SELECT chain_id, block FROM protocol_events
     ) e WHERE e.chain_id = ?
     AND NOT EXISTS (SELECT 1 FROM block_times b WHERE b.chain_id = e.chain_id AND b.block = e.block)
     ORDER BY e.block DESC LIMIT ?`,
    chainId,
    cfg.backfillBlocks ?? 40,
  )
  const found = await Promise.all(missing.map(async ({ block }) => ({ block, timestamp: await lookup(block) })))
  const rows = found.filter((f): f is { block: number; timestamp: number } => f.timestamp !== null)
  await sql.batch(
    rows.map((r) =>
      stmt(
        'INSERT OR IGNORE INTO block_times (chain_id, block, timestamp) VALUES (?, ?, ?)',
        chainId,
        r.block,
        r.timestamp,
      ),
    ),
  )
  return rows.length
}

/** Full rebuild: chain facts only, from the deploy block (board records are not the indexer's). */
export async function resetIndex(
  sql: AsyncSql,
  cfg: IndexerConfig,
  generation?: { readonly coreAddress: string; readonly deploymentBlock: number; readonly now: number },
): Promise<void> {
  const chainId = cfg.contracts.chainId
  await sql.batch([
    ...(generation === undefined ? [] : [leaseGuard(cfg)]),
    ...DERIVED_TABLES.map((t) => stmt(`DELETE FROM ${t} WHERE chain_id = ?`, cfg.contracts.chainId)),
    stmt('DELETE FROM events WHERE chain_id = ?', cfg.contracts.chainId),
    stmt('DELETE FROM protocol_events WHERE chain_id = ?', cfg.contracts.chainId),
    stmt('DELETE FROM checkpoint WHERE chain_id = ?', chainId),
    ...(generation === undefined
      ? []
      : [
          stmt(
            'INSERT INTO checkpoint (chain_id, next_block, block_hash, core_address, deployment_block, updated_at) VALUES (?, ?, NULL, ?, ?, ?)',
            chainId,
            generation.deploymentBlock,
            generation.coreAddress,
            generation.deploymentBlock,
            generation.now,
          ),
        ]),
  ])
}

async function deploymentCheckpoint(sql: AsyncSql, cfg: IndexerConfig, now: number) {
  const chainId = cfg.contracts.chainId
  let [cp] = await sql.all<{
    next_block: number
    block_hash: string | null
    core_address: string | null
    deployment_block: number | null
  }>('SELECT next_block, block_hash, core_address, deployment_block FROM checkpoint WHERE chain_id = ?', chainId)
  // Generations only advance. Operator rollback requires deleting this chain's checkpoint row to start from config.
  if (
    cp !== undefined &&
    cp.deployment_block !== null &&
    (cfg.deployBlock < cp.deployment_block ||
      (cfg.deployBlock === cp.deployment_block &&
        cp.core_address !== null &&
        cp.core_address.toLowerCase() !== cfg.contracts.core.toLowerCase()))
  )
    return { cp, didCutover: false, rewound: false, stale: true }
  let didCutover = false
  if (
    cp !== undefined &&
    (cp.core_address === null ||
      cp.deployment_block === null ||
      cp.core_address.toLowerCase() !== cfg.contracts.core.toLowerCase() ||
      cp.deployment_block !== cfg.deployBlock)
  ) {
    await cutover(sql, cfg, now)
    didCutover = true
    ;[cp] = await sql.all<{
      next_block: number
      block_hash: string | null
      core_address: string | null
      deployment_block: number | null
    }>('SELECT next_block, block_hash, core_address, deployment_block FROM checkpoint WHERE chain_id = ?', chainId)
  }
  let rewound = false
  if (cp !== undefined && cp.block_hash !== null && cp.next_block > cfg.deployBlock) {
    const onChain = await cfg.head.blockHash(cp.next_block - 1)
    if (onChain !== null && onChain.toLowerCase() !== cp.block_hash.toLowerCase()) {
      await rewindTo(sql, cfg, Math.max(cfg.deployBlock, cp.next_block - (cfg.rewindBlocks ?? 100)), now)
      rewound = true
      ;[cp] = await sql.all<{
        next_block: number
        block_hash: string | null
        core_address: string | null
        deployment_block: number | null
      }>('SELECT next_block, block_hash, core_address, deployment_block FROM checkpoint WHERE chain_id = ?', chainId)
    }
  }
  return { cp, didCutover, rewound, stale: false }
}

function eventStatement(e: IndexedEvent): Statement {
  const common = [e.chainId, e.contract, e.block, e.logIndex, e.txHash]
  return e.jobId === null
    ? stmt(
        'INSERT OR IGNORE INTO protocol_events (chain_id, contract, block, log_index, tx_hash, name, args_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ...common,
        e.name,
        JSON.stringify(e.args),
      )
    : stmt(
        'INSERT OR IGNORE INTO events (chain_id, contract, block, log_index, tx_hash, job_id, name, args_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ...common,
        e.jobId,
        e.name,
        JSON.stringify(e.args),
      )
}
