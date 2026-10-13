import { erc20Abi } from 'viem'
/** Delegated-stake matrix cases, using real jobs and the same durable send journal as every other flow. */
import { BaseError, ContractFunctionRevertedError, decodeEventLog } from 'viem'
import * as sdk from './index.ts'
import { v1FlowActions } from './v1-flow-actions.ts'
import { verifyJobEconomics } from './v1-flow-economics.ts'
import type { V1FlowDeps } from './v1-flows.ts'

const names = ['delegate', 'slash-pro-rata', 'undelegate-pending-slash'] as const
export type DelegatedStakeFlow = (typeof names)[number]
export function isDelegatedStakeFlow(flow: string): flow is DelegatedStakeFlow {
  return (names as readonly string[]).includes(flow)
}

function exact(label: string, actual: bigint | number | boolean, expected: bigint | number | boolean) {
  if (actual !== expected) throw new Error(`${label}: got ${actual}, expected ${expected}`)
}
function withinWei(label: string, actual: bigint, expected: bigint) {
  const difference = actual > expected ? actual - expected : expected - actual
  if (difference > 1n) throw new Error(`${label}: got ${actual}, expected ${expected} within 1 wei`)
}
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const max = (a: bigint, b: bigint) => (a > b ? a : b)

export async function runDelegatedStakeFlow(d: V1FlowDeps, flow: DelegatedStakeFlow, scope: string) {
  const { ctx, journal: j, creator, worker, relay } = d
  const h = ctx.deployment.sidequest!
  const actions = v1FlowActions(d, flow, scope)
  const { call, approve } = actions
  const wallets = { creator, relay, worker }
  type Role = keyof typeof wallets

  async function snapshot(blockNumber?: bigint) {
    const block = blockNumber ?? (await ctx.publicClient.getBlockNumber({ cacheTime: 0 }))
    const pool = await sdk.getBacking(ctx, worker.account.address, { blockNumber: block })
    const positions = {} as Record<Role, Awaited<ReturnType<typeof sdk.getPosition>>>
    for (const role of ['creator', 'relay', 'worker'] as const) {
      positions[role] = await sdk.getPosition(ctx, worker.account.address, wallets[role].account.address, {
        blockNumber: block,
      })
    }
    return { pool, positions }
  }

  const input = await j.once(`${scope}/inputs`, async () => {
    if (d.bond <= 0n) throw new Error('delegated flows require a positive bond')
    if (new Set([creator, worker, relay].map((w) => w.account.address.toLowerCase())).size !== 3)
      throw new Error('delegated flows require distinct creator, worker and relay wallets')
    const before = await snapshot()
    exact('worker pool has no pre-existing reservations', before.pool.reserved, 0n)
    exact('worker pool has no pre-existing exit queue', before.pool.queuedShares, 0n)
    exact('the initial backing belongs to the worker', before.pool.shares, before.positions.worker.shares)
    for (const role of ['creator', 'relay'] as const)
      exact(`${role} has no pre-existing position in this worker pool`, before.positions[role].shares, 0n)
    const tierAmount =
      before.pool.tier.nextThreshold === null ? 0n : before.pool.tier.nextThreshold - before.pool.active
    const amount = flow === 'delegate' ? max(tierAmount, 2n * d.bond) : 3n * d.bond + 2n
    const delay = await ctx.publicClient.readContract({
      address: h.vault,
      abi: sdk.stakeVaultAbi,
      functionName: 'UNSTAKE_DELAY',
    })
    return { before, amount, delay }
  })

  async function deposit(role: Role, amount: bigint) {
    const wallet = wallets[role]
    await approve(`approve-${role}`, wallet, h.factory, h.vault, amount)
    const receipt = await call(`delegate-${role}`, wallet, h.vault, sdk.stakeVaultAbi, 'delegate', [
      worker.account.address,
      amount,
    ])
    return j.once(`${scope}/deposit-${role}-verified`, async () => {
      const events = receipt.logs
        .filter((log) => sameAddress(log.address, h.vault))
        .flatMap((log) => {
          try {
            const event = decodeEventLog({ abi: sdk.stakeVaultAbi, topics: log.topics, data: log.data })
            return event.eventName === 'Delegated' ? [event.args] : []
          } catch {
            return []
          }
        })
      if (events.length !== 1) throw new Error('delegation needs exactly one canonical Delegated event')
      const event = events[0]!
      exact('delegation account', sameAddress(event.account, worker.account.address), true)
      exact('delegation owner', sameAddress(event.delegator, wallet.account.address), true)
      exact('delegation payer', sameAddress(event.payer, wallet.account.address), true)
      exact('delegation inflow', event.assets, amount)
      if (event.shares <= 0n) throw new Error('delegation minted no owned shares')
      const position = await sdk.getPosition(ctx, worker.account.address, wallet.account.address, {
        blockNumber: receipt.blockNumber,
      })
      if (role !== 'worker') exact('outside delegator owns the minted shares', position.shares, event.shares)
      return { ...event, position }
    })
  }

  const firstAmount = flow === 'slash-pro-rata' ? 2n * d.bond + 1n : input.amount
  await deposit('creator', firstAmount)
  if (flow === 'slash-pro-rata') {
    // The relay is the second outside owner; reuse its existing key and persist its funding before broadcast.
    await call('fund-relay', creator, h.factory, erc20Abi, 'transfer', [relay.account.address, input.amount])
    await deposit('relay', input.amount)
    await deposit('worker', d.bond + 3n)
  }

  const prepared = await j.once(`${scope}/prepared`, () => snapshot())
  const workerBond = flow === 'delegate' ? prepared.positions.worker.activeValue + d.bond : d.bond
  if (flow === 'delegate' && workerBond <= prepared.positions.worker.activeValue)
    throw new Error('delegate must require backing the worker does not own')
  const job = await actions.publish(ctx, { workerBond })
  const net = await actions.activate(job)
  await j.once(`${scope}/activation-verified`, async () => {
    const receipt = actions.receipts.get('activate')!
    const listing = await ctx.publicClient.readContract({
      address: ctx.stack.holding,
      abi: sdk.sidequestHoldingAbi,
      functionName: 'getListing',
      args: [job.jobId],
      blockNumber: receipt.blockNumber,
    })
    const active = await snapshot(receipt.blockNumber)
    exact('delegated backing sets the frozen fee tier', listing.feeBps, active.pool.tier.feeBps)
    exact('activation reserves the requested bond', active.pool.reserved, workerBond)
    if (flow !== 'slash-pro-rata')
      exact(
        'worker self position does not grow when outsiders delegate',
        prepared.positions.worker.shares,
        input.before.positions.worker.shares,
      )
    return {
      feeBps: listing.feeBps,
      workerBond,
      selfValue: prepared.positions.worker.activeValue,
      backing: active.pool.active,
    }
  })

  const guard = v1FlowActions(d, flow, `${scope}/guard`)
  const guardBond = input.before.pool.assets + 1n
  let guardedJob: Awaited<ReturnType<typeof guard.publish>> | undefined
  let guardedNet = 0n
  if (flow === 'undelegate-pending-slash') {
    guardedJob = await guard.publish(ctx, { workerBond: guardBond })
    guardedNet = await guard.activate(guardedJob)
  }

  async function queue(role: 'creator' | 'relay') {
    const shares = await j.once(`${scope}/queue-${role}-shares`, async () => {
      const blockNumber = await ctx.publicClient.getBlockNumber({ cacheTime: 0 })
      const position = await sdk.getPosition(ctx, worker.account.address, wallets[role].account.address, {
        blockNumber,
      })
      return sdk.undelegationShares(ctx, worker.account.address, wallets[role].account.address, position.activeValue)
    })
    const receipt = await call(`request-${role}`, wallets[role], h.vault, sdk.stakeVaultAbi, 'requestUndelegate', [
      worker.account.address,
      shares,
    ])
    return j.once(`${scope}/queue-${role}`, async () => {
      const position = await sdk.getPosition(ctx, worker.account.address, wallets[role].account.address, {
        blockNumber: receipt.blockNumber,
      })
      exact('whole owned position is queued', position.queuedShares, shares)
      exact('queued position retains every share', position.shares, shares)
      const requestedAt = Number((await ctx.publicClient.getBlock({ blockNumber: receipt.blockNumber })).timestamp)
      exact('the queue uses the deployed unstake clock', position.unlockAt, requestedAt + input.delay)
      return position
    })
  }

  async function cooldownLocked(label: string) {
    return j.once(`${scope}/${label}`, async () => {
      let blocked: { unlockAt: number; reserved: bigint } | undefined
      try {
        await ctx.publicClient.simulateContract({
          account: creator.account,
          address: h.vault,
          abi: sdk.stakeVaultAbi,
          functionName: 'withdraw',
          args: [worker.account.address],
        })
      } catch (error) {
        const cause =
          error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : undefined
        if (!(cause instanceof ContractFunctionRevertedError) || cause.data?.errorName !== 'UndelegateLocked')
          throw new Error('withdraw must refuse with UndelegateLocked before the cooldown ends', { cause: error })
        const args = cause.data.args as readonly [number]
        const before = await snapshot()
        blocked = { unlockAt: args[0], reserved: before.pool.reserved }
      }
      if (blocked === undefined) throw new Error('queued backing escaped its open bonds')
      return blocked
    })
  }

  if (flow === 'undelegate-pending-slash') {
    const queued = await queue('creator')
    const listing = await sdk.getV1Listing(ctx, job.jobId)
    if (listing.expiredAt > queued.unlockAt) throw new Error('a pre-exit bond outlasts its unlock time')
    await cooldownLocked('blocked-before-slash')
  }

  await actions.submit(job.jobId)
  if (flow === 'delegate') {
    await call(
      'accept',
      creator,
      ctx.stack.evaluator,
      sdk.sidequestEvaluatorAbi,
      'accept',
      [job.jobId],
      sdk.V1_GAS.evaluator,
    )
  } else {
    await call('reject', creator, ctx.stack.evaluator, sdk.sidequestEvaluatorAbi, 'reject', [
      job.jobId,
      1,
      sdk.hashText(`${scope}:quality`),
    ])
    await call('dispute', worker, ctx.stack.evaluator, sdk.sidequestEvaluatorAbi, 'dispute', [job.jobId])
    const before = await j.once(`${scope}/slash-before`, () => snapshot())
    const signed = await j.once(`${scope}/ruling`, async () => {
      const ruling = {
        jobId: job.jobId,
        forWorker: false,
        slashLoser: true,
        reasonHash: sdk.hashText(`${scope}:slash`),
        deadline: BigInt((await actions.now()) + 3600),
        nonce: sdk.randomNonce(),
      }
      return { ruling, signature: await sdk.signRuling(ctx, d.arbitrator, ruling) }
    })
    const receipt = await call(
      'rule',
      relay,
      ctx.stack.evaluator,
      sdk.sidequestEvaluatorAbi,
      'ruleWithSignature',
      [signed.ruling, signed.signature],
      sdk.V1_GAS.evaluator,
    )
    await j.once(`${scope}/slash-verified`, async () => {
      const after = await snapshot(receipt.blockNumber)
      exact('the worker bond reduces pool assets', after.pool.assets, before.pool.assets - workerBond)
      exact('a partial slash keeps all pool shares', after.pool.shares, before.pool.shares)
      for (const role of flow === 'slash-pro-rata'
        ? (['creator', 'relay', 'worker'] as const)
        : (['creator'] as const)) {
        const a = before.positions[role],
          b = after.positions[role]
        exact(`${role} keeps ownership through the slash`, b.shares, a.shares)
        const expectedLoss = (a.shares * workerBond) / before.pool.shares
        withinWei(`${role} bears its pro-rata loss`, a.value - b.value, expectedLoss)
        if (expectedLoss === 0n) throw new Error('pro-rata case needs a measurable loss for every position')
      }
      if (flow === 'undelegate-pending-slash') {
        exact(
          'the queued shares were slashed',
          after.positions.creator.queuedShares,
          before.positions.creator.queuedShares,
        )
        exact('the second job still reserves backing', after.pool.reserved, guardBond)
      }
      return { before, after }
    })
  }
  await actions.settle(job.jobId)

  async function verifyJob(a: ReturnType<typeof v1FlowActions>, x: typeof job, credit: bigint, slash: boolean) {
    const listing = await sdk.getV1Listing(ctx, x.jobId)
    exact('worker bond settled', listing.workerBondSettled, true)
    exact('creator bond settled', listing.creatorBondSettled, true)
    exact('worker slash decision', listing.workerBondBurned, slash)
    exact('job outcome', listing.outcome, slash ? 2 : 1)
    verifyJobEconomics(
      ['accept', 'rule', 'settle'].flatMap((label) => {
        const receipt = a.receipts.get(label)
        return receipt === undefined ? [] : [receipt]
      }),
      {
        jobId: x.jobId,
        holding: ctx.stack.holding,
        core: ctx.deployment.core,
        vault: h.vault,
        factory: h.factory,
        token: x.p.token,
        creator: creator.account.address,
        worker: worker.account.address,
        creatorBond: x.p.creatorBond,
        workerBond: x.p.workerBond,
        slashCreator: false,
        slashWorker: slash,
        workerCredit: credit,
        workerOwed: 0n,
      },
    )
  }
  await verifyJob(actions, job, flow === 'delegate' ? net : 0n, flow !== 'delegate')

  if (guardedJob !== undefined) {
    await cooldownLocked('blocked-after-slash')
    await guard.submit(guardedJob.jobId)
    await guard.call(
      'accept',
      creator,
      ctx.stack.evaluator,
      sdk.sidequestEvaluatorAbi,
      'accept',
      [guardedJob.jobId],
      sdk.V1_GAS.evaluator,
    )
    await guard.settle(guardedJob.jobId)
    await verifyJob(guard, guardedJob, guardedNet, false)
    await j.once(`${scope}/guard-release-verified`, async () => {
      const after = await sdk.getBacking(ctx, worker.account.address, {
        blockNumber: guard.receipts.get('accept')!.blockNumber,
      })
      exact('the remaining job releases the reservation', after.reserved, 0n)
      return true
    })
  }

  async function withdraw(role: 'creator' | 'relay') {
    const queued = await queue(role)
    await d.waitUntil(flow, queued.unlockAt)
    const receipt = await call(`withdraw-${role}`, wallets[role], h.vault, sdk.stakeVaultAbi, 'withdraw', [
      worker.account.address,
    ])
    await j.once(`${scope}/withdraw-${role}-verified`, async () => {
      const events = receipt.logs
        .filter((log) => sameAddress(log.address, h.vault))
        .flatMap((log) => {
          try {
            const event = decodeEventLog({ abi: sdk.stakeVaultAbi, topics: log.topics, data: log.data })
            return event.eventName === 'Withdrawn' ? [event.args] : []
          } catch {
            return []
          }
        })
      if (events.length !== 1) throw new Error('withdrawal needs one canonical Withdrawn event')
      const event = events[0]!
      exact('withdrawal account', sameAddress(event.account, worker.account.address), true)
      exact('withdrawal owner', sameAddress(event.delegator, wallets[role].account.address), true)
      exact('withdrawal redeems the fixed shares', event.shares, queued.shares)
      const paid = receipt.logs
        .filter((log) => sameAddress(log.address, h.factory))
        .reduce((sum, log) => {
          try {
            const e = decodeEventLog({ abi: erc20Abi, topics: log.topics, data: log.data })
            return e.eventName === 'Transfer' &&
              sameAddress(e.args.from, h.vault) &&
              sameAddress(e.args.to, wallets[role].account.address)
              ? sum + e.args.value
              : sum
          } catch {
            return sum
          }
        }, 0n)
      exact('withdrawal pays the event value to its owner', paid, event.assets)
      const position = await sdk.getPosition(ctx, worker.account.address, wallets[role].account.address, {
        blockNumber: receipt.blockNumber,
      })
      exact('the outside position exits completely', position.shares, 0n)
      if (flow === 'undelegate-pending-slash') {
        const slashed = j.state.values[`${scope}/slash-verified`] as { after: Awaited<ReturnType<typeof snapshot>> }
        exact('withdraw pays post-slash queued value', event.assets, slashed.after.positions.creator.value)
      }
      return { shares: event.shares, assets: event.assets }
    })
  }
  await withdraw('creator')
  if (flow === 'slash-pro-rata') await withdraw('relay')
}
