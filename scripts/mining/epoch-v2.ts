import type { LogSource } from './hypersync.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  deploymentFromConfig,
  networkMetaFromConfig,
  type DeploymentConfig,
  type Network,
} from '../../packages/sdk/src/deployment.ts'
import { stakeVaultAbi } from '../../packages/sdk/src/abi/stakeVault.ts'
import { agentWindowShare, walletShare } from '../../packages/sdk/src/backer-share-rule.ts'
import { decodeBackerShareBps } from './backers.ts'
import {
  client,
  logClient,
  decimalsOf,
  distributorAbi,
  epochWindowOf,
  firstBlockAtOrAfter,
  reserveAbi,
  safeOwners,
} from './chain.ts'
import { computeEpoch, dataHashOf, leafValues, type BackerPositionInput, type EpochResult } from './compute.ts'
import { computeEpochV2 } from './compute-v2.ts'
import { chainOrder } from './credit.ts'
import { MiningLedger, type MetadataSetRecord } from './ledger.ts'
import { readLedgerChain, isLedgerRecord, lower, type EpochChainRecord } from './ledger-chain.ts'
import {
  canonicalBudget,
  canonicalRuleV2,
  inputsV2Of,
  checkCanonicalPriceTokens,
  priceListOf,
  type WalletBackerShare,
} from './inputs-v2.ts'
import { checkIntegrity } from './integrity.ts'
import { fundingRemainder } from './lots.ts'
import { checkPriceRule, verifiedPriceList, type PriceListFile } from './prices.ts'
import { officialPoolOf, sampleOfficialPool } from './pool-chain.ts'
import { selectFactoryPrice } from './pool.ts'
import { creditRuleOf } from './rule.ts'
import {
  checkpointFlags,
  prepareCheckpointReplay,
  readStateContext,
  checkpointBudgetOf,
  initialBudgetOf,
  previousPriceOf,
  previousSignedPrice,
  type CheckpointPointer,
} from './checkpoint.ts'
import { buildTree, proofOf } from './tree.ts'
import { encodeFunctionData, type Address, type Hex } from './viem.ts'
import { epochDistributorAbi } from '../../packages/sdk/src/abi/epochDistributor.ts'
import { stateContractsOf, stateHashOf, stateOf } from './state.ts'

export { canonicalBudget, priceListOf } from './inputs-v2.ts'

