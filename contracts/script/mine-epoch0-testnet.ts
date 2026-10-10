import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import { Schema } from 'effect'
import { context, wallet } from '../../packages/sdk/src/client.ts'
import { networkMetaFromConfig } from '../../packages/sdk/src/deployment.ts'
import type { Ctx } from '../../packages/sdk/src/actions.ts'
import { epochDistributorAbi } from '../../packages/sdk/src/abi/epochDistributor.ts'
import { FlowJournal, parseFlowJson, type FlowState } from '../../packages/sdk/src/flow-journal.ts'
import { ensureFlowDirectory, saveFlowState } from '../../packages/sdk/scripts/flow-persistence.ts'
import { CloudflareManifests, parseEpoch, stageOf, type ManifestsStore, type PublishStage } from '../../scripts/mining/publish-lib.ts'
import { stageProfile } from '../../infra/stage.ts'
import { getAddress, privateKeyToAccount, type Hex } from '../../scripts/mining/viem.ts'
import { epochCalls, runEpoch, type EpochFile } from './epoch0-transactions.ts'
import { bindMiningState, miningBinding } from './testnet-mining-binding.ts'
import { EpochNotEnded, miningOptions, requireEndedEpoch, requirePriceEpoch, validateOwner } from './testnet-mining-options.ts'
import { epochWindowOf, firstBlockAtOrAfter, logClient } from '../../scripts/mining/chain.ts'
import { findAnchor, loadCheckpoint, verifyCheckpoint } from '../../scripts/mining/checkpoint.ts'
import { canonicalRuleV2 } from '../../scripts/mining/inputs-v2.ts'
import { officialPoolOf, sampleOfficialPool } from '../../scripts/mining/pool-chain.ts'
import { parsePriceList } from '../../scripts/mining/prices.ts'
import { creditRuleOf } from '../../scripts/mining/rule.ts'
import { parseState, stateContractsOf, stateHashOf } from '../../scripts/mining/state.ts'
import type { MiningConfig } from '../../scripts/mining/epoch-v2.ts'

// Call only through the shell wrapper, which holds the shared launch lock.
// Raw keys are permitted only here on testnet; none goes into a command log.
const repo = resolve(import.meta.dirname, '../..')
function run(command: string, args: string[]) {
  const child = spawnSync(command, args, { cwd: repo, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (child.status !== 0) throw new Error(`${command} command refused (provider details suppressed)`)
  return child.stdout.trim()
}
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const env = (name: string) => {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !process.env[name]) throw new Error(`set ${name} by environment name`)
  return process.env[name]!
}
const object = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))
const messageOf = Schema.decodeUnknownSync(Schema.Struct({
  epoch: Schema.String, factoryUsdPrice: Schema.String,
  tokens: Schema.Array(Schema.Struct({ token: Schema.String, decimals: Schema.Number, usdPrice: Schema.String })),
}))
// SAFETY: The SDK validates this committed deployment; creditRuleOf and officialPoolOf validate mining settings.
const config = JSON.parse(readFileSync(new URL('../config/monad-testnet.json', import.meta.url), 'utf8')) as MiningConfig

function stageEnvironment(stage: PublishStage | undefined): PublishStage {
  if (stage === undefined) return 'dev'
  Object.assign(process.env, parseEnv(readFileSync(join(homedir(), '.config', 'sidequest', `${stage}.env`), 'utf8')))
  return stage
}
function sidequest(ctx: Ctx) {
  const h = ctx.deployment.sidequest
  if (!h) throw new Error('testnet only: no Sidequest deployment')
  return h
}
function stateContracts(ctx: Ctx) {
  const h = sidequest(ctx)
  return stateContractsOf({
    holdings: Object.values(ctx.deployment.stacks).flatMap((stack) => stack?.kind === 'sidequest-v1' ? [stack.holding] : []),
    identity: ctx.deployment.identity, vault: h.vault, feeSchedule: h.feeSchedule,
    reserve: h.miningReserve, distributor: h.distributor,
  })
}
async function publishedStore(stage: PublishStage, makeStore: () => ManifestsStore) {
  const store = makeStore(), bucket = await store.bucket(stageOf(stage)), fetched = new Map<string, Uint8Array>()
  return { bucket, fetched, store: { get: async (selectedBucket: string, key: string) => {
    const bytes = await store.get(selectedBucket, key)
    fetched.set(key, bytes)
    return bytes
  } } }
}

