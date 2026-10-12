/** Preserve v1 payout reserves (ADR-0011 D4b) when a bundler underestimates a hosted batch. */
import * as sdk from '@sidequest/sdk'
import { decodeFunctionData } from 'viem'

const holdingFloors: Readonly<Record<string, bigint>> = {
  settle: 1_000_000n,
  claimTopUpRefund: 450_000n,
  cancel: 700_000n,
}
const evaluatorFloors: Readonly<Record<string, bigint>> = {
  accept: 1_200_000n,
  completeAfterSilence: 1_200_000n,
  retryDeferred: 300_000n,
}
const CALL_DEFAULT = 120_000n

function callFloor(ctx: sdk.Ctx, call: sdk.Call): bigint | undefined {
  if (call.to.toLowerCase() === ctx.stack.holding.toLowerCase())
    return holdingFloors[decodeFunctionData({ abi: sdk.sidequestHoldingAbi, data: call.data }).functionName]
  if (call.to.toLowerCase() === ctx.stack.evaluator.toLowerCase())
    return evaluatorFloors[decodeFunctionData({ abi: sdk.sidequestEvaluatorAbi, data: call.data }).functionName]
  return undefined
}

export function hostedBatchGasFloor(ctx: sdk.Ctx, calls: readonly sdk.Call[]): bigint {
  const floors = calls.map((call) => callFloor(ctx, call))
  if (floors.every((floor) => floor === undefined)) return 0n
  // Account execution overhead plus room for the optional gas redemption and paymaster approval.
  return floors.reduce<bigint>((sum, floor) => sum + (floor ?? CALL_DEFAULT), 100_000n + 2n * CALL_DEFAULT)
}