export type MiningConfig = DeploymentConfig & { mining?: { officialPool?: unknown } }
export interface EpochOptions {
  epoch: bigint
  network: Network
  config: MiningConfig
  rpc: string
  page: bigint
  logs?: LogSource
  pricesFile: PriceListFile
  previousFile?: PriceListFile
  previousPath?: string
  recompute?: boolean
  checkpointDir?: string
  fromGenesis?: boolean
  checkpointPrevious?: CheckpointPointer | null
}
const s = (value: bigint | number) => value.toString()
/** Shared read-only window/price/budget work; v1 normal runs retain their verbatim implementation. */
export async function readEpochContext(options: EpochOptions) {
  const { epoch, network, config, rpc, page } = options
  const d = deploymentFromConfig(network, config)
  if (d.sidequest === null) throw new Error('config records no v1 deployment')
  const h = d.sidequest
  const holdings = [
    ...new Set(Object.values(d.stacks).flatMap((st) => (st?.kind === 'sidequest-v1' ? [lower(st.holding)] : []))),
  ].toSorted()
  const opts = { logs: options.logs ?? 'rpc', network }
  const c = client(rpc, opts),
    lc = logClient(rpc, opts)
  const chainId = await c.getChainId()
  if (chainId !== d.chainId) throw new Error(`the RPC is chain ${chainId}, the config is chain ${d.chainId}`)
  const owners = await safeOwners(c, h.safe)
  const signed = await verifiedPriceList(options.pricesFile, { epoch, chainId, distributor: h.distributor, owners })
  for (const token of signed.prices.tokens) {
    if ((await decimalsOf(c, token.token)) !== token.decimals)
      throw new Error(`price list decimals differ from chain for ${token.token}`)
  }
  const { start, end } = await epochWindowOf(c, h.miningReserve, epoch)
  const head = await c.getBlock({ blockTag: 'finalized' })
  if (head.timestamp < end) throw new Error(`epoch ${epoch} has not ended at the finalized head; wait for finality`)
  const fromBlock = await firstBlockAtOrAfter(c, start, h.block, head.number)
  const toBlock = (await firstBlockAtOrAfter(c, end, h.block, head.number)) - 1n
  const toBlockHash = (await c.getBlock({ blockNumber: toBlock })).hash
  if (toBlockHash === null) throw new Error('epoch end block has no hash')
  const evidence = await sampleOfficialPool({
    c,
    pool: officialPoolOf(config),
    factory: h.factory,
    prices: signed.prices,
    start,
    end,
    fromBlock,
    toBlock,
  })
  const samples = evidence.samples.flatMap((sample) =>
    sample.status === 'sampled' ? [BigInt(sample.factoryUsdPrice)] : [],
  )
  const previous = await previousPriceOf(options, { samples, chainId, distributor: h.distributor, owners })
  const selected = selectFactoryPrice(epoch, samples, previous?.prices.factoryUsdPrice)
  if (signed.prices.factoryUsdPrice !== selected.factoryUsdPrice)
    throw new Error('signed SIDE price differs from the conservative-high hourly rule')
  const pager = { page, logs: options.logs ?? 'rpc' }
  const budget = await initialBudgetOf({
    version: creditRuleOf(config, epoch).version,
    c,
    lc,
    reserve: h.miningReserve,
    epoch,
    deployBlock: h.block,
    head: head.number,
    pager,
    recompute: options.recompute ?? false,
  })
  return {
    ...options,
    d,
    h,
    c,
    lc,
    chainId,
    holdings,
    start,
    end,
    fromBlock,
    toBlock,
    head,
    pager,
    signed,
    prices: signed.prices,
    window: { start: s(start), end: s(end), fromBlock: s(fromBlock), toBlock: s(toBlock), toBlockHash },
    priceList: priceListOf(signed),
    factoryPriceEvidence: { ...evidence, source: selected.source, previousSignedPrice: previousSignedPrice(previous) },
    budget,
  }
}
export type EpochContext = Awaited<ReturnType<typeof readEpochContext>>
export function replayEpochLedger(
  records: readonly EpochChainRecord[],
  fromBlock: bigint,
  toBlock: bigint,
  initial?: MiningLedger,
) {
  const ledger = initial ?? new MiningLedger()
  const ordered = records.filter((record) => record.block <= toBlock).toSorted(chainOrder)
  for (const prior of ordered.filter((entry) => entry.block < fromBlock && isLedgerRecord(entry)))
    if (isLedgerRecord(prior)) ledger.apply(prior)
  const start = ledger.snapshot()
  for (const current of ordered.filter((entry) => entry.block >= fromBlock && isLedgerRecord(entry)))
    if (isLedgerRecord(current)) ledger.apply(current)
  const end = ledger.snapshot()
  const window = ordered.filter((record) => record.block >= fromBlock)
  const fees = window.filter((record) => record.eventName === 'FeeCharged')
  const owed = window.filter((record) => record.eventName === 'PayoutOwed')
  const withdrawals = window.filter((record) => record.eventName === 'OwedWithdrawn')
  return { ledger, start, end, fees, owed, withdrawals }
}
export type EpochReplay = ReturnType<typeof replayEpochLedger>

function windowShare(sets: readonly MetadataSetRecord[], windowStart: bigint, fromBlock: bigint) {
  const before = sets.filter((set) => set.block < fromBlock).toSorted(chainOrder)
  const bps = BigInt(
    agentWindowShare(
      before.map((set) => ({ position: set.block, value: set.value })),
      windowStart,
      fromBlock,
    ),
  )
  const eligible = [
    before.filter((set) => set.block < windowStart).at(-1),
    ...before.filter((set) => set.block >= windowStart),
  ].filter((set) => set !== undefined)
  const source = eligible.findLast((set) => decodeBackerShareBps(set.value) === bps) ?? null
  return { bps, source }
}

