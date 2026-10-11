import { Schema } from 'effect'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deploymentFromConfig, type SidequestDeployment } from '../../packages/sdk/src/deployment.ts'
import { epochDistributorAbi } from '../../packages/sdk/src/abi/epochDistributor.ts'
import { client, logClient, reserveAbi } from './chain.ts'
import { findAnchor } from './checkpoint.ts'
import {
  buildEpochV2WithState,
  epochBytes,
  readEpochContext,
  stateBytes,
  type EpochOptions,
  type MiningConfig,
} from './epoch-v2.ts'
import { fundedEvent } from './ledger-chain.ts'
import {
  pipelineInventory,
  planPipeline,
  type PendingEpoch,
  type PipelineEntry,
  type PipelineRead,
  type PipelineRow,
} from './pipeline-lib.ts'
import {
  CloudflareManifests,
  MiningPublishError,
  publishEpoch,
  stageOf,
  type EpochReader,
  type ManifestsIndex,
  type ManifestsStore,
  type PublishTarget,
} from './publish-lib.ts'
import { type PriceListFile } from './prices.ts'
import { creditRuleOf } from './rule.ts'
import { type Hex, type PublicClient } from './viem.ts'

type PipelineCode =
  | 'usage'
  | 'pipeline-off'
  | 'artifact-invalid'
  | 'config-unavailable'
  | 'chain-unavailable'
  | 'compute-refused'
export class MiningPipelineError extends Error {
  constructor(readonly code: PipelineCode) {
    super(code === 'pipeline-off' ? 'pipeline-off: prod mining stays manual until Kris enables it' : code)
  }
}
export function pipelineArgs(argv: readonly string[]) {
  let stage: string | undefined,
    dryRun = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run' && !dryRun) dryRun = true
    else if (argv[i] === '--stage' && stage === undefined) stage = argv[++i]
    else throw new MiningPipelineError('usage')
  }
  if (stage === 'prod') throw new MiningPipelineError('pipeline-off')
  if (stage !== 'dev') throw new MiningPipelineError('usage')
  return { stage, dryRun }
}
const uint = Schema.String.check(Schema.isPattern(/^(0|[1-9]\d*)$/))
const hexHash = Schema.String.check(Schema.isPattern(/^0x[\da-fA-F]{64}$/))
const signedPrices = Schema.Struct({
  domain: Schema.optional(Schema.Unknown),
  message: Schema.Struct({
    epoch: uint,
    tokens: Schema.Array(Schema.Struct({ token: Schema.String, decimals: Schema.Int, usdPrice: uint })),
    factoryUsdPrice: uint,
  }),
  signer: Schema.optional(Schema.String),
  signature: Schema.String.check(Schema.isPattern(/^0x[\da-fA-F]{130}$/)),
})
const artifactShape = Schema.Struct({
  epoch: uint,
  chainId: Schema.Int,
  total: uint,
  root: Schema.NullOr(hexHash),
  dataHash: hexHash,
  priceList: signedPrices,
  claims: Schema.Record(Schema.String, Schema.Unknown),
  inputs: Schema.Struct({
    checkpoint: Schema.optional(
      Schema.Struct({
        previous: Schema.NullOr(Schema.Struct({ epoch: uint })),
      }),
    ),
  }),
})
const json = (bytes: Uint8Array): Record<string, unknown> =>
  Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  )
