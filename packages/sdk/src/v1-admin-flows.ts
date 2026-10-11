/** Live testnet administration through the configured Safe. No deploys, no mainnet, no new proposals. */
import {
  type Address,
  type Hex,
  BaseError,
  ContractFunctionRevertedError,
  concat,
  encodeFunctionData,
  encodePacked,
  pad,
  parseAbi,
  zeroAddress,
} from 'viem'
import * as sdk from './index.ts'
import type { V1FlowDeps } from './v1-flows.ts'

export const V1_ADMIN_FLOWS = ['admin-ownership', 'admin-fees', 'admin-vault-refusal', 'admin-pause'] as const
export type V1AdminFlow = (typeof V1_ADMIN_FLOWS)[number]
export const flowSafeAbi = parseAbi([
  'function isOwner(address) view returns (bool)',
  'function getThreshold() view returns (uint256)',
  'function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns (bool)',
])
const ownable = parseAbi([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function acceptOwnership()',
])
export function isHoldingTimelockRevert(error: unknown, eta: number): boolean {
  if (!(error instanceof BaseError)) return false
  const revert = error.walk((cause) => cause instanceof ContractFunctionRevertedError)
  return (
    revert instanceof ContractFunctionRevertedError &&
    revert.data?.errorName === 'HoldingTimelocked' &&
    revert.data.args?.[0] === eta
  )
}
// D13's canonical MultiSendCallOnly v1.4.1 deployment on both Monad chains.
export const FLOW_MULTISEND: Address = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2'
export function flowPauseBatch(ctx: sdk.Ctx, paused: boolean): Hex {
  const data = concat([
    encodePacked(
      ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
      [
        0,
        ctx.deployment.core,
        0n,
        4n,
        encodeFunctionData({ abi: sdk.coreAbi, functionName: paused ? 'pause' : 'unpause' }),
      ],
    ),
    encodePacked(
      ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
      [
        0,
        ctx.stack.evaluator,
        0n,
        4n,
        encodeFunctionData({ abi: sdk.sidequestEvaluatorAbi, functionName: 'notePause' }),
      ],
    ),
  ])
  return encodeFunctionData({ abi: parseAbi(['function multiSend(bytes)']), functionName: 'multiSend', args: [data] })
}
export async function runV1AdminFlow(d: V1FlowDeps & { safeOwner: sdk.Wallet }, flow: V1AdminFlow) {
  const { ctx, journal: j, safeOwner } = d,
    h = ctx.deployment.sidequest
  if (
    ctx.deployment.chainId !== 10143 ||
    (await ctx.publicClient.getChainId()) !== 10143 ||
    h === null ||
    ctx.stack.kind !== 'sidequest-v1'
  )
    throw new Error('Admin flows are testnet v1 only')
  if (j.state.values[`${flow}/done`] === true) return
  if (
    !(await ctx.publicClient.readContract({
      address: h.safe,
      abi: flowSafeAbi,
      functionName: 'isOwner',
      args: [safeOwner.account.address],
    })) ||
    (await ctx.publicClient.readContract({ address: h.safe, abi: flowSafeAbi, functionName: 'getThreshold' })) !== 1n
  )
    throw new Error('This runner needs an owner of the threshold-1 testnet Safe')
  const execute = (label: string, to: Address, data: Hex, operation = 0) =>
    j.contract(`${flow}/${label}`, safeOwner, h.safe, flowSafeAbi, 'execTransaction', [
      to,
      0n,
      data,
      operation,
      0n,
      0n,
      0n,
      zeroAddress,
      zeroAddress,
      concat([pad(safeOwner.account.address, { size: 32 }), pad('0x', { size: 32 }), '0x01']),
    ])
  if (flow === 'admin-ownership') {
    for (const target of [h.vault, h.feeSchedule, ctx.stack.holding, ctx.stack.evaluator]) {
      const owner = await ctx.publicClient.readContract({ address: target, abi: ownable, functionName: 'owner' })
      if (owner.toLowerCase() === h.safe.toLowerCase()) continue
      const pending = await ctx.publicClient.readContract({
        address: target,
        abi: ownable,
        functionName: 'pendingOwner',
      })
      if (pending.toLowerCase() !== h.safe.toLowerCase())
        throw new Error('handover is not pending to the configured Safe')
      await execute(`accept-${target}`, target, encodeFunctionData({ abi: ownable, functionName: 'acceptOwnership' }))
      if (
        (
          await ctx.publicClient.readContract({ address: target, abi: ownable, functionName: 'owner' })
        ).toLowerCase() !== h.safe.toLowerCase()
      )
        throw new Error('Safe ownership readback failed')
    }
  } else if (flow === 'admin-fees') {
    const pending = await j.once(`${flow}/proposal`, () =>
      ctx.publicClient.readContract({ address: h.feeSchedule, abi: sdk.feeScheduleAbi, functionName: 'pending' }),
    )
    if (pending[1] === 0) throw new Error('G1 must propose the fee schedule before admin-fees')
    await d.waitUntil(flow, pending[1])
    await j.contract(`${flow}/execute`, d.relay, h.feeSchedule, sdk.feeScheduleAbi, 'execute', [])
    if (
      sdk.flowJson(
        await ctx.publicClient.readContract({
          address: h.feeSchedule,
          abi: sdk.feeScheduleAbi,
          functionName: 'schedule',
        }),
      ) !== sdk.flowJson(pending[0])
    )
      throw new Error('fee schedule execution readback failed')
  } else if (flow === 'admin-vault-refusal') {
    if ((await j.mined(`${flow}/cancel-probe`)) === undefined)
      await j.once(`${flow}/refusal-verified`, async () => {
        const [proposal, eta] = await ctx.publicClient.readContract({
          address: h.vault,
          abi: sdk.stakeVaultAbi,
          functionName: 'pendingHolding',
        })
        if (proposal === zeroAddress || eta === 0 || Number((await ctx.publicClient.getBlock()).timestamp) >= eta)
          throw new Error('G1 must prepare a still-timelocked Holding probe')
        let refused = false
        try {
          await ctx.publicClient.simulateContract({
            account: d.relay.account,
            address: h.vault,
            abi: sdk.stakeVaultAbi,
            functionName: 'acceptHolding',
          })
        } catch (error) {
          if (!isHoldingTimelockRevert(error, eta))
            throw new Error('vault refusal was not the expected HoldingTimelocked error', { cause: error })
          refused = true
        }
        if (!refused) throw new Error('vault accepted a Holding before its deployed delay')
        return true
      })
    await execute(
      'cancel-probe',
      h.vault,
      encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'cancelHoldingProposal' }),
    )
    const [proposal, eta] = await ctx.publicClient.readContract({
      address: h.vault,
      abi: sdk.stakeVaultAbi,
      functionName: 'pendingHolding',
    })
    if (proposal !== zeroAddress || eta !== 0) throw new Error('Holding probe cancellation readback failed')
  } else {
    if ((await ctx.publicClient.getCode({ address: FLOW_MULTISEND })) === '0x')
      throw new Error('MultiSendCallOnly is unavailable')
    const unpauseAlreadyMined = await j.mined(`${flow}/unpause-note`)
    if (unpauseAlreadyMined === undefined) {
      await execute('pause-note', FLOW_MULTISEND, flowPauseBatch(ctx, true), 1)
      await j.once(`${flow}/pause-verified`, async () => {
        if (
          !(await ctx.publicClient.readContract({
            address: ctx.deployment.core,
            abi: sdk.coreAbi,
            functionName: 'paused',
          }))
        )
          throw new Error('atomic pause failed')
        return true
      })
      await execute('unpause-note', FLOW_MULTISEND, flowPauseBatch(ctx, false), 1)
    } else {
      // The final receipt proves the paired action completed; rerun the final readback only.
      d.log(`${flow}: resumed after the final unpause receipt`)
    }
    if (await ctx.publicClient.readContract({ address: ctx.deployment.core, abi: sdk.coreAbi, functionName: 'paused' }))
      throw new Error('atomic unpause failed')
  }
  j.state.values[`${flow}/done`] = true
  j.save(j.state)
  d.log(`${flow}: verified`)
}
