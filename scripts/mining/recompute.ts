import { Schema } from 'effect'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { budgetOf, pagedLogs, reserveAbi, holdingLogs, topUpLogs, type LogPager } from './chain.ts'
import { cumulativeBudget, replayLots, type EpochFunding } from './lots.ts'
import { fundedEvent, lower } from './ledger-chain.ts'
import { backerInputs } from './backers.ts'
import { readBackerWorkers } from './backers-chain.ts'
import {
  buildEpochV2WithState,
  canonicalBudget,
  epochArtifact,
  readEpochContext,
  type EpochContext,
  type EpochOptions,
} from './epoch-v2.ts'
import {
  computeEpoch,
  dataHashOf,
  leafValues,
  type BackerPositionInput,
  type BackerWorkerInput,
  type FeeCharged,
} from './compute.ts'
import { computeEpochV2 } from './compute-v2.ts'
import { parsePriceList, type PriceListFile } from './prices.ts'
import { buildTree, proofOf } from './tree.ts'
import { getAddress, type Address, type Hex, type PublicClient } from './viem.ts'
import { checkpointFlags, checkpointPointerOf } from './checkpoint.ts'

export function recomputeLots(epoch: bigint, funding: readonly EpochFunding[], totalFunded: bigint) {
  const sum = funding.reduce((total, event) => total + event.amount, 0n)
  if (sum !== totalFunded) throw new Error(`EpochFunded sum ${sum} differs from totalFunded ${totalFunded}`)
  return replayLots(
    epoch,
    funding.filter((event) => event.epoch <= epoch),
  )
}

/** Verify every funding log, but only replay lots through the epoch being checked. */
export async function recomputeBudgetOf(input: {
  c: PublicClient
  lc: PublicClient
  reserve: Address
  epoch: bigint
  deployBlock: bigint
  head: bigint
  pager: LogPager
}): Promise<Awaited<ReturnType<typeof budgetOf>>> {
  const { c, lc, reserve, epoch, deployBlock, head, pager } = input
  const scheduled = await c.readContract({
    address: reserve,
    abi: reserveAbi,
    functionName: 'cumulativeBudget',
    args: [epoch],
    blockNumber: head,
  })
  if (scheduled !== cumulativeBudget(epoch)) throw new Error('deployed mining schedule differs from note 17')
  const totalFunded = await c.readContract({
    address: reserve,
    abi: reserveAbi,
    functionName: 'totalFunded',
    blockNumber: head,
  })
  const latest = await c.readContract({ address: reserve, abi: reserveAbi, functionName: 'totalFunded' })
  if (latest !== totalFunded) throw new Error('reserve funding is not final yet')
  const logs = await pagedLogs(deployBlock, head, pager, (fromBlock, toBlock) =>
    lc.getLogs({ address: reserve, event: fundedEvent, fromBlock, toBlock, strict: true }),
  )
  const funding = logs.map((log) => ({ epoch: log.args.epoch, amount: log.args.amount }))
  return { cumulativeBudget: scheduled, totalFunded, ...recomputeLots(epoch, funding, totalFunded) }
}

const object = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))
const text = Schema.decodeUnknownSync(Schema.String)
const number = Schema.decodeUnknownSync(Schema.Number)
const array = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))
const uint = (value: unknown): bigint => {
  const result = text(value)
  if (!/^(0|[1-9][0-9]*)$/.test(result)) throw new Error('artifact decimal integer expected')
  return BigInt(result)
}
const index = (value: unknown): number => {
  const decoded = number(value)
  if (!Number.isSafeInteger(decoded) || decoded < 0) throw new Error('artifact index expected')
  return decoded
}
const address = (value: unknown): Address => lower(getAddress(text(value)))
const hex = (value: unknown): Hex => {
  const result = text(value)
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(result)) throw new Error('artifact hex expected')
  // SAFETY: Even-length hex was validated above.
  return result.toLowerCase() as Hex
}
const position = (value: Record<string, unknown>) => ({
  block: uint(value.block),
  logIndex: index(value.logIndex),
  tx: hex(value.tx),
})

function signedFileOf(value: unknown): PriceListFile {
  const file = object(value),
    message = object(file.message)
  return {
    message: {
      epoch: text(message.epoch),
      factoryUsdPrice: text(message.factoryUsdPrice),
      tokens: array(message.tokens).map((raw) => {
        const token = object(raw)
        return { token: text(token.token), decimals: index(token.decimals), usdPrice: text(token.usdPrice) }
      }),
    },
    signer: text(file.signer),
    signature: text(file.signature),
  }
}