export const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export function pendingOf(bytes: Uint8Array, epoch: bigint, selected: PublishTarget): PendingEpoch {
  try {
    const file = Schema.decodeUnknownSync(artifactShape)(json(bytes))
    if (BigInt(file.epoch) !== epoch || file.chainId !== selected.chainId)
      throw new MiningPublishError('stage-chain-mismatch')
    // SAFETY: the schema restricts both commitments to bytes32 hex strings.
    const root = file.root === null ? null : (file.root.toLowerCase() as Hex)
    // SAFETY: hexHash accepts only bytes32 hex strings.
    const dataHash = file.dataHash.toLowerCase() as Hex
    const previous = file.inputs.checkpoint?.previous?.epoch
    return {
      root,
      total: BigInt(file.total),
      dataHash,
      signature: file.priceList.signature.toLowerCase(),
      previous: previous === undefined ? null : BigInt(previous),
      leaves: Object.keys(file.claims).length,
      sha256: sha256Of(bytes),
    }
  } catch (error) {
    if (error instanceof MiningPublishError) throw error
    throw new MiningPipelineError('artifact-invalid')
  }
}
function pricesOf(bytes: Uint8Array, epoch: bigint) {
  try {
    const file = Schema.decodeUnknownSync(signedPrices)(json(bytes))
    if (BigInt(file.message.epoch) !== epoch) throw new MiningPipelineError('artifact-invalid')
    return {
      message: { ...file.message, tokens: [...file.message.tokens] },
      signature: file.signature,
      ...(file.signer === undefined ? {} : { signer: file.signer }),
      ...(file.domain === undefined ? {} : { domain: file.domain }),
    }
  } catch {
    throw new MiningPipelineError('artifact-invalid')
  }
}