/** Fetch only missing files, and verify all commitments before making them available to replay. */
export async function ensureCheckpoint(ctx: Ctx, epoch: bigint, out: string, stage: PublishStage,
  makeStore: () => ManifestsStore = () => new CloudflareManifests(process.env)) {
  const rule = creditRuleOf(config, epoch)
  if (rule.version !== 2) return
  const h = sidequest(ctx), c = ctx.publicClient
  const reader = {
    readRoot: (previousEpoch: bigint) => c.readContract({ address: h.distributor, abi: epochDistributorAbi, functionName: 'rootOf', args: [previousEpoch], blockTag: 'finalized' }),
    blockHash: async (block: bigint) => (await c.getBlock({ blockNumber: block })).hash,
  }
  const anchor = await findAnchor(reader, epoch, rule.fromEpoch)
  if (anchor === null) return
  const missing = [`epoch-${anchor.epoch}.json`, `state-${anchor.epoch}.json`].some(name => !existsSync(resolve(out, name)))
  const published = missing ? await publishedStore(stage, makeStore) : undefined
  const files = await loadCheckpoint(anchor, out, published)
  const delay = h.clocks?.unstakeDelay
  if (delay === undefined) throw new Error('checkpoint requires configured unstake delay')
  await verifyCheckpoint({
    anchor, files, reader, chainId: ctx.deployment.chainId,
    rule: canonicalRuleV2(rule.fromEpoch, BigInt(delay), false, networkMetaFromConfig(config).usdPegged),
    contracts: stateContracts(ctx), genesisBlock: ctx.deployment.deployBlock < h.block ? ctx.deployment.deployBlock : h.block,
  })
  if (published !== undefined) for (const [key, bytes] of published.fetched) {
    writeFileSync(resolve(out, key.slice('mining/'.length)), bytes, { mode: 0o600 })
  }
}

