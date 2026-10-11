import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import testnet from '../../contracts/config/monad-testnet.json'
import epoch29 from './fixtures/testnet-epoch-29.json'
import { deploymentFromConfig } from '../../packages/sdk/src/deployment.ts'
import {
  buildEpochV2WithState,
  epochBytes,
  stateBytes,
  type EpochContext,
  type EpochOptions,
  type MiningConfig,
} from './epoch-v2.ts'
import { cumulativeBudget, replayLots } from './lots.ts'
import { parsePriceList, type PriceListFile } from './prices.ts'
import { MiningPublishError, stageOf, type ManifestsIndex, type ManifestsStore } from './publish-lib.ts'
import { unsetHash, type PipelineRead } from './pipeline-lib.ts'
import {
  pipelineArgs,
  pipelineSummary,
  previousPrices,
  runPipeline,
  type PipelineChain,
  type PipelineOptions,
} from './pipeline.ts'
import { type Hex, type PublicClient } from './viem.ts'
import { lower } from './ledger-chain.ts'
import { readPipelineSnapshot } from './pipeline.ts'

const worker = '0x0000000000000000000000000000000000000001'
const creator = '0x0000000000000000000000000000000000000002'
const hash = `0x${'ab'.repeat(32)}` as const
const side = 10n ** 18n
const bytesOf = (value: object) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)
class Store implements ManifestsStore, ManifestsIndex {
  files = new Map<string, Uint8Array>()
  writes: string[] = []
  corrupt: string | undefined
  async bucket() {
    return 'fixture'
  }
  async list(bucket: string, prefix: string) {
    return [...this.files.keys()].filter((key) => key.startsWith(prefix))
  }
  async find(bucket: string, key: string) {
    return this.files.get(key) ?? null
  }
  async get(bucket: string, key: string) {
    if (key === this.corrupt) return new Uint8Array([255])
    const value = this.files.get(key)
    if (value === undefined) throw new MiningPublishError('cloudflare-unavailable')
    return value
  }
  async put(bucket: string, key: string, bytes: Uint8Array) {
    this.writes.push(key)
    this.files.set(key, bytes.slice())
  }
}
function fixtureConfig(): MiningConfig {
  return {
    ...structuredClone(testnet),
    mining: { creditRule: { fromEpoch: '30' } },
    deployment: {
      ...structuredClone(testnet.deployment),
      block: 1,
      sidequest: { ...structuredClone(testnet.deployment.sidequest), block: 1 },
    },
  }
}
const prices = (epoch = '30', signature = `0x${'aa'.repeat(65)}`): PriceListFile => ({
  message: {
    epoch,
    tokens: [{ token: testnet.deployment.rewardTokens[0].toLowerCase(), decimals: 6, usdPrice: side.toString() }],
    factoryUsdPrice: (10n ** 15n).toString(),
  },
  signer: worker,
  signature,
})
function fakeClient(config: MiningConfig, empty: boolean, anchorHash: Hex = unsetHash) {
  const d = deploymentFromConfig('monad-testnet', config),
    h = d.sidequest,
    holding = d.stacks.main?.holding
  if (h === null || holding === undefined) throw new Error('fixture deployment missing')
  const thresholds = [0n, 10_000n * side, 100_000n * side, 1_000_000n * side]
  const schedule = { thresholds, bps: [3000, 1000, 300, 100], treasury: creator }
  const logs = [
    { address: h.feeSchedule, blockNumber: 1n, eventName: 'ScheduleExecuted', args: schedule },
    {
      address: holding,
      blockNumber: 2n,
      eventName: 'Activated',
      args: { jobId: 1n, worker, agentId: 1n, feeBps: 3000, fee: 30_000_000n, net: 70_000_000n },
    },
    ...(empty
      ? []
      : [
          {
            address: holding,
            blockNumber: 15n,
            eventName: 'FeeCharged',
            args: {
              jobId: 1n,
              token: testnet.deployment.rewardTokens[0].toLowerCase(),
              worker,
              creator,
              amount: 30_000_000n,
              bonusPart: 0n,
            },
          },
        ]),
  ].map((log) => ({ ...log, transactionHash: hash, logIndex: 0 }))
  const values: Record<string, unknown> = {
    UNSTAKE_DELAY: BigInt(h.clocks!.unstakeDelay),
    cumulativeBudget: cumulativeBudget(30n),
    totalFunded: 0n,
    totalAssets: 0n,
    poolOf: { assets: 0n, shares: 0n, queuedShares: 0n, generation: 0n },
    schedule,
    getMetadata: '0x',
    getListing: { reward: 100_000_000n, fee: 30_000_000n, feeBps: 3000, bonus: 0n, worker },
    feeSchedule: h.feeSchedule.toLowerCase(),
    vault: h.vault.toLowerCase(),
    identity: d.identity.toLowerCase(),
    rootOf: { root: unsetHash, total: 0n, claimed: 0n, dataHash: unsetHash },
  }
  // SAFETY: the unit client implements every builder read with the decoded ABI shapes used above.
  const c = {
    getBlock: async ({ blockNumber = 20n }: { blockNumber?: bigint }) => ({
      number: blockNumber,
      timestamp: blockNumber,
      hash,
    }),
    readContract: async (request: { functionName: string; args?: bigint[] }) => {
      const epoch = request.args?.[0] ?? 30n
      if (request.functionName === 'rootOf' && epoch === 30n)
        return { root: hash, total: 0n, claimed: 0n, dataHash: anchorHash }
      if (request.functionName === 'cumulativeBudget') return cumulativeBudget(epoch)
      if (request.functionName === 'epochStart') return 10n + (epoch - 30n) * 10n
      if (request.functionName === 'epochEnd') return 20n + (epoch - 30n) * 10n
      const value = values[request.functionName]
      if (value === undefined) throw new Error(`unexpected fixture read ${request.functionName}`)
      return value
    },
    getLogs: async (request: { address: string | string[]; fromBlock: bigint; toBlock: bigint }) => {
      const addresses = (Array.isArray(request.address) ? request.address : [request.address]).map((address) =>
        address.toLowerCase(),
      )
      return logs.filter(
        (log) =>
          addresses.includes(log.address.toLowerCase()) &&
          log.blockNumber >= request.fromBlock &&
          log.blockNumber <= request.toBlock,
      )
    },
  } as PublicClient
  return { c, d, h, holding }
}
async function contextOf(options: EpochOptions, empty = false, anchorHash: Hex = unsetHash): Promise<EpochContext> {
  const { c, d, h, holding } = fakeClient(options.config, empty, anchorHash),
    priceList = options.pricesFile
  const start = 10n + (options.epoch - 30n) * 10n,
    end = start + 10n
  if (priceList.signature === undefined) throw new Error('unsigned fixture')
  const parsed = parsePriceList(priceList)
  // SAFETY: the fixture signature is a fixed 65-byte hex string; no signing takes place.
  const signature = priceList.signature as `0x${string}`
  return {
    ...options,
    d,
    h,
    c,
    lc: c,
    chainId: 10143,
    holdings: [lower(holding)],
    start,
    end,
    fromBlock: start,
    toBlock: end - 1n,
    head: await c.getBlock({ blockNumber: end }),
    pager: { page: 1000n, logs: 'hypersync' },
    signed: { prices: parsed, signer: worker, signature },
    prices: parsed,
    window: {
      start: String(start),
      end: String(end),
      fromBlock: String(start),
      toBlock: String(end - 1n),
      toBlockHash: hash,
    },
    priceList: { message: { ...priceList.message }, signer: worker, signature },
    factoryPriceEvidence: {
      pool: null,
      poolId: null,
      quote: null,
      samples: [],
      source: 'previous-signed-price',
      previousSignedPrice: null,
    },
    budget: { cumulativeBudget: cumulativeBudget(options.epoch), totalFunded: 0n, ...replayLots(options.epoch, []) },
  }
}
function fixture(empty = false) {
  const store = new Store(),
    config = fixtureConfig(),
    selected = stageOf('dev')
  store.files.set('mining/prices-30.json', bytesOf(prices()))
  const snapshot: PipelineRead = {
    epoch: 30n,
    root: { root: unsetHash, total: 0n, claimed: 0n, dataHash: unsetHash },
    ended: true,
    fundingFinal: true,
    funded: 0n,
    laterFunded: false,
    anchor: null,
  }
  const chain: PipelineChain = {
    getChainId: async () => selected.chainId,
    readRoot: async () => snapshot.root,
    snapshot: async (epochs) =>
      epochs.map((epoch) =>
        epoch === 30n
          ? snapshot
          : { ...snapshot, epoch, root: { root: unsetHash, total: 0n, claimed: 0n, dataHash: unsetHash } },
      ),
  }
  const computations: EpochOptions[] = []
  const options: PipelineOptions = {
    selected,
    config,
    rpc: 'https://rpc.invalid/private-token',
    store,
    chain,
    compute: async (input) => {
      computations.push(input)
      return buildEpochV2WithState(await contextOf(input, empty))
    },
  }
  return { options, store, snapshot, computations }
}