export interface PipelineChain extends EpochReader {
  snapshot(epochs: readonly bigint[]): Promise<readonly PipelineRead[]>
}
export interface PipelineOptions {
  selected: PublishTarget
  config: MiningConfig
  rpc: string
  store: ManifestsStore & ManifestsIndex
  chain: PipelineChain
  dryRun?: boolean
  compute?: (options: EpochOptions) => Promise<Awaited<ReturnType<typeof buildEpochV2WithState>>>
}
async function storedRead(options: PipelineOptions, bucket: string, entry: PipelineEntry, read: PipelineRead) {
  const { store, selected } = options
  const prices = entry.prices
    ? pricesOf(await store.get(bucket, `mining/prices-${entry.epoch}.json`), entry.epoch)
    : undefined
  const pending = entry.pending
    ? pendingOf(await store.get(bucket, `mining/pending-epoch-${entry.epoch}.json`), entry.epoch, selected)
    : undefined
  const published = entry.published
    ? pendingOf(await store.get(bucket, `mining/epoch-${entry.epoch}.json`), entry.epoch, selected)
    : undefined
  return {
    ...read,
    ...(prices === undefined ? {} : { signature: prices.signature.toLowerCase() }),
    ...(pending === undefined ? {} : { pending }),
    ...(published === undefined ? {} : { published }),
  }
}
/** A published predecessor's priceList has precedence over either uploaded fallback. */
export async function previousPrices(
  store: ManifestsIndex,
  bucket: string,
  epoch: bigint,
): Promise<PriceListFile | undefined> {
  if (epoch === 0n) return undefined
  const published = await store.find(bucket, `mining/epoch-${epoch - 1n}.json`)
  if (published !== null) {
    try {
      const file = Schema.decodeUnknownSync(Schema.Struct({ priceList: signedPrices }))(json(published))
      return pricesOf(new TextEncoder().encode(JSON.stringify(file.priceList)), epoch - 1n)
    } catch {
      throw new MiningPipelineError('artifact-invalid')
    }
  }
  for (const key of [`mining/prices-${epoch - 1n}.json`, `mining/previous-prices-${epoch}.json`]) {
    const bytes = await store.find(bucket, key)
    if (bytes !== null) return pricesOf(bytes, epoch - 1n)
  }
  return undefined
}
async function putVerified(store: ManifestsStore, bucket: string, key: string, bytes: Uint8Array) {
  await store.put(bucket, key, bytes)
  if (sha256Of(await store.get(bucket, key)) !== sha256Of(bytes)) throw new MiningPublishError('readback-mismatch')
}
async function computePending(options: PipelineOptions, bucket: string, epoch: bigint) {
  const pricesFile = pricesOf(await options.store.get(bucket, `mining/prices-${epoch}.json`), epoch)
  const previousFile = await previousPrices(options.store, bucket, epoch)
  const checkpointDir = mkdtempSync(join(tmpdir(), 'sidequest-mining-'))
  try {
    const input: EpochOptions = {
      epoch,
      config: options.config,
      network: options.selected.network,
      rpc: options.rpc,
      page: 1000n,
      logs: 'hypersync',
      pricesFile,
      checkpointDir,
      published: { store: options.store, bucket },
      ...(previousFile === undefined ? {} : { previousFile }),
    }
    const built = await (options.compute ?? computeFromChain)(input)
    const artifact = epochBytes(built.artifact),
      state = stateBytes(built.state)
    await putVerified(options.store, bucket, `mining/pending-state-${epoch}.json`, state)
    await putVerified(options.store, bucket, `mining/pending-epoch-${epoch}.json`, artifact)
    return pendingOf(artifact, epoch, options.selected)
  } finally {
    rmSync(checkpointDir, { recursive: true, force: true })
  }
}
const computeFromChain = async (options: EpochOptions) => buildEpochV2WithState(await readEpochContext(options))
async function publishPending(options: PipelineOptions, bucket: string, epoch: bigint) {
  const bytes = await options.store.get(bucket, `mining/pending-epoch-${epoch}.json`)
  const state = await options.store.get(bucket, `mining/pending-state-${epoch}.json`)
  await publishEpoch({ epoch: bytes, state }, options.selected, options.config, options.chain, options.store)
}
function refusal(error: unknown, rpc: string) {
  // Match epoch.ts's RPC redaction before classifying; provider text is never included in the summary.
  const message = error instanceof Error ? error.message.split(rpc).join('<rpc>') : ''
  if (message.includes('has not ended at the finalized head'))
    return { waiting: 'Wait for the epoch to end at the finalized head.' }
  if (/funding.*not final yet/.test(message)) return { waiting: 'Wait for funding finality.' }
  return {
    code: error instanceof MiningPublishError || error instanceof MiningPipelineError ? error.code : 'compute-refused',
  }
}
async function act(
  options: PipelineOptions,
  bucket: string,
  action: { kind: 'compute' | 'publish'; epoch: bigint },
  row: PipelineRow,
) {
  try {
    if (action.kind === 'publish') {
      await publishPending(options, bucket, action.epoch)
      row.status = 'published'
      row.next = 'Claims are available in Collect.'
      return
    }
    row.artifact = await computePending(options, bucket, action.epoch)
    row.status = row.artifact.root === null ? 'empty' : row.status
    row.next =
      row.status === 'empty'
        ? 'No funding or root is needed.'
        : 'Load the epoch in /admin, fund any remainder and set its root.'
  } catch (error) {
    const result = refusal(error, options.rpc)
    row.status = result.waiting === undefined ? `failed:${result.code}` : row.status
    row.next = result.waiting ?? 'Review the refusal and retry the same epoch.'
  }
}
export async function runPipeline(options: PipelineOptions): Promise<{ rows: PipelineRow[]; exitCode: number }> {
  try {
    if (options.selected.stage !== 'dev') throw new MiningPipelineError('pipeline-off')
    if (options.selected.network !== 'monad-testnet') throw new MiningPublishError('stage-chain-mismatch')
    const bucket = await options.store.bucket(options.selected)
    const keys = await options.store.list(bucket, 'mining/')
    const entries = pipelineInventory(keys)
    const chain = await options.chain.snapshot(entries.map((entry) => entry.epoch))
    const reads = await storedReads(options, bucket, entries, chain)
    const plan = planPipeline(keys, reads)
    await applyPlan(options, bucket, plan)
    return { rows: plan.rows, exitCode: plan.rows.some((row) => row.status.startsWith('failed:')) ? 1 : 0 }
  } catch (error) {
    const result = refusal(error, options.rpc)
    return {
      rows: [
        {
          epoch: null,
          status: result.waiting === undefined ? `failed:${result.code}` : 'pending',
          next: result.waiting ?? 'Review the refusal and retry.',
        },
      ],
      exitCode: result.waiting === undefined ? 1 : 0,
    }
  }
}