/** Signed fallback inputs are self-contained; no external previous-epoch file is needed for recomputation. */
export function artifactPrices(artifact: unknown) {
  const file = object(artifact),
    inputs = object(file.inputs)
  const pricesFile = signedFileOf(inputs.priceList)
  const evidence = object(inputs.factoryPriceEvidence)
  if (evidence.previousSignedPrice === null) return { pricesFile }
  const previous = object(evidence.previousSignedPrice)
  // SAFETY: verifiedPriceList validates the reconstructed signed message and all its token fields.
  const previousFile: PriceListFile = {
    message: {
      epoch: text(previous.epoch),
      factoryUsdPrice: text(previous.factoryUsdPrice),
      tokens: array(previous.tokens).map((value) => {
        const token = object(value)
        return { token: text(token.token), decimals: index(token.decimals), usdPrice: text(token.usdPrice) }
      }),
    },
    signer: text(previous.signer),
    signature: text(previous.signature),
  }
  return { pricesFile, previousFile }
}

const feeOf = (value: unknown): FeeCharged => {
  const f = object(value)
  return {
    ...position(f),
    holding: address(f.holding),
    jobId: uint(f.jobId),
    token: address(f.token),
    worker: address(f.worker),
    creator: address(f.creator),
    amount: uint(f.amount),
    bonusPart: uint(f.bonusPart),
  }
}
const positionsOf = (inputs: Record<string, unknown>): BackerPositionInput[] =>
  array(inputs.backerPositions ?? []).map((value) => {
    const p = object(value)
    return {
      account: address(p.account),
      delegator: address(p.delegator),
      start: uint(p.start),
      end: uint(p.end),
      weight: uint(p.weight),
    }
  })
const backersOf = (inputs: Record<string, unknown>): BackerWorkerInput[] => {
  const positions = positionsOf(inputs)
  return array(inputs.backerShares ?? []).map((value) => {
    const share = object(value)
    const worker = address(share.worker)
    return {
      worker,
      agentId: uint(share.agentId ?? array(share.agentIds ?? ['0'])[0]),
      bps: uint(share.bps),
      positions: positions.filter((p) => p.account === worker),
    }
  })
}

function recordedV2(inputs: Record<string, unknown>, base: Parameters<typeof computeEpoch>[0]) {
  const counted = array(inputs.fees)
    .map((value) => object(value))
    .filter((fee) => fee.status === 'counted')
  const activations = counted.map((fee) => {
    const credit = object(fee.credit)
    return {
      ...position(object(credit.activation)),
      holding: address(fee.holding),
      jobId: uint(fee.jobId),
      worker: address(fee.worker),
      agentId: uint(credit.agentId),
      feeBps: uint(credit.feeBps),
      fee: uint(credit.fee),
      net: uint(credit.net),
    }
  })
  const schedules = array(inputs.feeSchedules).map((value) => {
    const schedule = object(value)
    return {
      ...position(schedule),
      thresholds: array(schedule.thresholds).map(uint),
      bps: array(schedule.bps).map(uint),
      treasury: address(schedule.treasury),
    }
  })
  const stakes = array(inputs.backing).map((value) => {
    const stake = object(value)
    return { worker: address(stake.worker), start: uint(stake.stakeStart), end: uint(stake.stakeEnd) }
  })
  return computeEpochV2({ ...base, activations, schedules, stakes })
}

/** Offline golden rebuild of recorded counted inputs; the CLI independently rereads the chain as well. */
export function rebuildRecorded(artifact: unknown) {
  const file = object(artifact),
    inputs = object(file.inputs),
    epoch = uint(file.epoch)
  const fees = array(inputs.fees)
    .map((value) => object(value))
    .filter((fee) => fee.status === 'counted')
    .map(feeOf)
  const topUps = array(inputs.topUps ?? []).map((value) => {
    const t = object(value)
    return {
      ...position(t),
      holding: address(t.holding),
      jobId: uint(t.jobId),
      contributor: address(t.contributor),
      amount: uint(t.amount),
      bonus: uint(t.bonus),
    }
  })
  const base = {
    fees,
    owed: [],
    withdrawals: [],
    topUps,
    prices: parsePriceList(artifactPrices(file).pricesFile),
    budget: uint(object(inputs.budget).available),
    backerWorkers: backersOf(inputs),
  }
  const result = file.rule === 2 ? recordedV2(inputs, base) : computeEpoch(base)
  const tree = result.leaves.length === 0 ? null : buildTree(leafValues(epoch, result.leaves))
  const claims: Record<string, { amount: string; proof: Hex[] }> = {}
  if (tree !== null)
    tree.values.forEach((value, i) => {
      claims[value.value[1]] = { amount: value.value[2], proof: proofOf(tree, i) }
    })
  return {
    inputs,
    dataHash: dataHashOf(inputs),
    tree,
    claims,
    root: tree?.tree[0] ?? null,
    total: result.total.toString(),
    result,
  }
}

