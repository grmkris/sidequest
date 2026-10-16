/** Read-only wallet quantities and earnings. Wallet money and lifetime receipts are never added together. */
import { indexStatus, type AsyncSql } from '@sidequest/indexer'
import * as sdk from '@sidequest/sdk'
import { type Address, erc20Abi, formatUnits } from 'viem'

interface BalanceReceipt {
  token: string
  amount: string
  jobId: string | null
  txHash: string
  block: number
  kind: string
}
interface History {
  escrow: Record<string, string>
  pending: Record<string, string>
  paid: Record<string, string>
  uncertainPaid: string[]
  receipts: BalanceReceipt[]
  index: { next_block: number; updated_at: number } | null
}
interface BalanceJob {
  jobId: string
  token: string
  creator: string
  worker: string | null
  status: string
  settlement_outcome: string | null
  reward: string
  net: string | null
  bonus: string | null
  fee_bps: number | null
  outcome: string | null
}
const add = (totals: Record<string, string>, token: string, value: bigint) => {
  const key = token.toLowerCase()
  totals[key] = (BigInt(totals[key] ?? '0') + value).toString()
}

function workerMayEarn(job: BalanceJob): boolean {
  return (
    ['Accepted', 'Silence', 'RuledForWorker'].includes(job.outcome ?? '') ||
    ((job.outcome === null || job.outcome === 'None') &&
      ['active', 'submitted', 'rejected-pending', 'disputed', 'completed'].includes(job.status))
  )
}

function releasedByJob(receipts: BalanceReceipt[]) {
  const paidByJob: Record<string, string> = {}
  for (const receipt of receipts)
    if (receipt.kind === 'paid' && receipt.jobId !== null) add(paidByJob, receipt.jobId, BigInt(receipt.amount))
  return paidByJob
}

function jobAmounts(jobs: BalanceJob[], wallet: Address, receipts: BalanceReceipt[]) {
  const paidByJob = releasedByJob(receipts)
  const escrow: Record<string, string> = {}
  const pending: Record<string, string> = {}
  for (const job of jobs) {
    if (job.settlement_outcome !== null && job.settlement_outcome !== 'None') continue
    const bonus = BigInt(job.bonus ?? '0')
    const released = BigInt(paidByJob[job.jobId] ?? '0')
    if (job.creator.toLowerCase() === wallet.toLowerCase())
      add(escrow, job.token, BigInt(job.reward) + bonus - released)
    if (workerMayEarn(job) && job.worker?.toLowerCase() === wallet.toLowerCase() && job.net !== null)
      add(
        pending,
        job.token,
        BigInt(job.net) + bonus - (bonus * BigInt(job.fee_bps ?? 0) + 9_999n) / 10_000n - released,
      )
  }
  return { escrow, pending }
}

function applyWithdrawals(
  receipts: BalanceReceipt[],
  liabilities: Array<{ token: string; amount: string }>,
  withdrawals: Array<{ token: string; amount: string; txHash: string; block: number }>,
  paid: Record<string, string>,
): string[] {
  const workerOwed: Record<string, string> = {}
  const allOwed: Record<string, string> = {}
  for (const r of receipts) if (r.kind === 'owed') add(workerOwed, r.token, BigInt(r.amount))
  for (const r of liabilities) add(allOwed, r.token, BigInt(r.amount))
  const remaining = { ...workerOwed }
  const uncertainPaid = new Set<string>()
  for (const r of withdrawals) {
    const token = r.token.toLowerCase()
    receipts.push({ ...r, jobId: null, kind: 'withdrawn' })
    if (workerOwed[token] !== allOwed[token]) {
      if (workerOwed[token] !== undefined) uncertainPaid.add(token)
      continue
    }
    const amount =
      BigInt(r.amount) < BigInt(remaining[token] ?? '0') ? BigInt(r.amount) : BigInt(remaining[token] ?? '0')
    add(paid, token, amount)
    add(remaining, token, -amount)
  }
  return [...uncertainPaid]
}

