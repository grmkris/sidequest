import { type AccountAbstraction, nativeLaneFloor } from '@sidequest/sdk'
import { formatEther } from 'viem'

/**
 * How the browser pays an action's gas. `userop`: one user operation, gas in USDC through the paymaster (or a testnet
 * faucet claim's sponsorship). `userop-native`: the same user operation with no paymaster, its account paying the gas in
 * MON. `mon-batch` / `mon-sequential`: plain wallet transactions paying MON.
 */
export type PaymentMode = 'userop' | 'userop-native' | 'mon-batch' | 'mon-sequential' | 'unfunded'

export interface PaymentModeInput {
  readonly aa: AccountAbstraction | null
  readonly gasTokenBalance: bigint
  readonly carriedGasToken: bigint
  readonly nativeBalance: bigint
  readonly nativeValue: bigint
  readonly delegated: boolean
  readonly canBatch: boolean
  readonly canSignAuthorization: boolean
  readonly sponsor: boolean
}

/** Whether the wallet can pay a user operation's gas in USDC (or have a faucet claim sponsored). */
function tokenLane(input: PaymentModeInput, aa: AccountAbstraction): boolean {
  return (
    (aa.paymaster !== null || input.sponsor) &&
    (input.sponsor || input.carriedGasToken + input.gasTokenBalance >= aa.maxCostPerOp)
  )
}

/**
 * Whether the wallet can pay a user operation's gas in MON: it holds Monad's reserve plus the per-operation ceiling, the
 * worst case before any estimate (the build bounds the real cost).
 */
function nativeLane(input: PaymentModeInput, aa: AccountAbstraction): boolean {
  const floor = nativeLaneFloor(aa)
  return !input.sponsor && floor !== null && input.nativeBalance >= floor
}

/** Choose the browser's payment lane without doing any RPC work. USDC is preferred; MON-paid user operations next. */
export function paymentMode(input: PaymentModeInput): PaymentMode {
  const aa = input.aa
  if (aa !== null && input.nativeValue === 0n && (input.canSignAuthorization || input.delegated)) {
    if (tokenLane(input, aa)) return 'userop'
    if (nativeLane(input, aa)) return 'userop-native'
  }
  if (input.nativeBalance <= input.nativeValue) return 'unfunded'
  if (input.canBatch && input.nativeValue === 0n) return 'mon-batch'
  return 'mon-sequential'
}

/** Which steps an action renders: a user operation (and its lane), the MON wallet steps, a refusal, or none yet. */
export type PaymentRoute = 'userop' | 'userop-native' | 'mon' | 'atomic-refused' | 'waiting'

/**
 * A saved user operation is always reconciled through the user-operation steps, on the lane its record names; a
 * legacy MON send is always followed to its end. Otherwise the selected mode decides, and an action that must be one
 * atomic batch is refused rather than sent as several wallet transactions.
 */
export function paymentRoute(input: {
  readonly savedAa: boolean
  readonly legacy: boolean
  readonly mode: PaymentMode | undefined
  readonly requireAtomic: boolean
}): PaymentRoute {
  if (input.savedAa) return 'userop'
  if (input.legacy) return 'mon'
  if (input.mode === 'userop' || input.mode === 'userop-native') return input.mode
  if (input.requireAtomic && input.mode === 'mon-sequential') return 'atomic-refused'
  if (input.mode === 'mon-batch' || input.mode === 'mon-sequential') return 'mon'
  return 'waiting'
}

/** The pre-signing cost copy, with USDC's six decimal places rendered as dollars. */
export function maxCostCopy(baseUnits: bigint): string {
  const cents = (baseUnits + 99n) / 100n
  const amount = `${cents / 10_000n}.${(cents % 10_000n).toString().padStart(4, '0')}`
  return `up to $${amount} gas in USDC`
}

/** The pre-signing cost copy for a MON-paid operation, rounded up to 0.0001 MON. */
export function maxNativeCostCopy(wei: bigint): string {
  const units = (wei + 10n ** 14n - 1n) / 10n ** 14n
  return `up to ${units / 10_000n}.${(units % 10_000n).toString().padStart(4, '0')} MON gas`
}

/** The cost copy for a built operation: MON when it has no paymaster, USDC otherwise. */
export const userOpCostCopy = (built: { readonly op: { readonly paymaster?: string }; readonly maxCost: bigint }) =>
  built.op.paymaster === undefined ? maxNativeCostCopy(built.maxCost) : maxCostCopy(built.maxCost)

const mon = (wei: bigint) => Number(formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 4 })

export function paymentRefusal(mode: PaymentMode): string | null {
  return mode === 'unfunded' ? 'Add USDC or MON to your wallet to send this action.' : null
}

/** Why an action that must be one atomic batch cannot be sent from this wallet, naming what would let it. */
export function atomicRefusal(aa: AccountAbstraction | null): string {
  const floor = aa === null ? null : nativeLaneFloor(aa)
  if (aa === null || floor === null)
    return 'This action needs one atomic batch. Add USDC and use your Sidequest wallet.'
  return `This action needs one atomic batch. Use your Sidequest wallet with USDC, or with at least ${mon(floor)} MON (Monad keeps ${mon(aa.nativeReserve)} MON in an upgraded wallet).`
}

/** Why a built operation's gas was refused before anything was signed. */
export function ceilingRefusal(native: boolean, aa: AccountAbstraction | null): string {
  if (!native) return 'Gas exceeds the per-action USDC limit. Nothing was signed or sent.'
  const reserve = aa === null ? '' : ` or leave less than ${mon(aa.nativeReserve)} MON in your wallet`
  return `Gas would exceed the per-action MON limit${reserve}. Nothing was signed or sent.`
}
