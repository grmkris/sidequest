import { expect, test, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { context } from '../../packages/sdk/src/client.ts'
import config from '../config/monad-testnet.json' with { type: 'json' }
import { createPublicClient, custom, encodeFunctionResult, getAddress } from '../../scripts/mining/viem.ts'
import { epochDistributorAbi } from '../../packages/sdk/src/abi/epochDistributor.ts'
import { canonicalRuleV2 } from '../../scripts/mining/inputs-v2.ts'
import { dataHashOf } from '../../scripts/mining/compute.ts'
import { MiningLedger } from '../../scripts/mining/ledger.ts'
import { stateOf, stateHashOf } from '../../scripts/mining/state.ts'
import { ensureCheckpoint } from './mine-epoch0-testnet.ts'

const hash = `0x${'11'.repeat(32)}` as const
function checkpointFixture() {
  const base = context('monad-testnet', 'main', 'http://rpc.invalid'), h = base.deployment.sidequest!
  const holdings = Object.values(base.deployment.stacks).flatMap(stack => stack?.kind === 'sidequest-v1' ? [stack.holding] : [])
  const state = stateOf(new MiningLedger(), {
    epoch: 44n, chainId: 10143, block: h.block + 10n, blockHash: hash,
    genesisBlock: base.deployment.deployBlock < h.block ? base.deployment.deployBlock : h.block, pruneBlock: h.block,
    contracts: { holdings, vault: h.vault, identity: base.deployment.identity, feeSchedule: h.feeSchedule, reserve: h.miningReserve, distributor: h.distributor },
  })
  const inputs = { chainId: 10143, epoch: '44', rule: canonicalRuleV2(44n, BigInt(h.clocks!.unstakeDelay), false, config.usdPegged.map(getAddress)),
    window: { toBlock: state.block, toBlockHash: hash }, holdings: state.contracts.holdings, checkpoint: { previous: null, stateHash: stateHashOf(state) } }
  const dataHash = dataHashOf(inputs), artifact = { rule: 2, epoch: '44', chainId: 10143, inputs, dataHash }
  const bytes = { 'mining/epoch-44.json': Buffer.from(JSON.stringify(artifact)), 'mining/state-44.json': Buffer.from(JSON.stringify(state)) }
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_call') return encodeFunctionResult({ abi: epochDistributorAbi, functionName: 'rootOf', result: { root: hash, total: 1n, claimed: 0n, dataHash } })
    if (method === 'eth_getBlockByNumber') return { hash, number: `0x${BigInt(state.block).toString(16)}`, timestamp: '0x1', transactions: [] }
    throw new Error(`unexpected method ${method}`)
  })
  const ctx = { ...base, publicClient: createPublicClient({ transport: custom({ request }) }) }
  const get = vi.fn(async (_bucket: string, key: string) => {
    if (key === 'mining/epoch-44.json') return bytes['mining/epoch-44.json']
    if (key === 'mining/state-44.json') return bytes['mining/state-44.json']
    throw new Error('unexpected key')
  })
  const bucket = vi.fn(async () => 'reviewed-bucket'), store = { get, bucket, put: async () => { throw new Error('read-only checkpoint store') } }
  return { ctx, bytes, get, bucket, store, state, artifact }
}

test('fetches and verifies both missing checkpoint files, preserving bytes and reusing the local pair', async () => {
  const f = checkpointFixture(), out = mkdtempSync(join(tmpdir(), 'testnet-mining-checkpoint-'))
  try {
    const makeStore = vi.fn(() => f.store)
    await ensureCheckpoint(f.ctx, 45n, out, 'dev', makeStore)
    expect(f.get.mock.calls).toEqual([['reviewed-bucket', 'mining/epoch-44.json'], ['reviewed-bucket', 'mining/state-44.json']])
    expect(readFileSync(join(out, 'epoch-44.json'))).toEqual(f.bytes['mining/epoch-44.json'])
    expect(readFileSync(join(out, 'state-44.json'))).toEqual(f.bytes['mining/state-44.json'])
    await ensureCheckpoint(f.ctx, 45n, out, 'dev', makeStore)
    expect(makeStore).toHaveBeenCalledTimes(1)
  } finally { rmSync(out, { recursive: true, force: true }) }
})

test('a fetched input hash that differs from rootOf refuses before caching either file', async () => {
  const f = checkpointFixture(), out = mkdtempSync(join(tmpdir(), 'testnet-mining-checkpoint-'))
  f.bytes['mining/epoch-44.json'] = Buffer.from(JSON.stringify({ ...f.artifact, inputs: { ...f.artifact.inputs, epoch: '43' } }))
  try {
    await expect(ensureCheckpoint(f.ctx, 45n, out, 'dev', () => f.store)).rejects.toThrow('dataHash mismatch')
    expect(existsSync(join(out, 'epoch-44.json'))).toBe(false)
    expect(existsSync(join(out, 'state-44.json'))).toBe(false)
  } finally { rmSync(out, { recursive: true, force: true }) }
})

test('a fetched state that differs from the committed state hash refuses before caching', async () => {
  const f = checkpointFixture(), out = mkdtempSync(join(tmpdir(), 'testnet-mining-checkpoint-'))
  f.bytes['mining/state-44.json'] = Buffer.from(JSON.stringify({ ...f.state, shares: { ...f.state.shares, pruneBlock: '1' } }))
  try {
    await expect(ensureCheckpoint(f.ctx, 45n, out, 'dev', () => f.store)).rejects.toThrow('stateHash mismatch')
    expect(existsSync(join(out, 'state-44.json'))).toBe(false)
  } finally { rmSync(out, { recursive: true, force: true }) }
})