/** All sums use bigint: SQLite numeric sums cannot represent 18-decimal token quantities safely. */
export async function balanceHistory(sql: AsyncSql, chainId: number, wallet: Address): Promise<History> {
  const jobs = await sql.all<BalanceJob>(
    "SELECT job_id AS jobId, token, creator, worker, status, settlement_outcome, reward, net, bonus, fee_bps, outcome FROM jobs WHERE chain_id=? AND kind='sidequest-v1' AND (lower(creator)=lower(?) OR lower(worker)=lower(?))",
    chainId,
    wallet,
    wallet,
  )
  const payments = await sql.all<BalanceReceipt & { recipient: string }>(
    `SELECT r.recipient, j.token, r.amount, r.job_id AS jobId, r.tx_hash AS txHash, r.block, r.kind
     FROM reward_outcomes r JOIN jobs j ON j.chain_id=r.chain_id AND j.job_id=r.job_id
     WHERE r.chain_id=? AND j.kind='sidequest-v1' AND (lower(j.worker)=lower(?) OR lower(j.creator)=lower(?)) AND lower(r.recipient)=lower(j.worker) AND r.kind IN ('paid','owed')
     ORDER BY r.block, r.log_index`,
    chainId,
    wallet,
    wallet,
  )
  const receipts: BalanceReceipt[] = payments.filter((r) => r.recipient.toLowerCase() === wallet.toLowerCase())
  const paid: Record<string, string> = {}
  for (const receipt of receipts) if (receipt.kind === 'paid') add(paid, receipt.token, BigInt(receipt.amount))
  const { escrow, pending } = jobAmounts(jobs, wallet, payments)
  // Withdrawals pool failed pushes. Count as earnings only when all indexed liabilities for that token are worker
  // rewards; mixed refund/fee liabilities cannot truthfully be allocated to jobs from a pooled withdrawal.
  const liabilities = await sql.all<{ token: string; amount: string }>(
    'SELECT token, amount FROM payout_owed WHERE chain_id=? AND lower(recipient)=lower(?)',
    chainId,
    wallet,
  )
  const withdrawals = await sql.all<{ token: string; amount: string; txHash: string; block: number }>(
    `SELECT json_extract(args_json,'$.token') AS token, json_extract(args_json,'$.amount') AS amount, tx_hash AS txHash, block
     FROM protocol_events WHERE chain_id=? AND name='OwedWithdrawn' AND lower(json_extract(args_json,'$.to'))=lower(?) ORDER BY block, log_index`,
    chainId,
    wallet,
  )
  const uncertainPaid = applyWithdrawals(receipts, liabilities, withdrawals, paid)
  return { escrow, pending, paid, uncertainPaid, receipts, index: await indexStatus(sql, chainId) }
}

interface BalancePrice {
  perUnit: number | null
  source: string | null
  observedAt: number | null
  /** Source block timestamp used for freshness; response observation remains separate. */
  sourceAt: number | null
}
const PRICE_MAX_AGE_SECONDS = 120

/** Missing and stale prices never manufacture a zero-dollar estimate, including for a zero token quantity. */
export function balanceUsd(
  raw: string | null,
  decimals: number | null,
  price: BalancePrice,
  now: number,
): number | null {
  if (
    raw === null ||
    decimals === null ||
    price.perUnit === null ||
    price.observedAt === null ||
    price.observedAt > now ||
    price.sourceAt === null ||
    price.sourceAt > now ||
    now - price.sourceAt > PRICE_MAX_AGE_SECONDS ||
    !Number.isFinite(price.perUnit) ||
    price.perUnit <= 0
  )
    return null
  const value = Number(formatUnits(BigInt(raw), decimals)) * price.perUnit
  return Number.isFinite(value) ? value : null
}
const unavailablePrice = (): BalancePrice => ({ perUnit: null, source: null, observedAt: null, sourceAt: null })

async function nativePrice(
  context: sdk.Ctx,
  decimals: ReadonlyMap<string, number | null>,
  pegged: ReadonlySet<string>,
  observedAt: number,
  sourceAt: number,
  blockNumber: bigint,
): Promise<BalancePrice> {
  const p = context.deployment.nativePrice
  if (p === null || !pegged.has(p.quote.toLowerCase())) return unavailablePrice()
  const quoteDecimals = decimals.get(p.quote.toLowerCase())
  if (quoteDecimals == null) return unavailablePrice()
  const value = await sdk.nativeUsdPrice(context, p, quoteDecimals, blockNumber).catch(() => null)
  return value === null
    ? unavailablePrice()
    : { perUnit: value, source: `Uniswap v4 pool ${p.poolId}`, observedAt, sourceAt }
}

async function prices(
  context: sdk.Ctx,
  decimals: ReadonlyMap<string, number | null>,
  observedAt: number,
  sourceAt: number,
  blockNumber: bigint,
) {
  const d = context.deployment
  const pegged = new Set(sdk.networkMeta(d.network).usdPegged.map((t) => t.toLowerCase()))
  const quotes = new Map<string, BalancePrice>()
  for (const token of pegged)
    quotes.set(token, { perUnit: 1, source: 'Configured USD peg (estimate)', observedAt, sourceAt })
  const native = await nativePrice(context, decimals, pegged, observedAt, sourceAt, blockNumber)
  quotes.set('native', native)
  const mon = native.perUnit
  const m = d.market
  const quoteDecimals = m === null ? null : decimals.get(m.quote.toLowerCase())
  let side: number | null = null
  let source: string | null = null
  if (m !== null && quoteDecimals != null && pegged.has(m.quote.toLowerCase())) {
    side = await sdk.sidePrice(context, m, quoteDecimals, blockNumber).catch(() => null)
    source = `Uniswap v4 pool ${m.poolId}`
  } else if (d.launcher !== null && mon !== null) {
    const out = await sdk.launcherQuote(context, d.launcher, 'sell', 10n ** 21n, blockNumber).catch(() => null)
    side = out === null ? null : (Number(formatUnits(out, 18)) / 1000) * mon
    source = 'nad.fun 1,000 SIDE sale quote × native USD pool price'
  }
  if (side !== null) quotes.set(d.factory.toLowerCase(), { perUnit: side, source, observedAt, sourceAt })
  return quotes
}

