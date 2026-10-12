/** Testnet live matrix money paths. Every send goes through the persisted journal; this module never deploys. */
import { type Address, parseUnits } from 'viem'
import * as sdk from './index.ts'
import { FlowJournal } from './flow-journal.ts'
import { verifyJobEconomics, verifyOwedWithdrawal } from './v1-flow-economics.ts'
import { v1FlowActions } from './v1-flow-actions.ts'
import { isDelegatedStakeFlow, runDelegatedStakeFlow } from './v1-flow-delegated-stake.ts'

export const V1_CORE_FLOWS = [
  'hire',
  'silence',
  'ruling-worker',
  'ruling-worker-slash',
  'ruling-creator',
  'ruling-creator-slash',
  'violation',
  'missed',
  'cancel',
  'arbitration-timeout',
  'topup-paid',
  'topup-refund',
  'stake-cooldown',
  'delegate',
  'slash-pro-rata',
  'undelegate-pending-slash',
  'fees',
] as const
export type V1CoreFlow = (typeof V1_CORE_FLOWS)[number]
/** A scheduled chain wait leaves the same case resumable without claiming it completed. */
export class FlowWaiting extends Error {
  constructor(
    readonly label: string,
    readonly timestamp: number,
  ) {
    super(`${label} is waiting for chain time ${timestamp}`)
  }
}
export interface V1FlowDeps {
  ctx: sdk.Ctx
  journal: FlowJournal
  creator: sdk.Wallet
  worker: sdk.Wallet
  relay: sdk.Wallet
  arbitrator: sdk.Wallet
  agentId: bigint
  token: Address
  reward: bigint
  bond: bigint
  waitUntil: (label: string, timestamp: number) => Promise<void>
  log: (text: string) => void
  refusingToken?: { owner: sdk.Wallet; kind: 'blocklist' | 'gasBurner' }
}
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const check = (
  what: string,
  actual: bigint | number | string | boolean,
  expected: bigint | number | string | boolean,
) => {
  if (actual !== expected) throw new Error(`${what}: got ${String(actual)}, expected ${String(expected)}`)
}