test('full cycle computes direct builder bytes, publishes after root set, then does nothing', async () => {
  const f = fixture()
  const computed = await runPipeline(f.options)
  expect(computed.exitCode).toBe(0)
  expect(computed.rows[0]?.status).toBe('pending')
  const input = f.computations[0]
  if (input === undefined) throw new Error('computation not called')
  expect(input.logs).toBe('hypersync')
  expect(input.published).toEqual({ store: f.store, bucket: 'fixture' })
  expect(existsSync(input.checkpointDir!)).toBe(false)
  const direct = await buildEpochV2WithState(await contextOf(input))
  expect(f.store.files.get('mining/pending-epoch-30.json')).toEqual(epochBytes(direct.artifact))
  expect(f.store.files.get('mining/pending-state-30.json')).toEqual(stateBytes(direct.state))
  expect(new TextDecoder().decode(epochBytes(direct.artifact))).toBe(`${JSON.stringify(direct.artifact, null, 2)}\n`)
  expect(new TextDecoder().decode(stateBytes(direct.state))).toBe(`${JSON.stringify(direct.state, null, 2)}\n`)
  expect(f.store.writes).toEqual(['mining/pending-state-30.json', 'mining/pending-epoch-30.json'])
  expect(direct.artifact.root).not.toBeNull()
  f.snapshot.root = {
    root: direct.artifact.root!,
    total: BigInt(direct.artifact.total),
    claimed: 0n,
    dataHash: direct.artifact.dataHash,
  }
  const published = await runPipeline(f.options)
  expect(published.exitCode).toBe(0)
  expect(published.rows[0]?.status).toBe('published')
  expect(f.store.writes.slice(2)).toEqual(['mining/state-30.json', 'mining/epoch-30.json'])
  expect(f.store.files.get('mining/epoch-30.json')).toEqual(epochBytes(direct.artifact))
  expect(f.store.files.get('mining/state-30.json')).toEqual(stateBytes(direct.state))
  const again = await runPipeline(f.options)
  expect(again.rows[0]?.status).toBe('published')
  expect(f.computations).toHaveLength(1)
  expect(f.store.writes).toHaveLength(4)
})
test('empty computation is terminal on the next run', async () => {
  const f = fixture(true)
  expect((await runPipeline(f.options)).rows[0]?.status).toBe('empty')
  expect((await runPipeline(f.options)).rows[0]?.status).toBe('empty')
  expect(f.computations).toHaveLength(1)
  expect(f.store.writes).toHaveLength(2)
})
test('dry run reads and plans compute or publication but performs neither', async () => {
  const f = fixture()
  const dry = await runPipeline({ ...f.options, dryRun: true })
  expect(dry.rows[0]?.next).toBe('Dry run: would compute this epoch.')
  expect(f.computations).toHaveLength(0)
  expect(f.store.writes).toHaveLength(0)
  await runPipeline(f.options)
  const input = f.computations[0]
  if (input === undefined) throw new Error('missing fixture computation')
  const direct = await buildEpochV2WithState(await contextOf(input))
  f.snapshot.root = {
    root: direct.artifact.root!,
    total: BigInt(direct.artifact.total),
    claimed: 0n,
    dataHash: direct.artifact.dataHash,
  }
  expect((await runPipeline({ ...f.options, dryRun: true })).rows[0]?.next).toBe('Dry run: would publish this epoch.')
  expect(f.store.writes).toHaveLength(2)
})
test('pending uploads verify state before epoch and refuse corrupt readbacks', async () => {
  for (const key of ['mining/pending-state-30.json', 'mining/pending-epoch-30.json']) {
    const f = fixture()
    f.store.corrupt = key
    const result = await runPipeline(f.options)
    expect(result.exitCode).toBe(1)
    expect(result.rows[0]?.status).toBe('failed:readback-mismatch')
    expect(f.store.writes[0]).toBe('mining/pending-state-30.json')
    if (key.includes('state')) expect(f.store.writes).toHaveLength(1)
  }
})
test('transient builder refusals wait with exit zero; other errors are safe failures', async () => {
  for (const message of [
    'epoch 30 has not ended at the finalized head; wait for finality',
    'reserve funding is not final yet',
    'integrity: reserve funding is not final yet',
  ]) {
    const f = fixture()
    f.options.compute = async () => {
      throw new Error(message)
    }
    const result = await runPipeline(f.options)
    expect(result.exitCode).toBe(0)
    expect(result.rows[0]?.status).toBe('pending')
    expect(result.rows[0]?.next).toContain('Wait')
    expect(f.store.writes).toHaveLength(0)
  }
  const f = fixture()
  f.options.compute = async () => {
    throw new Error(`secret provider-body ${f.options.rpc} fixture-token`)
  }
  const result = await runPipeline(f.options),
    summary = pipelineSummary(result.rows)
  expect(result.exitCode).toBe(1)
  expect(summary).toContain('failed:compute-refused')
  expect(summary).not.toContain(f.options.rpc)
  expect(summary).not.toContain('fixture-token')
})
test('root mismatch exits nonzero with a summary and no writes', async () => {
  const f = fixture()
  f.snapshot.root.dataHash = hash
  const result = await runPipeline(f.options)
  expect(result.exitCode).toBe(1)
  expect(result.rows[0]?.status).toBe('failed:root-mismatch')
  expect(f.store.writes).toHaveLength(0)
})
test('previous price precedence uses the vendored published price list, then uploads, then optional previous', async () => {
  const store = new Store()
  store.files.set('mining/epoch-29.json', bytesOf(epoch29))
  store.files.set('mining/prices-29.json', bytesOf(prices('29')))
  store.files.set('mining/previous-prices-30.json', bytesOf(prices('29', `0x${'bb'.repeat(65)}`)))
  expect((await previousPrices(store, 'fixture', 30n))?.signature).toBe(epoch29.priceList.signature)
  store.files.delete('mining/epoch-29.json')
  expect((await previousPrices(store, 'fixture', 30n))?.signature).toBe(prices('29').signature)
  store.files.delete('mining/prices-29.json')
  expect((await previousPrices(store, 'fixture', 30n))?.signature).toBe(`0x${'bb'.repeat(65)}`)
  store.files.clear()
  expect(await previousPrices(store, 'fixture', 30n)).toBeUndefined()
  expect(await previousPrices(store, 'fixture', 0n)).toBeUndefined()
})
test('the runner passes previous prices into computation and recreates stale signature files', async () => {
  const f = fixture()
  f.store.files.set('mining/prices-29.json', bytesOf(prices('29')))
  await runPipeline(f.options)
  expect(f.computations[0]?.previousFile).toEqual(prices('29'))
  f.store.files.set('mining/prices-30.json', bytesOf(prices('30', `0x${'bb'.repeat(65)}`)))
  await runPipeline(f.options)
  expect(f.computations).toHaveLength(2)
  f.store.files.set('mining/prices-30.json', bytesOf(prices('30', `0x${'BB'.repeat(65)}`)))
  await runPipeline(f.options)
  expect(f.computations).toHaveLength(2)
})
test('summary renders exact SIDE amounts and short commitments', async () => {
  const f = fixture()
  const result = await runPipeline(f.options)
  const row = result.rows[0]
  if (row?.artifact === undefined) throw new Error('missing computed row')
  row.artifact.total = 1234567890123456789n
  const summary = pipelineSummary([row])
  expect(summary).toContain('| 30 | pending | 1.234567890123456789 | 2 |')
  expect(summary).toContain(row.artifact.root!.slice(0, 14))
  expect(summary).toContain(row.artifact.sha256.slice(0, 12))
})
test('only explicit dev stage and unique flags are accepted; prod refuses before any I/O', () => {
  expect(pipelineArgs(['--stage', 'dev'])).toEqual({ stage: 'dev', dryRun: false })
  expect(pipelineArgs(['--dry-run', '--stage', 'dev'])).toEqual({ stage: 'dev', dryRun: true })
  for (const argv of [
    [],
    ['--stage'],
    ['--stage', 'local'],
    ['--stage', 'dev', '--stage', 'dev'],
    ['--stage', 'dev', '--dry-run', '--dry-run'],
    ['--stage', 'dev', '--unknown'],
  ])
    expect(() => pipelineArgs(argv)).toThrow('usage')
  const dir = mkdtempSync(join(tmpdir(), 'mining-summary-')),
    summaryPath = join(dir, 'summary.md')
  try {
    const child = spawnSync('bun', ['--no-env-file', 'scripts/mining/pipeline.ts', '--stage', 'prod'], {
      env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summaryPath },
      encoding: 'utf8',
    })
    expect(child.status).toBe(1)
    expect(child.stderr).toContain('pipeline-off: prod mining stays manual until Kris enables it')
    expect(child.stdout).toContain('failed:pipeline-off')
    expect(readFileSync(summaryPath, 'utf8').trim()).toBe(child.stdout.trim())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the builder restores a verified published checkpoint from a fresh directory', async () => {
  const f = fixture()
  await runPipeline(f.options)
  const input = f.computations[0]
  if (input === undefined) throw new Error('missing first computation')
  const first = await buildEpochV2WithState(await contextOf(input))
  f.store.files.set('mining/epoch-30.json', epochBytes(first.artifact))
  f.store.files.set('mining/state-30.json', stateBytes(first.state))
  f.store.files.set('mining/prices-31.json', bytesOf(prices('31')))
  f.options.chain.snapshot = async (epochs) =>
    epochs.map((epoch) => ({
      ...f.snapshot,
      epoch,
      anchor: epoch === 31n ? 30n : null,
      root:
        epoch === 30n
          ? {
              root: first.artifact.root!,
              total: BigInt(first.artifact.total),
              claimed: 0n,
              dataHash: first.artifact.dataHash,
            }
          : f.snapshot.root,
    }))
  const fresh: string[] = []
  f.options.compute = async (options) => {
    if (options.checkpointDir === undefined) throw new Error('missing fresh checkpoint directory')
    fresh.push(options.checkpointDir)
    expect(existsSync(options.checkpointDir)).toBe(true)
    return buildEpochV2WithState(await contextOf(options, false, first.artifact.dataHash))
  }
  const result = await runPipeline(f.options)
  expect(result.exitCode).toBe(0)
  expect(result.rows.map((row) => row.status)).toEqual(['published', 'empty'])
  const bytes = f.store.files.get('mining/pending-epoch-31.json')
  if (bytes === undefined) throw new Error('missing next epoch')
  expect(new TextDecoder().decode(bytes)).toContain('"epoch": "30"')
  expect(fresh.every((dir) => !existsSync(dir))).toBe(true)
})