function weightedPositions(replay: EpochReplay, worker: Address): BackerPositionInput[] {
  return [...replay.end.positions]
    .filter(([, position]) => position.account === worker)
    .map(([key, position]) => {
      const previous = replay.start.positions.get(key)
      const start = previous?.generation === position.generation ? previous.active : 0n
      const end = position.active
      return { account: worker, delegator: position.delegator, start, end, weight: start < end ? start : end }
    })
}

/** IDs from earlier work plus counted activations in this epoch determine a wallet's maximum offered share. */
export function epochBackerWorkers(
  replay: EpochReplay,
  counted: readonly { worker: Address; holding: Address; jobId: bigint }[],
  shareBlock: bigint,
  fromBlock: bigint,
) {
  const shares: WalletBackerShare[] = []
  const workers = [...new Set(counted.map((fee) => fee.worker))].toSorted()
  for (const worker of workers) {
    const ids = new Set(replay.start.wallets.get(worker) ?? [])
    for (const countedFee of counted.filter((entry) => entry.worker === worker))
      ids.add(replay.ledger.activationOf(countedFee.holding, countedFee.jobId).agentId)
    const agentIds = [...ids].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const values = new Map(
      agentIds.map((id) => [id, windowShare(replay.end.shareSets.get(id) ?? [], shareBlock, fromBlock)]),
    )
    const bps = BigInt(walletShare(agentIds, (id) => Number(values.get(id)?.bps ?? 0n)))
    const sources = [...values.values()]
      .filter((value) => value.bps === bps)
      .flatMap((value) => (value.source === null ? [] : [value.source]))
      .toSorted(chainOrder)
    const source = sources.at(-1) ?? null
    shares.push({ worker, bps, agentIds, source })
  }
  return {
    shares,
    backerWorkers: shares.map((share) => ({
      worker: share.worker,
      agentId: share.agentIds[0] ?? 0n,
      bps: share.bps,
      positions: weightedPositions(replay, share.worker),
    })),
  }
}

export function computeLedgerEpoch(
  replay: EpochReplay,
  prices: EpochContext['prices'],
  budget: bigint,
  shareBlock: bigint,
  fromBlock: bigint,
) {
  const stakes = [...new Set(replay.fees.map((fee) => fee.worker))].map((worker) => ({
    worker,
    start: replay.start.stakes.get(worker) ?? 0n,
    end: replay.end.stakes.get(worker) ?? 0n,
  }))
  const topUps = replay.end.topUps.filter((topUp) =>
    replay.fees.some((fee) => fee.bonusPart > 0n && fee.holding === topUp.holding && fee.jobId === topUp.jobId),
  )
  const completeTopUps = topUps.map((topUp) => {
    if (topUp.tx === undefined) throw new Error('missing top-up transaction')
    return { ...topUp, tx: topUp.tx }
  })
  const activations = [...replay.end.activations.values()]
  const base = {
    fees: replay.fees,
    owed: replay.owed,
    withdrawals: replay.withdrawals,
    topUps: completeTopUps,
    prices,
    budget,
    activations,
    schedules: replay.end.feeSchedules,
    stakes,
  }
  const counted = computeEpoch({ ...base })
    .fees.filter((fee) => fee.status === 'counted')
    .map((record) => record.fee)
  const backers = epochBackerWorkers(replay, counted, shareBlock, fromBlock)
  const result = computeEpochV2({ ...base, backerWorkers: backers.backerWorkers })
  return {
    result,
    counted,
    topUps,
    stakes: stakes.filter((stake) => counted.some((fee) => fee.worker === stake.worker)),
    ...backers,
  }
}

