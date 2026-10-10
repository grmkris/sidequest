import { createPublicClient, http, parseAbi, parseAbiItem, type Address, type Hex, type PublicClient } from './viem.ts'
import { hypersync, type HyperSyncNetwork, type LogSource } from './hypersync.ts'
import type { FeeCharged, OwedWithdrawn, PayoutOwed } from './compute.ts'
import type { TopUp } from './contributors.ts'
import { cumulativeBudget as scheduledBudget, replayLots, type EpochFunding } from './lots.ts'

export const holdingEvents = [
  parseAbiItem(
    'event FeeCharged(uint256 indexed jobId, address indexed token, address indexed worker, address creator, uint256 amount, uint256 bonusPart)',
  ),
  parseAbiItem('event PayoutOwed(uint256 indexed jobId, address indexed to, address indexed token, uint256 amount)'),
  parseAbiItem('event OwedWithdrawn(address indexed to, address indexed token, uint256 amount)'),
] as const
const toppedUp = parseAbiItem(
  'event ToppedUp(uint256 indexed jobId, address indexed contributor, uint256 amount, uint256 bonus)',
)
const epochFunded = parseAbiItem('event EpochFunded(uint256 indexed epoch, uint256 amount, uint256 totalFunded)')

export const reserveAbi = parseAbi([
  'function epochStart(uint256 epoch) view returns (uint256)',
  'function epochEnd(uint256 epoch) view returns (uint256)',
  'function cumulativeBudget(uint256 epoch) view returns (uint256)',
  'function totalFunded() view returns (uint256)',
  'function fund(uint256 epoch, uint256 amount)',
])
export const distributorAbi = parseAbi([
  'function setRoot(uint256 epoch, bytes32 root, uint256 total, bytes32 dataHash)',
])
const safeAbi = parseAbi(['function getOwners() view returns (address[])'])
const erc20Abi = parseAbi(['function decimals() view returns (uint8)'])

export interface ClientOptions {
  logs?: LogSource
  network?: HyperSyncNetwork
}
export const logClient = (rpc: string, opts: ClientOptions = {}): PublicClient =>
  createPublicClient({
    transport: opts.logs === 'hypersync' ? hypersync(rpc, opts.network) : http(rpc, { retryCount: 0, timeout: 30_000 }),
  })

/** General reads retain transport retries; the pager owns retries for the dedicated getLogs transport. */
export const client = (rpc: string, opts: ClientOptions = {}): PublicClient =>
  createPublicClient({ transport: http(rpc, { retryCount: 3, timeout: 30_000 }) }).extend(() => ({
    getLogs: logClient(rpc, opts).getLogs,
  })) as PublicClient

/** Pure contract clock reads: the reserve defines both boundaries, including fast testnet clocks. */
export async function epochWindowOf(c: PublicClient, reserve: Address, epoch: bigint) {
  const [start, end] = await Promise.all([
    c.readContract({ address: reserve, abi: reserveAbi, functionName: 'epochStart', args: [epoch] }),
    c.readContract({ address: reserve, abi: reserveAbi, functionName: 'epochEnd', args: [epoch] }),
  ])
  if (start < 0n || end <= start) throw new Error('invalid deployed mining epoch window')
  return { start, end }
}

/** The first block in [lo, hi] whose timestamp is at least `t`, or hi + 1 if none is. */
export async function firstBlockAtOrAfter(c: PublicClient, t: bigint, lo: bigint, hi: bigint): Promise<bigint> {
  let [left, right] = [lo, hi + 1n]
  while (left < right) {
    const mid = (left + right) / 2n
    const block = await c.getBlock({ blockNumber: mid })
    if (block.timestamp >= t) right = mid
    else left = mid + 1n
  }
  return left
}

export interface LogPager {
  page: bigint
  logs?: LogSource
}

const isErrorRecord = (
  value: unknown,
): value is { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown; cause?: unknown } =>
  typeof value === 'object' && value !== null