async function rebuildV1(context: EpochContext) {
  const {
    lc,
    h,
    d,
    fromBlock,
    toBlock,
    epoch,
    prices,
    budget,
    chainId,
    window,
    holdings,
    priceList,
    factoryPriceEvidence,
  } = context
  const page = context.logs === 'hypersync' ? context.head.number + 1n : context.page
  const logs =
    fromBlock <= toBlock
      ? await holdingLogs(lc, holdings, fromBlock, toBlock, page)
      : { fees: [], owed: [], withdrawals: [] }
  const topUps = await topUpLogs(lc, logs.fees, d.deployBlock < h.block ? d.deployBlock : h.block, toBlock, page)
  const base = computeEpoch({ ...logs, topUps, prices, budget: budget.available })
  const backers = await readBackerWorkers({
    c: lc,
    identity: d.identity,
    vault: h.vault,
    holdings,
    fees: base.fees.filter((f) => f.status === 'counted').map((f) => f.fee),
    deploymentBlock: h.block,
    fromBlock,
    toBlock,
    page,
  })
  const result = computeEpoch({ ...logs, topUps, prices, budget: budget.available, backerWorkers: backers })
  const baseInputs = {
    chainId,
    epoch: epoch.toString(),
    window,
    holdings,
    priceList,
    factoryPriceEvidence,
    budget: canonicalBudget(budget),
    fees: result.fees.map(({ fee: f, status, usd }) => ({
      block: f.block.toString(),
      logIndex: f.logIndex,
      tx: f.tx.toLowerCase(),
      holding: f.holding,
      jobId: f.jobId.toString(),
      token: f.token,
      worker: f.worker,
      creator: f.creator,
      amount: f.amount.toString(),
      bonusPart: f.bonusPart.toString(),
      status,
      usd: usd.toString(),
    })),
    topUps: topUps.map((t) => ({
      ...t,
      block: t.block.toString(),
      jobId: t.jobId.toString(),
      amount: t.amount.toString(),
      bonus: t.bonus.toString(),
      tx: t.tx.toLowerCase(),
    })),
  }
  const additions = backerInputs(backers)
  return epochArtifact(context, result, additions === undefined ? baseInputs : { ...baseInputs, ...additions })
}

/** Compare the actual canonical bytes, including object key order and every proof/node. */
export function firstEpochDiff(expected: unknown, actual: unknown): string | null {
  const a = object(expected),
    b = object(actual)
  for (const field of ['inputs', 'dataHash', 'tree', 'claims', 'root', 'total']) {
    const left = JSON.stringify(a[field]),
      right = JSON.stringify(b[field])
    if (left === right) continue
    let offset = 0
    while (offset < Math.min(left?.length ?? 0, right?.length ?? 0) && left?.[offset] === right?.[offset]) offset++
    return `${field}: first byte difference at ${offset}`
  }
  return null
}

export async function runRecompute(path: string, options: Omit<EpochOptions, 'pricesFile' | 'previousFile'>) {
  const file: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (uint(object(file).epoch) !== options.epoch) throw new Error('--recompute artifact has the wrong epoch')
  const v2 = object(file).rule === 2
  const flags = checkpointFlags(process.argv.slice(2), dirname(path))
  const checkpointPrevious = v2 ? checkpointPointerOf(object(object(object(file).inputs).checkpoint).previous) : null
  const context = await readEpochContext({
    ...options,
    ...artifactPrices(file),
    recompute: true,
    checkpointDir: options.checkpointDir ?? flags.checkpointDir,
    fromGenesis: options.fromGenesis ?? flags.fromGenesis,
    ...(v2 ? { checkpointPrevious } : {}),
  })
  const rebuilt = object(file).rule === 2 ? (await buildEpochV2WithState(context)).artifact : await rebuildV1(context)
  const diff = firstEpochDiff(file, rebuilt)
  if (diff !== null) throw new Error(`FAIL ${diff}`)
  console.log(`PASS epoch ${options.epoch}: inputs, dataHash, tree and claims are byte-identical`)
}