/** Same tree, claims and Safe calldata format as v1, including the additive funding precondition. */
export function epochArtifact(context: EpochContext, result: EpochResult, inputs: unknown) {
  const { epoch, chainId, window, priceList, budget, h } = context
  const dataHash = dataHashOf(inputs)
  const tree = result.leaves.length === 0 ? null : buildTree(leafValues(epoch, result.leaves))
  const root = tree?.tree[0] ?? null
  const claims: Record<string, { amount: string; proof: Hex[] }> = {}
  const calls: Record<string, { to: Address; data: Hex; expect?: { totalFunded: string; fundedForEpoch: string } }> = {}
  const toFund = fundingRemainder(result.total, budget.fundedThis)
  if (tree !== null && root !== null) {
    tree.values.forEach((value, i) => {
      claims[value.value[1]] = { amount: value.value[2], proof: proofOf(tree, i) }
    })
    if (toFund > 0n)
      calls.fund = {
        to: lower(h.miningReserve),
        data: encodeFunctionData({ abi: reserveAbi, functionName: 'fund', args: [epoch, toFund] }),
        expect: { totalFunded: s(budget.totalFunded), fundedForEpoch: s(budget.fundedThis) },
      }
    calls.setRoot = {
      to: lower(h.distributor),
      data: encodeFunctionData({
        abi: distributorAbi,
        functionName: 'setRoot',
        args: [epoch, root, result.total, dataHash],
      }),
    }
  }
  return {
    chainId,
    epoch: s(epoch),
    window,
    priceList,
    budget: s(budget.available),
    feeUsd: s(result.feeUsd),
    factoryUsdPrice: s(result.factoryUsdPrice),
    demand: s(result.demand),
    emission: s(result.emission),
    total: s(result.total),
    root,
    dataHash,
    inputs,
    tree,
    claims,
    calls,
  }
}

async function replayV2(context: EpochContext, delay: bigint, rule: ReturnType<typeof canonicalRuleV2>) {
  const { c, lc, h, d, head, fromBlock, toBlock, pager } = context
  const historyStart = d.deployBlock < h.block ? d.deployBlock : h.block
  const chainInput = {
    c: lc,
    holdings: context.holdings,
    vault: h.vault,
    feeSchedule: h.feeSchedule,
    reserve: h.miningReserve,
    identity: d.identity,
    pager,
  }
  const contracts = {
    holdings: context.holdings,
    vault: h.vault,
    identity: d.identity,
    feeSchedule: h.feeSchedule,
    reserve: h.miningReserve,
    distributor: h.distributor,
  }
  const stateContext = (epoch: bigint) =>
    readStateContext({
      c,
      epoch,
      chainId: context.chainId,
      reserve: h.miningReserve,
      deploymentBlock: h.block,
      genesisBlock: historyStart,
      head: head.number,
      delay,
      contracts,
    })
  const prepared = await prepareCheckpointReplay({
    epoch: context.epoch,
    fromEpoch: BigInt(rule.fromEpoch),
    fromBlock,
    toBlock,
    genesisBlock: historyStart,
    chainId: context.chainId,
    rule,
    contracts: stateContractsOf(contracts),
    checkpointDir: context.checkpointDir ?? '.',
    ...(context.fromGenesis === undefined ? {} : { fromGenesis: context.fromGenesis }),
    ...(context.checkpointPrevious === undefined ? {} : { previous: context.checkpointPrevious }),
    reader: {
      readRoot: (epoch) =>
        c.readContract({
          address: h.distributor,
          abi: epochDistributorAbi,
          functionName: 'rootOf',
          args: [epoch],
          blockNumber: head.number,
        }),
      blockHash: async (blockNumber) => (await c.getBlock({ blockNumber })).hash,
    },
    stateContext,
    readRecords: (from, to) => readLedgerChain({ ...chainInput, fromBlock: from, toBlock: to }),
  })
  const replay = replayEpochLedger(prepared.records, fromBlock, toBlock, prepared.ledger)
  const state = stateOf(replay.ledger, await stateContext(context.epoch))
  if (state.block !== String(toBlock) || state.blockHash !== context.window.toBlockHash)
    throw new Error('epoch window changed during replay')
  const finalized = MiningLedger.fromSnapshot(replay.end)
  const continuation = await readLedgerChain({ ...chainInput, fromBlock: toBlock + 1n, toBlock: head.number })
  for (const record of continuation) if (isLedgerRecord(record)) finalized.apply(record)
  const budget = await checkpointBudgetOf({
    c,
    reserve: h.miningReserve,
    epoch: context.epoch,
    head: head.number,
    ledger: finalized,
    recompute: context.recompute ?? false,
  })
  return { replay, state, finalized, budget, previous: prepared.previous }
}
async function v2Delay(context: EpochContext) {
  const delay = BigInt(
    await context.c.readContract({
      address: context.h.vault,
      abi: stakeVaultAbi,
      functionName: 'UNSTAKE_DELAY',
      blockNumber: context.head.number,
    }),
  )
  const configured = context.config.deployment.sidequest?.clocks?.unstakeDelay
  if (configured === undefined || delay !== BigInt(configured))
    throw new Error('vault UNSTAKE_DELAY differs from configured clocks')
  return delay
}