const isString = (value: unknown): value is string => typeof value === 'string'
const isBigint = (value: bigint | LogPager): value is bigint => typeof value === 'bigint'

/** viem wraps JSON-RPC and HTTP errors; keep walking causes without exposing provider bodies. */
export function isRangeError(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current = error
  while (isErrorRecord(current) && !seen.has(current)) {
    seen.add(current)
    if (
      current.code === -32005 ||
      current.code === -32602 ||
      current.code === -32614 ||
      current.status === 413 ||
      current.statusCode === 413
    )
      return true
    if (isString(current.message) && /range|limit|too many|exceed|max.*block/i.test(current.message)) return true
    current = current.cause
  }
  return false
}

async function logsWithRetry<T>(
  fetch: (from: bigint, to: bigint) => Promise<T[]>,
  from: bigint,
  to: bigint,
): Promise<T[]> {
  for (let retries = 0; ; retries++) {
    try {
      return await fetch(from, to)
    } catch (error) {
      if (isRangeError(error) || retries === 3) throw error
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** retries))
    }
  }
}

async function rpcPages<T>(
  from: bigint,
  to: bigint,
  pager: LogPager,
  fetch: (from: bigint, to: bigint) => Promise<T[]>,
) {
  const out: T[] = []
  for (let start = from; start <= to;) {
    const page = pager.page
    const end = start + page - 1n < to ? start + page - 1n : to
    try {
      out.push(...(await logsWithRetry(fetch, start, end)))
      start = end + 1n
    } catch (error) {
      if (!isRangeError(error) || page === 1n) throw error
      const smaller = page / 2n
      if (smaller < pager.page) pager.page = smaller
    }
  }
  return out
}

/** Shared RPC page sizes only shrink; HyperSync owns its complete range and retries. */
export async function pagedLogs<T>(
  from: bigint,
  to: bigint,
  pageSize: bigint | LogPager,
  fetch: (from: bigint, to: bigint) => Promise<T[]>,
): Promise<T[]> {
  const pager = isBigint(pageSize) ? { page: pageSize } : pageSize
  if (pager.page < 1n) throw new Error('the page size must be at least one block')
  if (from > to) return []
  return pager.logs === 'hypersync' ? fetch(from, to) : rpcPages(from, to, pager, fetch)
}

const lower = (a: string) => a.toLowerCase() as Address
const chainOrder = (x: { block: bigint; logIndex: number }, y: { block: bigint; logIndex: number }) =>
  x.block === y.block ? x.logIndex - y.logIndex : x.block < y.block ? -1 : 1

export async function holdingLogs(
  c: PublicClient,
  holdings: Address[],
  from: bigint,
  to: bigint,
  page: bigint | LogPager,
) {
  const logs = await pagedLogs(from, to, page, (fromBlock, toBlock) =>
    c.getLogs({ address: holdings, events: holdingEvents, fromBlock, toBlock, strict: true }),
  )
  const fees: FeeCharged[] = []
  const owed: PayoutOwed[] = []
  const withdrawals: OwedWithdrawn[] = []
  for (const log of logs) {
    const at = {
      block: log.blockNumber,
      logIndex: log.logIndex,
      tx: log.transactionHash as Hex,
      holding: lower(log.address),
    }
    if (log.eventName === 'FeeCharged') {
      fees.push({
        ...at,
        jobId: log.args.jobId,
        token: lower(log.args.token),
        worker: lower(log.args.worker),
        creator: lower(log.args.creator),
        amount: log.args.amount,
        bonusPart: log.args.bonusPart,
      })
    } else if (log.eventName === 'PayoutOwed') {
      owed.push({
        ...at,
        jobId: log.args.jobId,
        to: lower(log.args.to),
        token: lower(log.args.token),
        amount: log.args.amount,
      })
    } else {
      withdrawals.push({ ...at, to: lower(log.args.to), token: lower(log.args.token), amount: log.args.amount })
    }
  }
  return {
    fees: fees.toSorted(chainOrder),
    owed: owed.toSorted(chainOrder),
    withdrawals: withdrawals.toSorted(chainOrder),
  }
}

