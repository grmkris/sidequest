/** Discovery comes from a checked index; every claim and amount below is re-read from the chain. */
import * as sdk from '@sidequest/sdk'
import { type Address, encodeFunctionData } from 'viem'
import { holdingAbi, settleSidequest, transaction } from './sidequest.ts'

export interface CollectSnapshot {
  jobs: Array<{ jobId: string; holding: string }>
  tokens: Array<{ holding: string; token: string }>
  positions?: sdk.DelegationCandidate[]
}
export interface CollectAction {
  kind: 'settle' | 'claimTopUpRefund' | 'withdraw' | 'claimRefund' | 'stakeWithdraw'
  jobId?: string | null
  token?: string | null
  amount?: string | null
  account?: Address
  description: string
  transactions: sdk.TxRequest[]
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export async function collectActions(
  base: sdk.Ctx,
  wallet: Address,
  snapshot: CollectSnapshot,
): Promise<CollectAction[]> {
  const block = await base.publicClient.getBlock()
  const now = Number(block.timestamp)
  const out: CollectAction[] = [],
    tokens = new Map<string, { ctx: sdk.Ctx; token: Address }>()
  const pair = (holding: string): sdk.Ctx => {
    const entry = sdk.stackByHolding(base.deployment, holding)
    if (entry === undefined) throw new Error('the collect index references an unknown Holding')
    return { ...base, stack: entry[1] }
  }
  const addToken = (ctx: sdk.Ctx, token: Address) =>
    tokens.set(`${ctx.stack.holding.toLowerCase()}:${token.toLowerCase()}`, { ctx, token })
  for (const t of snapshot.tokens) addToken(pair(t.holding), t.token as Address)
  const jobs = new Set<string>()
  for (const candidate of snapshot.jobs) {
    if (jobs.has(candidate.jobId)) continue
    jobs.add(candidate.jobId)
    const ctx = pair(candidate.holding),
      jobId = BigInt(candidate.jobId)
    const [job, listing] = await Promise.all([sdk.getJob(ctx, jobId), sdk.getListing(ctx, jobId)])
    if (!same(job.client, ctx.stack.holding))
      throw new Error('the collect index does not match the canonical job Holding')
    if (ctx.stack.openTokens) addToken(ctx, listing.token)
    const contribution = await ctx.publicClient.readContract({
      address: ctx.stack.holding,
      abi: sdk.sidequestHoldingAbi,
      functionName: 'topUpOf',
      args: [jobId, wallet],
    })
    const party = [listing.creator, listing.approver, listing.worker].some((a) => same(a, wallet))
    if (party || contribution > 0n) {
      const transactions = await settleSidequest(ctx, jobId, undefined, now)
      if (transactions.length > 0)
        out.push({
          kind: 'settle',
          jobId: candidate.jobId,
          description: 'Finalize and settle this job under its agreed outcome.',
          transactions,
        })
      else if (['Open', 'Funded', 'Submitted'].includes(job.statusName) && now >= job.expiredAt) {
        // The core's own claim cutoff and pending-claim restrictions remain authoritative.
        const paused = await ctx.publicClient.readContract({
          address: ctx.deployment.core,
          abi: sdk.coreAbi,
          functionName: 'paused',
        })
        const grace =
          job.statusName === 'Submitted'
            ? Number(
                await ctx.publicClient.readContract({
                  address: ctx.deployment.core,
                  abi: sdk.coreAbi,
                  functionName: 'EVALUATION_GRACE_PERIOD',
                }),
              )
            : 0
        const pending = await ctx.publicClient.readContract({
          address: ctx.deployment.core,
          abi: sdk.coreAbi,
          functionName: 'pendingClaimHash',
          args: [jobId],
        })
        if (!paused && now >= job.expiredAt + grace && (job.statusName === 'Submitted' || /^0x0+$/.test(pending)))
          out.push({
            kind: 'claimRefund',
            jobId: candidate.jobId,
            description: 'Claim the expired core refund and settle the agreed payment rights.',
            transactions: [
              transaction(
                ctx,
                'Claim the expired core refund',
                ctx.deployment.core,
                encodeFunctionData({ abi: sdk.coreAbi, functionName: 'claimRefund', args: [jobId] }),
              ),
              transaction(
                ctx,
                'Settle the agreed reward and bonds',
                ctx.stack.holding,
                encodeFunctionData({ abi: holdingAbi(ctx), functionName: 'settle', args: [jobId] }),
                sdk.V1_GAS.settle,
              ),
            ],
          })
      }
    }
    {
      const v1 = await sdk.getV1Listing(ctx, jobId)
      if (v1.outcome === 2 && contribution > 0n)
        out.push({
          kind: 'claimTopUpRefund',
          jobId: candidate.jobId,
          token: listing.token,
          amount: contribution.toString(),
          description: 'Collect your contribution to this refunded job.',
          transactions: [sdk.topUpRefundTransaction(ctx, jobId, wallet)],
        })
    }
  }
  for (const { ctx, token } of tokens.values()) {
    const owed = await ctx.publicClient.readContract({
      address: ctx.stack.holding,
      abi: holdingAbi(ctx),
      functionName: 'owed',
      args: [token, wallet],
    })
    if (owed > 0n)
      out.push({
        kind: 'withdraw',
        token,
        amount: owed.toString(),
        description: 'Withdraw the token payment held for your wallet.',
        transactions: [
          transaction(
            ctx,
            'Withdraw the refused token payout',
            ctx.stack.holding,
            encodeFunctionData({ abi: holdingAbi(ctx), functionName: 'withdraw', args: [token] }),
            450_000n,
          ),
        ],
      })
  }
  if (base.deployment.sidequest !== null) {
    const h = base.deployment.sidequest
    const candidates = snapshot.positions ?? [{ account: wallet, delegator: wallet, generation: 0n }]
    for (const candidate of candidates) {
      if (!same(candidate.delegator, wallet)) throw new Error('the collect index references another position owner')
      const [position, backing] = await Promise.all([
        sdk.getPosition(base, candidate.account, wallet, {
          blockNumber: block.number,
          knownGeneration: candidate.generation,
        }),
        sdk.getBacking(base, candidate.account, { blockNumber: block.number }),
      ])
      if (
        position.queuedShares > 0n &&
        now >= position.unlockAt &&
        backing.assets - position.queued >= backing.reserved
      ) {
        out.push({
          kind: 'stakeWithdraw',
          account: candidate.account,
          token: h.factory,
          amount: position.queued.toString(),
          description: 'Withdraw your queued position after cooldown and bond release.',
          transactions: [
            transaction(
              base,
              'Withdraw the wallet-owned position',
              h.vault,
              encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'withdraw', args: [candidate.account] }),
            ),
          ],
        })
      }
    }
  }
  return out
}