export async function runV1CoreFlow(d: V1FlowDeps, flow: V1CoreFlow, scope = flow as string) {
  const { ctx, creator, worker, relay, journal: j } = d,
    h = ctx.deployment.sidequest
  if (
    ctx.deployment.chainId !== 10143 ||
    (await ctx.publicClient.getChainId()) !== 10143 ||
    ctx.stack.kind !== 'sidequest-v1' ||
    h === null
  )
    throw new Error('v1 flows require deployed Sidequest on chain 10143')
  if (j.state.values[`${scope}/done`] === true) {
    d.log(`${scope}: already verified; no sends`)
    return
  }
  const { receipts, now, call, approve, publish, activate, submit, settle } = v1FlowActions(d, flow, scope)
  const waitForSettlement = (target: number) => d.waitUntil(flow, target)
  if (isDelegatedStakeFlow(flow)) {
    await runDelegatedStakeFlow(d, flow, scope)
    j.state.values[`${scope}/done`] = true
    j.save(j.state)
    d.log(`${scope}: verified`)
    return
  }

  if (flow === 'stake-cooldown') {
    const amount = parseUnits('1', 18)
    const shares = await j.once(`${scope}/shares`, () =>
      sdk.undelegationShares(ctx, worker.account.address, worker.account.address, amount),
    )
    await call('request-unstake', worker, h.vault, sdk.stakeVaultAbi, 'requestUndelegate', [
      worker.account.address,
      shares,
    ])
    const unlock = await j.once(
      `${scope}/unlock`,
      async () => (await sdk.getPosition(ctx, worker.account.address, worker.account.address)).unlockAt,
    )
    await d.waitUntil(flow, unlock)
    await call('withdraw', worker, h.vault, sdk.stakeVaultAbi, 'withdraw', [worker.account.address])
    check(
      'cooldown amount withdrawn',
      (await sdk.getPosition(ctx, worker.account.address, worker.account.address)).queuedShares,
      0n,
    )
  } else {
    if (flow === 'fees') {
      const { tiers, staked } = await j.once(`${scope}/tier-input`, async () => ({
        tiers: await ctx.publicClient.readContract({
          address: h.feeSchedule,
          abi: sdk.feeScheduleAbi,
          functionName: 'schedule',
        }),
        staked: (await sdk.getBacking(ctx, worker.account.address)).active,
      }))
      if (staked >= tiers.thresholds[1])
        throw new Error('fees needs a worker below the second fee tier; use a fresh journal/wallet')
      // One completed job below the threshold; the second snapshots the new tier after stake increases.
      await runV1CoreFlow(d, 'hire', `${scope}/low`)
      const low = await sdk.getV1Listing(ctx, j.state.values[`${scope}/low/jobId`] as bigint)
      check('first fee tier snapshots', low.feeBps, tiers.bps[0])
      const amount = tiers.thresholds[1] - staked
      await approve('approve-stake', worker, h.factory, h.vault, amount)
      await call('stake-tier', worker, h.vault, sdk.stakeVaultAbi, 'delegate', [worker.account.address, amount])
    }
    const x = await publish(),
      jobId = x.jobId
    let net = 0n,
      paid = false,
      slashWorker = false,
      slashCreator = false
    if (flow === 'cancel')
      await call('cancel', creator, ctx.stack.holding, sdk.sidequestHoldingAbi, 'cancel', [jobId], sdk.V1_GAS.cancel)
    else {
      net = await activate(x)
      if (flow === 'topup-paid' || flow === 'topup-refund') {
        await approve('approve-topup', creator, x.p.token, ctx.stack.holding, d.reward / 2n)
        await call('topup', creator, ctx.stack.holding, sdk.sidequestHoldingAbi, 'topUp', [jobId, d.reward / 2n])
      }
      if (flow === 'missed') {
        await waitForSettlement(x.p.deliveryDeadline + 1)
        await call(
          'missed',
          relay,
          ctx.stack.evaluator,
          sdk.sidequestEvaluatorAbi,
          'rejectAfterDeliveryDeadline',
          [jobId],
          sdk.V1_GAS.evaluator,
        )
        slashWorker = true
      } else {
        await submit(jobId)
        if (flow.startsWith('ruling-') || ['violation', 'arbitration-timeout', 'topup-refund'].includes(flow)) {
          const violation = flow === 'topup-refund' ? 0 : 1
          await call('reject', creator, ctx.stack.evaluator, sdk.sidequestEvaluatorAbi, 'reject', [
            jobId,
            violation,
            sdk.hashText(`rejected:${flow}`),
          ])
          if (flow === 'violation' || flow === 'topup-refund') {
            const at = Number(
              await ctx.publicClient.readContract({
                address: ctx.stack.evaluator,
                abi: sdk.sidequestEvaluatorAbi,
                functionName: 'rejectedAt',
                args: [jobId],
              }),
            )
            await waitForSettlement(at + x.p.disputeWindow + 1)
            await call(
              'final-rejection',
              relay,
              ctx.stack.evaluator,
              sdk.sidequestEvaluatorAbi,
              'rejectAfterWindow',
              [jobId],
              sdk.V1_GAS.evaluator,
            )
            slashWorker = violation !== 0
          } else {
            await call('dispute', worker, ctx.stack.evaluator, sdk.sidequestEvaluatorAbi, 'dispute', [jobId])
            if (flow === 'arbitration-timeout') {
              const at = Number(
                await ctx.publicClient.readContract({
                  address: ctx.stack.evaluator,
                  abi: sdk.sidequestEvaluatorAbi,
                  functionName: 'disputedAt',
                  args: [jobId],
                }),
              )
              await waitForSettlement(at + x.p.arbitrationWindow + 1)
              await call(
                'timeout',
                relay,
                ctx.stack.evaluator,
                sdk.sidequestEvaluatorAbi,
                'refundAfterArbitrationTimeout',
                [jobId],
                sdk.V1_GAS.evaluator,
              )
            } else {
              paid = flow.startsWith('ruling-worker')
              slashWorker = !paid && flow.endsWith('-slash')
              slashCreator = paid && flow.endsWith('-slash')
              const r = await j.once(`${scope}/ruling`, async () => {
                const ruling = {
                  jobId,
                  forWorker: paid,
                  slashLoser: slashWorker || slashCreator,
                  reasonHash: sdk.hashText(`ruling:${flow}`),
                  deadline: BigInt((await now()) + 3600),
                  nonce: sdk.randomNonce(),
                }
                return { ruling, signature: await sdk.signRuling(ctx, d.arbitrator, ruling) }
              })
              await call(
                'rule',
                relay,
                ctx.stack.evaluator,
                sdk.sidequestEvaluatorAbi,
                'ruleWithSignature',
                [r.ruling, r.signature],
                sdk.V1_GAS.evaluator,
              )
            }
          }
        } else if (flow === 'silence') {
          const submittedAt = Number((await sdk.getJob(ctx, jobId)).submittedAt)
          await waitForSettlement(submittedAt + x.p.reviewWindow + 1)
          await call(
            'silence',
            relay,
            ctx.stack.evaluator,
            sdk.sidequestEvaluatorAbi,
            'completeAfterSilence',
            [jobId],
            sdk.V1_GAS.evaluator,
          )
          paid = true
        } else {
          if (d.refusingToken !== undefined) {
            const { parseAbi, maxUint256 } = await import('viem')
            const abi = parseAbi([
              'function owner() view returns (address)',
              'function setBlocked(address,bool)',
              'function setHungry(address,uint256)',
            ])
            check(
              'odd token owner',
              eq(
                await ctx.publicClient.readContract({ address: d.token, abi, functionName: 'owner' }),
                d.refusingToken.owner.account.address,
              ),
              true,
            )
            await call(
              'arm-refusing-token',
              d.refusingToken.owner,
              d.token,
              abi,
              d.refusingToken.kind === 'blocklist' ? 'setBlocked' : 'setHungry',
              [worker.account.address, d.refusingToken.kind === 'blocklist' ? true : maxUint256],
            )
          }
          await call(
            'accept',
            creator,
            ctx.stack.evaluator,
            sdk.sidequestEvaluatorAbi,
            'accept',
            [jobId],
            sdk.V1_GAS.evaluator,
          )
          paid = true
          if (d.refusingToken !== undefined)
            await j.once(`${scope}/deferred-verified`, async () => {
              check('refusing payout defers the core payment', (await sdk.caseOf(ctx, jobId)).payoutDeferred, true)
              return true
            })
        }
      }
    }
    if (flow !== 'cancel') await settle(jobId)
    if (flow === 'topup-refund')
      await call(
        'topup-refund',
        creator,
        ctx.stack.holding,
        sdk.sidequestHoldingAbi,
        'claimTopUpRefund',
        [jobId, creator.account.address],
        sdk.V1_GAS.claimTopUpRefund,
      )
    const after = await sdk.getV1Listing(ctx, jobId)
    // Use the original bond event's block time: resuming after expiry does not undo a timely slash.
    const terminal = ['accept', 'rule', 'silence', 'final-rejection', 'missed', 'timeout', 'cancel', 'settle'].flatMap(
      (label) => {
        const receipt = receipts.get(label)
        return receipt === undefined ? [] : [receipt]
      },
    )
    if (x.p.creatorBond !== 0n)
      slashCreator = await sdk.bondBurnExpectation(ctx, terminal, jobId, {
        side: 0,
        penalty: slashCreator,
        expiredAt: after.expiredAt,
      })
    if (flow !== 'cancel' && x.p.workerBond !== 0n)
      slashWorker = await sdk.bondBurnExpectation(ctx, terminal, jobId, {
        side: 1,
        penalty: slashWorker,
        expiredAt: after.expiredAt,
      })
    check('settlement outcome', after.outcome, paid ? 1 : 2)
    check('creator bond settled', after.creatorBondSettled, true)
    if (flow !== 'cancel') check('worker bond settled', after.workerBondSettled, true)
    check('creator bond slash flag', after.creatorBondBurned, slashCreator)
    check('worker bond slash flag', after.workerBondBurned, slashWorker)
    const bonusFee = (after.bonus * BigInt(after.feeBps) + 9999n) / 10000n
    const workerCredit = paid ? net + after.bonus - bonusFee : 0n
    // Reconcile the original terminal receipts on every resume. Saved wallet-wide baselines from older journals
    // remain evidence, but cannot prove this job's economics after unrelated cases have changed those balances.
    verifyJobEconomics(terminal, {
      jobId,
      holding: ctx.stack.holding,
      core: ctx.deployment.core,
      vault: h.vault,
      factory: h.factory,
      token: x.p.token,
      creator: creator.account.address,
      worker: worker.account.address,
      creatorBond: x.p.creatorBond,
      workerBond: flow === 'cancel' ? 0n : x.p.workerBond,
      slashCreator,
      slashWorker,
      workerCredit,
      workerOwed: d.refusingToken === undefined ? 0n : workerCredit,
    })
    if (d.refusingToken !== undefined) {
      await j.once(`${scope}/owed-verified`, async () => {
        check(
          'exact refused reward is owed',
          await ctx.publicClient.readContract({
            address: ctx.stack.holding,
            abi: sdk.sidequestHoldingAbi,
            functionName: 'owed',
            args: [d.token, worker.account.address],
          }),
          net,
        )
        return true
      })
      const { parseAbi } = await import('viem')
      const abi = parseAbi(['function setBlocked(address,bool)', 'function setHungry(address,uint256)'])
      await call(
        'clear-refusing-token',
        d.refusingToken.owner,
        d.token,
        abi,
        d.refusingToken.kind === 'blocklist' ? 'setBlocked' : 'setHungry',
        [worker.account.address, d.refusingToken.kind === 'blocklist' ? false : 0n],
      )
      const withdrawal = await call(
        'withdraw-owed',
        worker,
        ctx.stack.holding,
        sdk.sidequestHoldingAbi,
        'withdraw',
        [d.token],
        sdk.V1_GAS.claimTopUpRefund,
      )
      verifyOwedWithdrawal(withdrawal, ctx.stack.holding, x.p.token, worker.account.address, workerCredit)
      check(
        'owed cleared',
        await ctx.publicClient.readContract({
          address: ctx.stack.holding,
          abi: sdk.sidequestHoldingAbi,
          functionName: 'owed',
          args: [d.token, worker.account.address],
        }),
        0n,
      )
    }
    if (flow === 'fees') {
      const tiers = await ctx.publicClient.readContract({
        address: h.feeSchedule,
        abi: sdk.feeScheduleAbi,
        functionName: 'schedule',
      })
      check('second fee tier snapshots', after.feeBps, tiers.bps[1])
    }
  }
  j.state.values[`${scope}/done`] = true
  j.save(j.state)
  d.log(`${scope}: verified`)
}