export async function buildEpochV2WithState(context: EpochContext) {
  const { c, h, d, config, head, start, fromBlock } = context
  checkCanonicalPriceTokens(context.prices.tokens)
  if (context.factoryPriceEvidence.previousSignedPrice !== null)
    checkCanonicalPriceTokens(context.factoryPriceEvidence.previousSignedPrice.tokens)
  const selectedRule = creditRuleOf(config, context.epoch)
  if (selectedRule.version !== 2) throw new Error('v2 epoch precedes configured cutover')
  const delay = await v2Delay(context)
  const pegged = networkMetaFromConfig(config).usdPegged
  const rule = canonicalRuleV2(selectedRule.fromEpoch, delay, context.network === 'monad-mainnet', pegged)
  const shareStart = start > delay ? start - delay : 0n
  const shareBlock = await firstBlockAtOrAfter(c, shareStart, h.block, fromBlock)
  const { replay, state, finalized, budget, previous } = await replayV2(context, delay, rule)
  const computed = computeLedgerEpoch(replay, context.prices, budget.available, shareBlock, fromBlock)
  checkPriceRule(context.prices, {
    factory: h.factory,
    factoryUsdPrice: computed.result.factoryUsdPrice,
    network: context.network,
    usdPegged: pegged,
  })
  const inputs = inputsV2Of({
    chainId: context.chainId,
    epoch: context.epoch,
    rule,
    window: context.window,
    shareWindow: { start: s(shareStart), block: s(shareBlock) },
    holdings: context.holdings,
    priceList: context.priceList,
    factoryPriceEvidence: context.factoryPriceEvidence,
    budget: canonicalBudget(budget),
    feeSchedules: replay.end.feeSchedules,
    fees: computed.result.fees,
    topUps: computed.topUps,
    backing: computed.stakes,
    backerShares: computed.shares,
    backerPositions: computed.result.backerPositions,
    checkpoint: { previous, stateHash: stateHashOf(state) },
  })
  await checkIntegrity({
    c,
    deployment: d,
    sidequest: h,
    holdings: context.holdings,
    head: head.number,
    ledger: finalized,
    fees: computed.counted,
    workers: computed.shares.map((share) => share.worker),
    agentIds: [...new Set(computed.shares.flatMap((share) => share.agentIds))],
  })
  return {
    artifact: {
      ...epochArtifact({ ...context, budget }, computed.result, inputs),
      rule: 2,
      creditUsd: s(computed.result.creditUsd),
    },
    state,
  }
}

export async function buildEpochV2(context: EpochContext) {
  return (await buildEpochV2WithState(context)).artifact
}

export async function runEpochV2(options: EpochOptions, outDir: string) {
  const flags = checkpointFlags(process.argv.slice(2), outDir)
  const { artifact, state } = await buildEpochV2WithState(
    await readEpochContext({
      ...options,
      checkpointDir: options.checkpointDir ?? flags.checkpointDir,
      fromGenesis: options.fromGenesis ?? flags.fromGenesis,
    }),
  )
  mkdirSync(outDir, { recursive: true })
  const path = join(outDir, `epoch-${options.epoch}.json`)
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`)
  writeFileSync(join(outDir, `state-${options.epoch}.json`), `${JSON.stringify(state, null, 2)}\n`)
  console.log(
    `epoch ${options.epoch} rule 2: fee USD ${artifact.feeUsd}, credit USD ${artifact.creditUsd}, emission ${artifact.emission}, total ${artifact.total}`,
  )
  console.log(`root ${artifact.root ?? '(none)'}, dataHash ${artifact.dataHash}`)
  for (const [name, call] of Object.entries(artifact.calls))
    console.log(`Safe call ${name}: to ${call.to} data ${call.data}`)
  console.log(`wrote ${path}`)
}
