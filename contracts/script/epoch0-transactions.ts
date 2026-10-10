import { FlowJournal } from '../../packages/sdk/src/flow-journal.ts'
import type { Ctx, Wallet } from '../../packages/sdk/src/actions.ts'
import { epochDistributorAbi } from '../../packages/sdk/src/abi/epochDistributor.ts'
import { stakeVaultAbi } from '../../packages/sdk/src/abi/stakeVault.ts'
import { budgetOf, reserveAbi, type LogPager } from '../../scripts/mining/chain.ts'
import { decodeEventLog, encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex, type TransactionReceipt } from '../../scripts/mining/viem.ts'

export const safeEpochAbi = parseAbi([
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)',
  'function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns (bool)',
  'event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)',
  'event ExecutionFailure(bytes32 indexed txHash,uint256 payment)',
])
export interface EpochFile {
  chainId: number; epoch: string; root: Hex; total: string; dataHash: Hex
  claims: Record<string, { amount: string; proof: Hex[] }>
  calls: { fund?: { to: Address; data: Hex; expect: { totalFunded: string; fundedForEpoch: string } }; setRoot: { to: Address; data: Hex } }
}
/** Existing integrations may retain the epoch-0 type name. */
export type Epoch0File = EpochFile
type Draft = { nonce: bigint; totalFunded: bigint; fundedThis: bigint; hash: Hex; data: Hex }
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** One immutable draft and one outer signed transaction per operation; no nonce refresh on retry. */
export async function safeEpochCall(ctx: Ctx, j: FlowJournal, owner: Wallet, signHash: (hash: Hex) => Promise<Hex>,
  name: 'fund' | 'setRoot', to: Address, data: Hex, expect?: NonNullable<EpochFile['calls']['fund']>['expect'], epoch = 0n, pager: LogPager = { page: 1000n }) {
  const h = ctx.deployment.sidequest!
  const key = `epoch${epoch}/${name}`
  const checkReceipt = (receipt: TransactionReceipt, hash: Hex) => {
    // Safe can emit ExecutionFailure in an outer transaction with status=1.
    const success = receipt.logs.some(log => {
      if (!equal(log.address, h.safe)) return false
      try {
        const decoded = decodeEventLog({ abi: safeEpochAbi, topics: log.topics, data: log.data })
        return decoded.eventName === 'ExecutionSuccess' && equal(decoded.args.txHash, hash)
      } catch { return false }
    })
    if (!success) throw new Error(`${name}: Safe did not emit ExecutionSuccess; do not create another operation`)
  }
  const mined = await j.mined(key)
  if (mined) {
    const draft = j.state.values[`${key}/draft`] as Draft
    checkReceipt(mined, draft.hash)
    j.log(key, mined.transactionHash)
    return
  }
  const draft = await j.once<Draft>(`${key}/draft`, async () => {
    const block = await ctx.publicClient.getBlockNumber({ cacheTime: 0 })
    // Reserve exposes no per-epoch funding getter. Sum EpochFunded through this
    // same block; Safe.nonce and totalFunded are pinned to it (D18).
    const budget = await budgetOf(ctx.publicClient, h.miningReserve, epoch, h.block, block, pager)
    const nonce = await ctx.publicClient.readContract({ address: h.safe, abi: safeEpochAbi, functionName: 'nonce', blockNumber: block })
    if (expect && (budget.totalFunded !== BigInt(expect.totalFunded) || budget.fundedThis !== BigInt(expect.fundedForEpoch))) {
      throw new Error('fund snapshot changed: recompute the epoch before creating a new operation')
    }
    const hash = await ctx.publicClient.readContract({ address: h.safe, abi: safeEpochAbi, functionName: 'getTransactionHash',
      args: [to, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce], blockNumber: block })
    const signature = await signHash(hash)
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature) || !['1b', '1c'].includes(signature.slice(-2).toLowerCase())) {
      throw new Error('Safe signature must be ECDSA v=27/28, never pre-validated')
    }
    return { nonce, totalFunded: budget.totalFunded, fundedThis: budget.fundedThis, hash,
      data: encodeFunctionData({ abi: safeEpochAbi, functionName: 'execTransaction',
        args: [to, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signature] }) }
  })
  const block = await ctx.publicClient.getBlockNumber({ cacheTime: 0 })
  const nonce = await ctx.publicClient.readContract({ address: h.safe, abi: safeEpochAbi, functionName: 'nonce', blockNumber: block })
  const total = await ctx.publicClient.readContract({ address: h.miningReserve, abi: reserveAbi, functionName: 'totalFunded', blockNumber: block })
  if (nonce !== draft.nonce || (name === 'fund' && total !== draft.totalFunded)) {
    throw new Error(`${name}: draft snapshot moved; reconcile the saved hash, never re-sign at a later nonce`)
  }
  const receipt = await j.send(key, owner, { to: h.safe, data: draft.data, value: '0' })
  checkReceipt(receipt, draft.hash)
}