async function needsPreviousPrices(ctx: Ctx, signed: string, epoch: bigint) {
  if (epoch === 0n) return false
  const pool = officialPoolOf(config)
  if (pool === null) return true
  const h = sidequest(ctx), c = ctx.publicClient, message = messageOf(object(JSON.parse(signed)).message)
  const prices = parsePriceList({ message: { ...message, tokens: [...message.tokens] } })
  const { start, end } = await epochWindowOf(c, h.miningReserve, epoch), head = await c.getBlock({ blockTag: 'finalized' })
  const fromBlock = await firstBlockAtOrAfter(c, start, h.block, head.number)
  const toBlock = (await firstBlockAtOrAfter(c, end, h.block, head.number)) - 1n
  const evidence = await sampleOfficialPool({ c, pool, factory: h.factory, prices, start, end, fromBlock, toBlock })
  return evidence.samples.every(sample => sample.status !== 'sampled')
}
function signPrices(j: FlowJournal, input: string, path: string, key: string, ownerKeyEnv: string) {
  return j.once(key, async () => {
    run('bun', ['--no-env-file', 'scripts/mining/sign-prices.ts', input, '--network', 'monad-testnet', '--out', path,
      '--private-key-env', ownerKeyEnv])
    return readFileSync(path, 'utf8')
  })
}
/** Both signatures are immutable journal values, including on a retry with missing output files. */
async function priceFiles(ctx: Ctx, j: FlowJournal, options: ReturnType<typeof miningOptions>, input: string, out: string) {
  const { epoch, ownerKeyEnv } = options, path = resolve(out, `prices-epoch-${epoch}.json`)
  const signed = await signPrices(j, input, path, epoch === 0n ? 'signed-prices' : `signed-prices/${epoch}`, ownerKeyEnv)
  writeFileSync(path, signed, { mode: 0o600 })
  if (!await needsPreviousPrices(ctx, signed, epoch)) return { path }
  const previous = messageOf(object(JSON.parse(signed)).message), unsignedPath = resolve(out, `unsigned-prices-epoch-${epoch - 1n}.json`)
  writeFileSync(unsignedPath, JSON.stringify({ ...previous, epoch: (epoch - 1n).toString() }), { mode: 0o600 })
  const previousPath = resolve(out, `prices-epoch-${epoch - 1n}.json`)
  const fallback = await signPrices(j, unsignedPath, previousPath, `signed-prices-previous/${epoch}`, ownerKeyEnv)
  writeFileSync(previousPath, fallback, { mode: 0o600 })
  return { path, previousPath }
}
function checkState(ctx: Ctx, bytes: string, file: ReturnType<typeof parseEpoch>) {
  if (file.checkpoint === null) throw new Error('epoch state commitment missing')
  const state = parseState(JSON.parse(bytes))
  if (stateHashOf(state) !== file.checkpoint.stateHash || state.epoch !== file.epoch || state.chainId !== String(ctx.deployment.chainId)
    || state.block !== file.checkpoint.window.toBlock || state.blockHash !== file.checkpoint.window.toBlockHash
    || JSON.stringify(state.contracts) !== JSON.stringify(stateContracts(ctx))) throw new Error('epoch state commitment mismatch')
}
async function epochFiles(ctx: Ctx, j: FlowJournal, options: ReturnType<typeof miningOptions>, files: { input: string; out: string; stage: PublishStage }) {
  const { input, out, stage } = files
  const { epoch, logs } = options, path = resolve(out, `epoch-${epoch}.json`), statePath = resolve(out, `state-${epoch}.json`)
  const artifactKey = epoch === 0n ? 'epoch-artifact' : `epoch-artifact/${epoch}`, stateKey = `state-artifact/${epoch}`
  const bytes = await j.once(artifactKey, async () => {
    const prices = await priceFiles(ctx, j, options, input, out)
    await ensureCheckpoint(ctx, epoch, out, stage)
    const args = ['--no-env-file', 'run', 'mining:epoch', epoch.toString(), '--network', 'monad-testnet', '--prices', prices.path,
      '--out', out, '--checkpoint-dir', out, '--logs', logs]
    if (prices.previousPath !== undefined) args.push('--previous-prices', prices.previousPath)
    console.log(run('bun', args))
    const captured = readFileSync(path, 'utf8')
    if (object(JSON.parse(captured)).rule === 2) await j.once(stateKey, async () => readFileSync(statePath, 'utf8'))
    return captured
  })
  if (object(JSON.parse(bytes)).root === null) throw new Error('epoch has no earned fees; select an ended epoch with counted paid fees and a new directory')
  const validated = parseEpoch(Buffer.from(bytes), stageProfile(stage)!)
  if (validated.epoch !== epoch.toString()) throw new Error('wrong epoch')
  if (object(JSON.parse(bytes)).rule === 2) {
    const stateBytes = await j.once(stateKey, async () => readFileSync(statePath, 'utf8'))
    checkState(ctx, stateBytes, validated)
    writeFileSync(statePath, stateBytes, { mode: 0o600 })
  }
  writeFileSync(path, bytes, { mode: 0o600 })
  return { bytes, path, statePath, v2: validated.checkpoint !== null }
}