test('chain snapshots pin root and window reads to finality, find the anchor and detect later funding', async () => {
  const config = fixtureConfig(),
    selected = stageOf('dev'),
    d = deploymentFromConfig(selected.network, config),
    h = d.sidequest
  if (h === null) throw new Error('missing fixture deployment')
  const reads: { functionName: string; blockNumber?: bigint }[] = []
  // SAFETY: these unit reads implement only the finalized snapshot's ABI-shaped responses.
  const c = {
    getChainId: async () => 10143,
    getBlock: async () => ({ number: 100n, timestamp: 100n, hash }),
    readContract: async (request: { functionName: string; args?: bigint[]; blockNumber?: bigint }) => {
      reads.push(request)
      if (request.functionName === 'totalFunded') return request.blockNumber === undefined ? 6n : 5n
      if (request.functionName === 'epochEnd') return 90n
      if (request.functionName === 'rootOf')
        return { root: hash, total: 5n, claimed: 0n, dataHash: request.args?.[0] === 30n ? hash : unsetHash }
      throw new Error('unexpected snapshot read')
    },
  } as PublicClient
  // SAFETY: fundingAt consumes only the decoded EpochFunded args of these unit logs.
  const lc = { getLogs: async () => [{ args: { epoch: 32n, amount: 5n } }] } as PublicClient
  const rows = await readPipelineSnapshot({ c, lc, h, selected, config, epochs: [31n, 32n] })
  expect(rows[0]).toMatchObject({
    epoch: 31n,
    anchor: 30n,
    ended: true,
    fundingFinal: false,
    laterFunded: true,
    funded: 0n,
  })
  expect(rows[1]).toMatchObject({ epoch: 32n, anchor: 30n, funded: 5n, laterFunded: false })
  expect(reads.filter((read) => read.functionName !== 'totalFunded').every((read) => read.blockNumber === 100n)).toBe(
    true,
  )
  expect(reads.filter((read) => read.functionName === 'rootOf')).toHaveLength(3)
})

test('invalid stored artifacts fail safely and cannot produce writes', async () => {
  for (const value of ['invalid-json', JSON.stringify({ message: { epoch: '31' }, signature: 'invalid' })]) {
    const f = fixture()
    f.store.files.set('mining/prices-30.json', new TextEncoder().encode(value))
    const result = await runPipeline(f.options)
    expect(result.exitCode).toBe(1)
    expect(result.rows[0]?.status).toBe('failed:artifact-invalid')
    expect(f.store.writes).toHaveLength(0)
  }
})