/** Validate destinations/calldata independently of the file's claims proof validator. */
export function epochCalls(ctx: Ctx, file: EpochFile, epoch = 0n) {
  const h = ctx.deployment.sidequest!
  if (ctx.deployment.chainId !== 10143 || file.chainId !== 10143 || file.epoch !== epoch.toString()) throw new Error('selected epoch testnet only')
  const rootData = encodeFunctionData({ abi: epochDistributorAbi, functionName: 'setRoot', args: [epoch, file.root, BigInt(file.total), file.dataHash] })
  if (!equal(file.calls.setRoot.to, h.distributor) || !equal(file.calls.setRoot.data, rootData)) throw new Error('setRoot calldata mismatch')
  if (file.calls.fund) {
    const f = file.calls.fund, funded = BigInt(f.expect.fundedForEpoch), amount = BigInt(file.total) - funded
    if (amount <= 0n || BigInt(f.expect.totalFunded) < funded) throw new Error('fund snapshot/amount mismatch')
    const fundData = encodeFunctionData({ abi: reserveAbi, functionName: 'fund', args: [epoch, amount] })
    if (!equal(f.to, h.miningReserve) || !equal(f.data, fundData)) throw new Error('fund calldata mismatch')
  }
}

export async function runEpoch(ctx: Ctx, j: FlowJournal, owner: Wallet, signHash: (hash: Hex) => Promise<Hex>,
  file: EpochFile, publish: () => Promise<void>, claimant?: Wallet, epoch = 0n, pager: LogPager = { page: 1000n }) {
  epochCalls(ctx, file, epoch)
  if (await ctx.publicClient.getChainId() !== 10143) throw new Error('RPC is not Monad testnet')
  const h = ctx.deployment.sidequest!
  if (file.calls.fund) {
    const f = file.calls.fund
    await safeEpochCall(ctx, j, owner, signHash, 'fund', f.to, f.data, f.expect, epoch, pager)
  }
  const rootBefore = await ctx.publicClient.readContract({ address: h.distributor, abi: epochDistributorAbi, functionName: 'rootOf', args: [epoch] })
  if (!equal(rootBefore.root, file.root) || rootBefore.total !== BigInt(file.total) || !equal(rootBefore.dataHash, file.dataHash)) {
    await safeEpochCall(ctx, j, owner, signHash, 'setRoot', h.distributor, file.calls.setRoot.data, undefined, epoch, pager)
  } else if (j.state.sends[`epoch${epoch}/setRoot`]) {
    const receipt = await j.mined(`epoch${epoch}/setRoot`)
    if (!receipt) throw new Error('root matches but the saved setRoot transaction is unconfirmed: reconcile first')
    j.log(`epoch${epoch}/setRoot`, receipt.transactionHash)
  }
  const root = await ctx.publicClient.readContract({ address: h.distributor, abi: epochDistributorAbi, functionName: 'rootOf', args: [epoch] })
  if (!equal(root.root, file.root) || root.total !== BigInt(file.total) || !equal(root.dataHash, file.dataHash)) throw new Error('root readback mismatch')
  // Repeat the idempotent same-byte upload/readback on resume; a saved boolean
  // is never evidence that the current hosted object is still the same.
  await publish()
  if (claimant === undefined) return
  const account = claimant.account.address, claim = file.claims[account.toLowerCase()]
  if (!claim) throw new Error('claimant has no leaf in this epoch')
  const claimKey = `epoch${epoch}/claim/${account.toLowerCase()}`
  const claimed = () => ctx.publicClient.readContract({ address: h.distributor, abi: epochDistributorAbi, functionName: 'isClaimed', args: [epoch, account] })
  if (await claimed()) {
    const receipt = await j.mined(claimKey)
    if (!receipt) throw new Error('claim already happened outside this journal: inspect its receipt and stake')
    j.log(claimKey, receipt.transactionHash)
    return
  }
  const staked = await j.once(`${claimKey}/stakeBefore`, () => ctx.publicClient.readContract({ address: h.vault, abi: stakeVaultAbi, functionName: 'stakeOf', args: [account] }))
  await j.contract(claimKey, claimant, h.distributor, epochDistributorAbi, 'claim', [epoch, account, BigInt(claim.amount), claim.proof])
  const after = await ctx.publicClient.readContract({ address: h.vault, abi: stakeVaultAbi, functionName: 'stakeOf', args: [account] })
  if (!await claimed() || after !== staked + BigInt(claim.amount)) throw new Error('claim/stake readback mismatch')
  console.log(`PASS claim stake increased by ${claim.amount} SIDE wei for ${account}`)
}

/** Compatibility entry point: existing epoch-0 callers keep their journal keys and calldata. */
export async function runEpoch0(ctx: Ctx, j: FlowJournal, owner: Wallet, signHash: (hash: Hex) => Promise<Hex>,
  file: EpochFile, publish: () => Promise<void>, claimant?: Wallet) {
  return runEpoch(ctx, j, owner, signHash, file, publish, claimant, 0n)
}