async function main() {
  const options = miningOptions(process.argv.slice(2)), { inputArg, outArg, claimKeyEnv, ownerKeyEnv, stage, logs, epoch } = options
  if (!existsSync('/proc/self/fd/9')) throw new Error('use the launch-lock shell wrapper')
  const selectedStage = stageEnvironment(stage), selected = stageProfile(selectedStage)!
  if (selected.network !== 'monad-testnet' || selected.chainId !== 10143) throw new Error('testnet only: selected stage is not testnet')
  const rpc = stage === undefined ? env('MONAD_TESTNET_RPC_URL') : env('MONAD_RPC_URL')
  process.env.MONAD_TESTNET_RPC_URL = rpc
  const base = context('monad-testnet', 'main', rpc)
  const ctx = { ...base, publicClient: base.publicClient.extend(() => ({ getLogs: logClient(rpc, { logs, network: 'monad-testnet' }).getLogs })) }
  const h = ctx.deployment.sidequest
  if (ctx.deployment.chainId !== 10143 || await ctx.publicClient.getChainId() !== 10143 || !h || ctx.stack.kind !== 'sidequest-v1') {
    throw new Error('testnet only: refuses chain 143 regardless of MAINNET_GO')
  }
  await requireEndedEpoch(ctx.publicClient, h.miningReserve, epoch)
  const input = resolve(inputArg)
  requirePriceEpoch(JSON.parse(readFileSync(input, 'utf8')), epoch)
  run('bun', ['--no-env-file', 'contracts/script/check-launch-testnet.ts'])
  const owner = wallet('monad-testnet', privateKeyToAccount(env(ownerKeyEnv) as Hex), rpc)
  const claimant = claimKeyEnv === undefined ? undefined : wallet('monad-testnet', privateKeyToAccount(env(claimKeyEnv) as Hex), rpc)
  const policy = JSON.parse(readFileSync(new URL('./testnet-safe-policy.json', import.meta.url), 'utf8')) as { safe: string; owners: string[] }
  if (h.safe.toLowerCase() !== policy.safe.toLowerCase()) throw new Error('Safe differs from the reviewed testnet policy')
  await validateOwner(ctx.publicClient, h.safe, owner.account.address, policy.owners.map(getAddress))
  const out = resolve(outArg), directory = pathToFileURL(`${out}/`)
  if (existsSync(out)) {
    const info = lstatSync(out)
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw new Error('output directory must be yours with mode 700 and no symlink')
    }
  }
  ensureFlowDirectory(directory)
  const journalPath = new URL('journal.json', directory)
  const state: FlowState = existsSync(journalPath) ? parseFlowJson(readFileSync(journalPath, 'utf8')) : { binding: '', values: {}, sends: {} }
  bindMiningState(state, miningBinding(ctx.deployment, sha(readFileSync(input)), owner.account.address, epoch))
  const j = new FlowJournal(ctx, state, next => saveFlowState(directory, next), (label, hash) => console.log(`TX ${label} ${hash}`))
  const artifact = await epochFiles(ctx, j, options, { input, out, stage: selectedStage }), file = JSON.parse(artifact.bytes) as EpochFile
  epochCalls(ctx, file, epoch)
  if (claimant !== undefined && !file.claims[claimant.account.address.toLowerCase()]) throw new Error('claimant has no leaf: select a creator/worker key listed by mining:epoch')
  await runEpoch(ctx, j, owner, hash => owner.account.sign!({ hash }), file, async () => {
    const args = ['--no-env-file', 'run', 'mining:publish', artifact.path, '--stage', selectedStage]
    if (artifact.v2) args.push('--state', artifact.statePath)
    console.log(run('bun', args))
    console.log(`PUBLISHED mining/epoch-${epoch}.json sha256 ${sha(artifact.bytes)}`)
  }, claimant, epoch, { page: 1000n, logs })
}

if (import.meta.main) await main().catch(error => {
  // Never expose an RPC exception/URL, request body, signed bytes or key.
  const message = error instanceof Error ? error.message : ''
  console.error(`mining testnet refused: ${/^(usage:|epoch |prices |set |journal |output |key |claimant |wrong epoch|testnet only|use the launch)/.test(message) ? message : 'operation unavailable; inspect the private journal and reconcile before retrying'}`)
  process.exitCode = error instanceof EpochNotEnded ? 4 : 1
})