async function readCurrency(context: sdk.Ctx, wallet: Address, blockNumber: bigint, token: Address) {
  const [balance, decimals, symbol, owed] = await Promise.allSettled([
    context.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [wallet],
      blockNumber: blockNumber,
    }),
    context.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'decimals',
      blockNumber: blockNumber,
    }),
    context.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'symbol',
      blockNumber: blockNumber,
    }),
    context.publicClient.readContract({
      address: context.stack.holding,
      abi: sdk.sidequestHoldingAbi,
      functionName: 'owed',
      args: [token, wallet],
      blockNumber: blockNumber,
    }),
  ])
  return {
    token,
    symbol: symbol.status === 'fulfilled' ? symbol.value : null,
    decimals: decimals.status === 'fulfilled' ? decimals.value : null,
    wallet: balance.status === 'fulfilled' ? balance.value.toString() : null,
    owed: owed.status === 'fulfilled' ? owed.value.toString() : null,
  }
}

/** Called only after OAuth agent binding or SIWE ownership is established by the existing management boundary. */
export async function agentBalances(context: sdk.Ctx, sql: AsyncSql | undefined, wallet: Address) {
  const d = context.deployment
  const block = await context.publicClient.getBlock()
  const observedAt = Math.floor(Date.now() / 1000)
  const configured = [
    ...new Set(
      [
        ...d.rewardTokens,
        d.factory,
        ...(d.nativePrice === null ? [] : [d.nativePrice.quote]),
        ...(d.market === null ? [] : [d.market.quote]),
      ].map((t) => {
        // SAFETY: lowercasing a configured Address preserves its validated 20-byte hex encoding.
        return t.toLowerCase() as Address
      }),
    ),
  ]
  const tokens = await Promise.all(configured.map((token) => readCurrency(context, wallet, block.number, token)))
  const native = await context.publicClient.getBalance({ address: wallet, blockNumber: block.number }).catch(() => null)
  const metadata = sdk.chains[d.network].nativeCurrency
  const currencies = [
    ...tokens,
    {
      token: null,
      symbol: metadata.symbol,
      decimals: metadata.decimals,
      wallet: native?.toString() ?? null,
      owed: '0',
    },
  ]
  const sourceAt = Number(block.timestamp)
  const quotes = await prices(
    context,
    new Map(tokens.map((t) => [t.token, t.decimals])),
    observedAt,
    sourceAt,
    block.number,
  )
  const indexed = sql === undefined ? null : await balanceHistory(sql, d.chainId, wallet).catch(() => null)
  const history = indexed?.index == null ? null : indexed
  return {
    wallet,
    network: d.network,
    chainId: d.chainId,
    observedAt,
    blockNumber: block.number.toString(),
    blockTimestamp: Number(block.timestamp),
    index: history?.index ?? null,
    priceMaxAgeSeconds: PRICE_MAX_AGE_SECONDS,
    currencies: currencies.map((currency) => {
      const key = currency.token ?? 'native'
      const price = quotes.get(key) ?? unavailablePrice()
      const amounts = {
        wallet: currency.wallet,
        owed: currency.owed,
        escrow: history === null ? null : (history.escrow[key] ?? '0'),
        paid: history === null || history.uncertainPaid.includes(key) ? null : (history.paid[key] ?? '0'),
        pending: history === null ? null : (history.pending[key] ?? '0'),
      }
      return {
        ...currency,
        price,
        amounts,
        usd: Object.fromEntries(
          Object.entries(amounts).map(([kind, raw]) => [kind, balanceUsd(raw, currency.decimals, price, observedAt)]),
        ),
      }
    }),
    receipts: history?.receipts ?? null,
    notes: [
      'Wallet quantities alone are spendable; escrow, paid history, pending and owed are separate and are never added to wallet funds.',
      'Escrow is the remaining creator-funded gross amount still held until Holding settlement, including unpaid fees. Pending is unsettled worker net rewards, contingent on outcome. Owed is the live pooled Holding balance, which can include refunds.',
      'Paid earnings include direct worker payment receipts and attributable owed withdrawals. Mixed refund/earnings withdrawals remain separate receipts, without guessed job allocation.',
    ],
  }
}