async function storedReads(
  options: PipelineOptions,
  bucket: string,
  entries: PipelineEntry[],
  chain: readonly PipelineRead[],
) {
  const reads: PipelineRead[] = []
  for (const entry of entries) {
    const read = chain.find((candidate) => candidate.epoch === entry.epoch)
    if (read === undefined) throw new MiningPipelineError('chain-unavailable')
    reads.push(await storedRead(options, bucket, entry, read))
  }
  return reads
}
async function applyPlan(options: PipelineOptions, bucket: string, plan: ReturnType<typeof planPipeline>) {
  for (const action of plan.actions) {
    const row = plan.rows.find((candidate) => candidate.epoch === action.epoch)
    if (row === undefined) throw new MiningPipelineError('artifact-invalid')
    if (options.dryRun) row.next = `Dry run: would ${action.kind} this epoch.`
    else await act(options, bucket, action, row)
    if (row.status.startsWith('failed:')) break
  }
}

async function fundingAt(c: PublicClient, lc: PublicClient, h: SidequestDeployment, head: bigint) {
  const finalized = await c.readContract({
    address: h.miningReserve,
    abi: reserveAbi,
    functionName: 'totalFunded',
    blockNumber: head,
  })
  const latest = await c.readContract({ address: h.miningReserve, abi: reserveAbi, functionName: 'totalFunded' })
  const logs =
    finalized === 0n
      ? []
      : await lc.getLogs({
          address: h.miningReserve,
          event: fundedEvent,
          fromBlock: h.block,
          toBlock: head,
          strict: true,
        })
  if (logs.reduce((sum, log) => sum + log.args.amount, 0n) !== finalized)
    throw new MiningPipelineError('chain-unavailable')
  const amounts = new Map<bigint, bigint>()
  for (const log of logs) amounts.set(log.args.epoch, (amounts.get(log.args.epoch) ?? 0n) + log.args.amount)
  return { final: finalized === latest, amounts }
}
export function pipelineChain(selected: PublishTarget, config: MiningConfig, rpc: string): PipelineChain {
  const d = deploymentFromConfig(selected.network, config),
    h = d.sidequest
  if (h === null || d.chainId !== selected.chainId) throw new MiningPipelineError('config-unavailable')
  const c = client(rpc),
    lc = logClient(rpc, { logs: 'hypersync', network: selected.network })
  const readRoot: EpochReader['readRoot'] = (address, epoch) =>
    c.readContract({ address, abi: epochDistributorAbi, functionName: 'rootOf', args: [epoch] })
  return {
    getChainId: () => c.getChainId(),
    readRoot,
    snapshot: (epochs) => readPipelineSnapshot({ c, lc, h, selected, config, epochs }),
  }
}
export async function readPipelineSnapshot(input: {
  c: PublicClient
  lc: PublicClient
  h: SidequestDeployment
  selected: PublishTarget
  config: MiningConfig
  epochs: readonly bigint[]
}): Promise<PipelineRead[]> {
  const { c, lc, h, selected, config, epochs } = input
  try {
    if ((await c.getChainId()) !== selected.chainId) throw new MiningPublishError('stage-chain-mismatch')
    if (epochs.length === 0) return []
    const head = await c.getBlock({ blockTag: 'finalized' })
    const funding = await fundingAt(c, lc, h, head.number)
    const roots = new Map<bigint, Promise<PipelineRead['root']>>()
    const readRoot = (epoch: bigint) => {
      let promise = roots.get(epoch)
      if (promise === undefined) {
        promise = c.readContract({
          address: h.distributor,
          abi: epochDistributorAbi,
          functionName: 'rootOf',
          args: [epoch],
          blockNumber: head.number,
        })
        roots.set(epoch, promise)
      }
      return promise
    }
    const rows: PipelineRead[] = []
    for (const epoch of epochs) {
      const rule = creditRuleOf(config, epoch)
      const anchor =
        rule.version === 1
          ? null
          : await findAnchor(
              { readRoot, blockHash: async (blockNumber) => (await c.getBlock({ blockNumber })).hash },
              epoch,
              rule.fromEpoch,
            )
      const end = await c.readContract({
        address: h.miningReserve,
        abi: reserveAbi,
        functionName: 'epochEnd',
        args: [epoch],
        blockNumber: head.number,
      })
      rows.push({
        epoch,
        root: await readRoot(epoch),
        ended: head.timestamp >= end,
        fundingFinal: funding.final,
        funded: funding.amounts.get(epoch) ?? 0n,
        laterFunded: [...funding.amounts].some(([later, amount]) => later > epoch && amount > 0n),
        anchor: anchor?.epoch ?? null,
      })
    }
    return rows
  } catch (error) {
    if (error instanceof MiningPublishError || error instanceof MiningPipelineError) throw error
    throw new MiningPipelineError('chain-unavailable')
  }
}
const sideAmount = (amount: bigint) => {
  const unit = 10n ** 18n,
    remainder = (amount % unit).toString().padStart(18, '0').replace(/0+$/, '')
  return `${amount / unit}${remainder === '' ? '' : `.${remainder}`}`
}
export function pipelineSummary(rows: readonly PipelineRow[]) {
  const lines = [
    '| Epoch | Status | Total SIDE | Leaves | Root | sha256 | Next step for the owner |',
    '| :-- | :-- | --: | --: | :-- | :-- | :-- |',
  ]
  for (const row of rows) {
    const file = row.artifact
    lines.push(
      `| ${row.epoch ?? '—'} | ${row.status} | ${file === undefined ? '—' : sideAmount(file.total)} | ${file?.leaves ?? '—'} | ${file?.root?.slice(0, 14) ?? '—'} | ${file?.sha256.slice(0, 12) ?? '—'} | ${row.next} |`,
    )
  }
  return `${lines.join('\n')}\n`
}
async function main() {
  let result: Awaited<ReturnType<typeof runPipeline>>
  try {
    const args = pipelineArgs(process.argv.slice(2)),
      selected = stageOf(args.stage),
      env = process.env
    if (
      (env.SIDEQUEST_STAGE && env.SIDEQUEST_STAGE !== selected.stage) ||
      (env.SIDEQUEST_NETWORK && env.SIDEQUEST_NETWORK !== selected.network)
    )
      throw new MiningPublishError('stage-chain-mismatch')
    const rpc = env.MONAD_RPC_URL
    if (!rpc || rpc === 'unset') throw new MiningPublishError('credentials-missing')
    // SAFETY: deploymentFromConfig and creditRuleOf validate the deployment and cutover before chain reads.
    const config = JSON.parse(
      readFileSync(new URL(`../../contracts/config/${selected.network}.json`, import.meta.url), 'utf8'),
    ) as MiningConfig
    result = await runPipeline({
      selected,
      config,
      rpc,
      dryRun: args.dryRun,
      store: new CloudflareManifests(env),
      chain: pipelineChain(selected, config, rpc),
    })
  } catch (error) {
    const code =
      error instanceof MiningPublishError || error instanceof MiningPipelineError ? error.code : 'config-unavailable'
    result = {
      rows: [
        {
          epoch: null,
          status: `failed:${code}`,
          next:
            code === 'pipeline-off'
              ? 'Prod mining stays manual until Kris enables it.'
              : 'Check stage configuration and required credentials.',
        },
      ],
      exitCode: 1,
    }
    if (code === 'pipeline-off') console.error('pipeline-off: prod mining stays manual until Kris enables it')
  }
  const summary = pipelineSummary(result.rows)
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  process.exitCode = result.exitCode
}
if (import.meta.main) await main()
