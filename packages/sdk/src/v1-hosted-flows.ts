/** The live hosted rows use the real REST tools. Tests supply the same registry over a real local fork. */
import { type Hex, encodeFunctionData, formatUnits, erc20Abi } from 'viem'
import * as sdk from './index.ts'
import type { V1FlowDeps } from './v1-flows.ts'

export const V1_HOSTED_FLOWS = [
  'direct-hire',
  'quotes',
  'budget-advance',
  'budget-call',
  'sponsor-caps',
  'collect',
  'telegram',
] as const
export type V1HostedFlow = (typeof V1_HOSTED_FLOWS)[number]
export interface V1HostedDeps extends V1FlowDeps {
  call: <T = any>(wallet: sdk.Wallet, tool: string, input: Record<string, unknown>) => Promise<T>
}
type Prepared = { operationId?: string; transactions: sdk.TxRequest[]; sign?: { typedData: string } }
type Created = Prepared & { taskId: string; applicationId: string }
const check = (test: boolean, what: string) => {
  if (!test) throw new Error(what)
}

export async function runV1HostedFlow(d: V1HostedDeps, flow: V1HostedFlow) {
  const { ctx, journal: j, creator, worker } = d
  if (
    ctx.stack.kind !== 'sidequest-v1' ||
    ctx.deployment.chainId !== 10143 ||
    (await ctx.publicClient.getChainId()) !== 10143
  )
    throw new Error('Hosted live flows require the configured testnet v1 deployment')
  if (j.state.values[`${flow}/done`] === true) {
    d.log(`${flow}: already verified`)
    return
  }
  const once = <T>(step: string, make: () => Promise<T>) => j.once(`${flow}/${step}`, make)
  const report = async (taskId: string, hash: Hex) => d.call(worker, 'report_transaction', { taskId, txHash: hash })
  const send = async (step: string, wallet: sdk.Wallet, prepared: Prepared, taskId?: string) => {
    for (const receipt of await j.transactions(`${flow}/${step}`, wallet, prepared.transactions)) {
      if (taskId !== undefined) await report(taskId, receipt.transactionHash)
    }
  }
  const upgrade = async (wallet: sdk.Wallet) => {
    const key = `setup/upgrade/${wallet.account.address.toLowerCase()}`
    if (
      j.state.sends[key] !== undefined ||
      (await sdk.delegationOf(ctx.publicClient, wallet.account.address))?.toLowerCase() !==
        ctx.deployment.delegation.delegator.toLowerCase()
    ) {
      const auth = await j.once(`${key}/authorization`, () =>
        wallet.signAuthorization({
          account: wallet.account,
          contractAddress: ctx.deployment.delegation.delegator,
          executor: 'self',
        }),
      )
      await j.send(key, wallet, { to: wallet.account.address, data: '0x', value: '0' }, [auth])
    }
  }
  const enableSponsor = async (wallet: sdk.Wallet) => {
    if (j.state.values[`${flow}/sponsor-enabled-${wallet.account.address}`] === true) return
    if (
      (await d.call<{ status: string }>(wallet, 'sponsor_status', { wallet: wallet.account.address })).status === 'live'
    )
      return
    const prepared = await once(`sponsor-${wallet.account.address}`, () =>
      d.call<{ sign: { typedData: string } }>(wallet, 'sponsor_prepare', { wallet: wallet.account.address }),
    )
    await upgrade(wallet)
    const signature = await once(`sponsor-sign-${wallet.account.address}`, () =>
      sdk.signTypedDataJson(wallet, prepared.sign.typedData),
    )
    const result = await d.call<{ status: string }>(wallet, 'sponsor_confirm', {
      wallet: wallet.account.address,
      signature,
    })
    check(result.status === 'live', 'sponsorship grant did not become live')
    j.state.values[`${flow}/sponsor-enabled-${wallet.account.address}`] = true
    j.save(j.state)
  }
  const sponsor = async (step: string, wallet: sdk.Wallet, prepared: Prepared, taskId: string) => {
    const key = (await once('run-key', async () => sdk.randomNonce().toString())) + `-${flow}-${step}`
    const status = await d.call<{ delegationHash: Hex | null }>(wallet, 'sponsor_status', {
      wallet: wallet.account.address,
    })
    const op = await d.call<{ status: string; txHash: Hex; operationId: string }>(wallet, 'sponsor_submit', {
      wallet: wallet.account.address,
      key,
      entries: status.delegationHash === null ? [] : [{ grant: status.delegationHash, calls: prepared.transactions }],
    })
    check(op.status === 'confirmed', `sponsored ${step} must confirm before advancing (${op.status})`)
    j.log(`${flow}/${step}`, op.txHash)
    await report(taskId, op.txHash)
    const polled = await d.call<{ status: string; txHash: Hex }>(wallet, 'sponsor_operation', {
      wallet: wallet.account.address,
      operationId: op.operationId,
    })
    check(polled.status === 'confirmed' && polled.txHash === op.txHash, 'sponsor receipt polling disagrees')
  }
  if (flow === 'telegram') {
    for (const wallet of [creator, worker]) {
      const status = await d.call<{ linked: boolean }>(wallet, 'telegram_status', { wallet: wallet.account.address })
      check(status.linked, 'Telegram live flow requires the linked creator and worker chats')
    }
    await runV1HostedFlow(d, 'direct-hire')
    // A bot API result proves transport success. Human DM/channel receipt is coordinator evidence, never inferred here.
    d.log('Telegram links and notification-producing hire verified; coordinator must record actual DM/channel delivery')
  } else if (flow === 'collect') {
    const saved = await once('actions', async () => {
      const actions = await d.call<Array<{ kind: string; transactions: sdk.TxRequest[] }>>(worker, 'collect_actions', {
        wallet: worker.account.address,
      })
      check(actions.length > 0, 'no collect action is ready; do not count an empty read as live evidence')
      return actions
    })
    for (const [i, action] of saved.entries()) await send(`action-${i}`, worker, action)
  } else if (flow === 'sponsor-caps') {
    await enableSponsor(worker)
    const status = await d.call<{ callsUsed: number; delegationHash: Hex }>(worker, 'sponsor_status', {
      wallet: worker.account.address,
    })
    // Fill the grant with harmless, unique cancelSelection transitions; the caveat and hosted rate both refuse excess.
    for (let i = status.callsUsed; i <= 100; i++) {
      const key = `${await once('run-key', async () => sdk.randomNonce().toString())}-cap-${i}`
      const nonce = await once(`selection-${i}`, async () => sdk.randomNonce())
      const calls = [
        {
          to: ctx.stack.holding,
          value: '0',
          data: encodeFunctionData({ abi: sdk.sidequestHoldingAbi, functionName: 'cancelSelection', args: [nonce] }),
        },
      ]
      try {
        const op = await d.call<{ status: string; txHash: Hex }>(worker, 'sponsor_submit', {
          wallet: worker.account.address,
          key,
          entries: [{ grant: status.delegationHash, calls }],
        })
        check(op.status === 'confirmed', 'cap fill transaction did not confirm')
        j.log(`sponsor-caps/${i}`, op.txHash)
      } catch (error) {
        const reason = error as { reason?: string; code?: string; message?: string }
        check(
          reason.reason === 'cap' || reason.reason === 'rate' || /cap|rate|exhausted/i.test(reason.message ?? ''),
          'expected a cap/rate refusal',
        )
        d.log(`sponsorship refusal verified after ${i - status.callsUsed} calls`)
        j.state.values[`${flow}/done`] = true
        j.save(j.state)
        return
      }
    }
    throw new Error('sponsorship did not refuse the exhausted grant')
  } else {
    const decimals = await ctx.publicClient.readContract({ address: d.token, abi: erc20Abi, functionName: 'decimals' })
    const amount = formatUnits(d.reward, decimals),
      bond = formatUnits(d.bond, 18)
    const offer = await once('offer', async () => {
      const now = Number((await ctx.publicClient.getBlock()).timestamp)
      return {
        title: `Live v1 ${flow}`,
        brief: 'Testnet verification of the published v1 protocol flow.',
        acceptanceCriteria: ['A confirmed on-chain result'],
        creatorBond: bond,
        workerBond: bond,
        deliveryDeadline: now + 6 * 3600,
        quoteDeadline: now + 3600,
        windows: sdk.minimumOfferWindows(await sdk.readWindowBounds(ctx)),
        arbitrator: d.arbitrator.account.address,
        deliverable: { accepts: ['onchain'] },
      }
    })
    const budget =
      flow === 'budget-advance'
        ? { kind: 'advance', cap: amount, token: d.token }
        : flow === 'budget-call'
          ? {
              kind: 'call',
              cap: '0.000001',
              target: d.token,
              function: 'function transfer(address,uint256) returns (bool)',
            }
          : undefined
    const runKey = await once('run-key', async () => sdk.randomNonce().toString())
    const created = await once('created', async () => {
      if (flow !== 'quotes')
        return d.call<Created>(creator, 'create_task', {
          ...offer,
          mode: 'hire',
          reward: amount,
          token: d.token,
          invite: { agentId: d.agentId.toString() },
          idempotencyKey: `${runKey}-${flow}-create`,
          ...(budget === undefined ? {} : { executionBudget: budget }),
        })
      const request = await once('request', () =>
        d.call<{ requestId: string }>(creator, 'request_quotes', {
          ...offer,
          tokens: [d.token],
          idempotencyKey: `${runKey}-${flow}-request`,
        }),
      )
      const quote = await once('quote', async () => {
        const existing = await d.call<{ quotes: Array<{ quoteId: string; worker: string }> }>(worker, 'list_quotes', {
          requestId: request.requestId,
        })
        return (
          existing.quotes.find((q) => q.worker.toLowerCase() === worker.account.address.toLowerCase()) ??
          d.call<{ quoteId: string }>(worker, 'submit_quote', {
            requestId: request.requestId,
            agentId: d.agentId.toString(),
            token: d.token,
            amount,
          })
        )
      })
      return d.call<Created>(creator, 'pick_quote', {
        requestId: request.requestId,
        quoteId: quote.quoteId,
        idempotencyKey: `${runKey}-${flow}-pick`,
      })
    })
    const taskId = created.taskId
    await send('publish', creator, created, taskId)
    const selected = await once('selection', () =>
      d.call<{ nonce: string; sign: { typedData: string } }>(creator, 'select_worker', {
        taskId,
        applicationId: created.applicationId,
      }),
    )
    const selectionSig = await once('selection-sign', () => sdk.signTypedDataJson(creator, selected.sign.typedData))
    await d.call(creator, 'submit_selection', { taskId, nonce: selected.nonce, signature: selectionSig })
    const activation = await once('activation', async () => {
      const prep = await d.call<{ sign: { typedData: string } }>(worker, 'prepare_activation', { taskId })
      return d.call<Prepared>(worker, 'build_activation', {
        taskId,
        budgetSignature: await sdk.signTypedDataJson(worker, prep.sign.typedData),
      })
    })
    if (flow === 'direct-hire') {
      await enableSponsor(worker)
      await enableSponsor(creator)
      await sponsor('activate', worker, activation, taskId)
    } else await send('activate', worker, activation, taskId)
    if (budget !== undefined) {
      await upgrade(creator)
      const grant = await once('grant', () =>
        d.call<{ sign: { typedData: string } }>(creator, 'budget_grant_prepare', { taskId }),
      )
      const signature = await once('grant-sign', () => sdk.signTypedDataJson(creator, grant.sign.typedData))
      await once('grant-confirmed', () => d.call(creator, 'budget_grant_confirm', { taskId, signature }))
      const before = await once('draw-before', () => sdk.balanceOf(ctx, d.token, worker.account.address))
      const spend = await once('spend', () =>
        d.call<Prepared>(worker, budget.kind === 'advance' ? 'spend_budget' : 'spend_budget_call', {
          taskId,
          ...(budget.kind === 'advance'
            ? { amount }
            : {
                data: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: 'transfer',
                  args: [worker.account.address, d.reward],
                }),
                value: '0',
              }),
        }),
      )
      await send('draw', worker, spend, taskId)
      check(
        (await sdk.balanceOf(ctx, d.token, worker.account.address)) - before === d.reward,
        'budget draw did not deliver the exact amount',
      )
    }
    const delivery = await once('delivery', () =>
      d.call<Prepared>(worker, 'submit_work', {
        taskId,
        deliverable: { kind: 'onchain', chainId: 10143, address: ctx.stack.holding },
      }),
    )
    await send('submit', worker, delivery, taskId)
    const accepted = await once('acceptance', () => d.call<Prepared>(creator, 'approve_work', { taskId }))
    if (flow === 'direct-hire') await sponsor('accept', creator, accepted, taskId)
    else await send('accept', creator, accepted, taskId)
    const settlement = await once('settlement', () => d.call<Prepared>(worker, 'settlement_actions', { taskId }))
    if (flow === 'direct-hire') await sponsor('settle', creator, settlement, taskId)
    else await send('settle', worker, settlement, taskId)
    const task = await d.call<{ jobId: string; operations: Array<{ kind: string; status: string }> }>(
      worker,
      'get_task',
      { taskId },
    )
    check((await sdk.getV1Listing(ctx, BigInt(task.jobId))).outcome === 1, 'hosted hire did not settle as paid')
    check(
      task.operations
        .filter((o) => ['activate', 'accept', 'submit'].includes(o.kind))
        .every((o) => o.status === 'confirmed'),
      'reported hosted operation stayed prepared',
    )
  }
  j.state.values[`${flow}/done`] = true
  j.save(j.state)
  d.log(`${flow}: verified`)
}