/** Top-ups may precede this epoch. Read each paid job's full contribution history, not only the fee window. */
export async function topUpLogs(
  c: PublicClient,
  fees: readonly FeeCharged[],
  deployBlock: bigint,
  toBlock: bigint,
  page: bigint | LogPager,
): Promise<TopUp[]> {
  const jobs = new Map<Address, bigint[]>()
  for (const fee of fees) {
    if (fee.bonusPart === 0n) continue
    const ids = jobs.get(fee.holding) ?? []
    if (!ids.includes(fee.jobId)) ids.push(fee.jobId)
    jobs.set(fee.holding, ids)
  }
  const topUps: TopUp[] = []
  for (const [holding, jobIds] of jobs) {
    const logs = await pagedLogs(deployBlock, toBlock, page, (fromBlock, endBlock) =>
      c.getLogs({
        address: holding,
        event: toppedUp,
        args: { jobId: jobIds },
        fromBlock,
        toBlock: endBlock,
        strict: true,
      }),
    )
    for (const log of logs) {
      topUps.push({
        holding,
        block: log.blockNumber,
        logIndex: log.logIndex,
        tx: log.transactionHash,
        jobId: log.args.jobId,
        contributor: lower(log.args.contributor),
        amount: log.args.amount,
        bonus: log.args.bonus,
      })
    }
  }
  return topUps.toSorted(chainOrder)
}

/**
 * Replay four-epoch lots from EpochFunded logs, and report what epoch n already has, all
 * at the finalized `head`. `fund` adds to what is there, so a funding transaction that is mined but not yet final would
 * otherwise be missed and funded twice (B8-SEC-004): refuse until `totalFunded` agrees at latest and at `head`, and
 * until the logs add up to it.
 */
export async function budgetOf(
  c: PublicClient,
  reserve: Address,
  epoch: bigint,
  deployBlock: bigint,
  head: bigint,
  page: bigint | LogPager,
) {
  const cumulativeBudget = await c.readContract({
    address: reserve,
    abi: reserveAbi,
    functionName: 'cumulativeBudget',
    args: [epoch],
  })
  if (cumulativeBudget !== scheduledBudget(epoch)) throw new Error('deployed mining schedule differs from note 17')
  const totalFunded = await c.readContract({
    address: reserve,
    abi: reserveAbi,
    functionName: 'totalFunded',
    blockNumber: head,
  })
  const totalFundedLatest = await c.readContract({ address: reserve, abi: reserveAbi, functionName: 'totalFunded' })
  if (totalFundedLatest !== totalFunded)
    throw new Error('a MiningReserve funding transaction is not final yet; wait for finality and run again')
  const funding: EpochFunding[] = []
  if (totalFunded > 0n) {
    let sum = 0n
    const logs = await pagedLogs(deployBlock, head, page, (fromBlock, toBlock) =>
      c.getLogs({ address: reserve, event: epochFunded, fromBlock, toBlock, strict: true }),
    )
    for (const log of logs) {
      sum += log.args.amount
      funding.push({ epoch: log.args.epoch, amount: log.args.amount })
    }
    if (sum !== totalFunded)
      throw new Error(`the EpochFunded logs add up to ${sum}, but totalFunded() is ${totalFunded} at block ${head}`)
  }
  const replay = replayLots(epoch, funding)
  return { cumulativeBudget, totalFunded, ...replay }
}

export async function safeOwners(c: PublicClient, safe: Address): Promise<Address[]> {
  return (await c.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' })).map(lower)
}

export async function decimalsOf(c: PublicClient, token: Address): Promise<number> {
  return await c.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })
}
