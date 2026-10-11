/**
 * The admin page's checks, before anything is signed: a fee schedule proposal against the rules `FeeSchedule.propose`
 * enforces (so the Safe never sends one that reverts), and every admin transaction read back from its calldata. Pure,
 * so they are unit-tested (admin.test.ts).
 */
import { type Abi, type Address, type Hex, decodeFunctionData, getAddress, isAddress, isHex, zeroAddress } from 'viem'
import { MULTI_SEND_CALL_ONLY, describe, preValidated, safeAbi, unpackMultiSend } from './safe.ts'
import { factoryAmount } from './stake.ts'

export interface ScheduleDraft {
  /** SIDE, as typed. */
  thresholds: string[]
  /** Percent, as typed ("10", "2.5"). */
  rates: string[]
  treasury: string
}

/** Percent as typed, in basis points; null when it is not a number with at most two decimals. */
export function bpsOf(text: string): number | null {
  const t = text.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null
  return Math.round(Number(t) * 100)
}

/** The draft as `propose` takes it, or why it would be refused: the contract's rules, in its order. */
export function scheduleProposal(
  d: ScheduleDraft,
  maxBps: number,
): { thresholds: bigint[]; bps: number[]; treasury: Address } | string {
  const thresholds: bigint[] = []
  for (const [i, t] of d.thresholds.entries()) {
    const wei = i === 0 && t.trim() === '0' ? 0n : factoryAmount(t)
    if (wei === null) return `Tier ${i + 1}: enter a SIDE threshold.`
    thresholds.push(wei)
  }
  const bps: number[] = []
  for (const [i, r] of d.rates.entries()) {
    const b = bpsOf(r)
    if (b === null) return `Tier ${i + 1}: enter a fee in percent, at most two decimals.`
    bps.push(b)
  }
  if (thresholds[0] !== 0n) return 'The first tier must start at 0 SIDE, so every stake has a fee.'
  if (thresholds.some((t, i) => i > 0 && t <= (thresholds[i - 1] as bigint)))
    return 'Each tier must start above the one before it.'
  if (bps.some((b) => b > maxBps)) return `No tier may charge more than ${maxBps / 100} %.`
  if (bps.some((b, i) => i > 0 && b > (bps[i - 1] as number))) return 'A bigger stake may not pay a higher fee.'
  if (!isAddress(d.treasury.trim(), { strict: false }) || d.treasury.trim().toLowerCase() === zeroAddress)
    return 'Enter the treasury address that receives fees.'
  return { thresholds, bps, treasury: d.treasury.trim() as Address }
}

/** A contract the console may call, with the functions it may call on it as the Safe, and directly (anyone may). */
interface AdminTarget {
  name: string
  abi: Abi
  safe: readonly string[]
  direct: readonly string[]
}

/** What an admin transaction is checked against: the chain, the Safe, the signed-in owner and the config's contracts. */
export interface AdminContext {
  chainId: number
  safe: Address
  owner: Address
  /** By lowercase address. */
  targets: Readonly<Record<string, AdminTarget>>
}

/** One contract call inside an admin transaction, decoded from its calldata. */
interface InnerCall {
  contract: string
  to: Address
  functionName: string
  args: Array<[string, string]>
  data: Hex
}

export type AdminTx =
  | {
      ok: true
      via: 'safe' | 'atomic' | 'direct'
      calls: InnerCall[]
      outer: Array<[string, string]> | null
    }
  | { ok: false; problem: string }

const no = (problem: string) => ({ ok: false as const, problem })

/** The pause pairs D13 sends atomically: the core's pause or unpause, then the Evaluator's notePause. */
const ATOMIC = [
  ['Core', ['pause', 'unpause']],
  ['SidequestEvaluator', ['notePause']],
] as const
/** The core's pause and unpause go out only inside that pair, never alone (U5-SEC-002); a lone notePause is fine. */
const pairedOnly = (call: InnerCall) =>
  call.contract === ATOMIC[0][0] && (ATOMIC[0][1] as readonly string[]).includes(call.functionName)

/**
 * Reads an admin transaction back from its calldata alone, and refuses it unless it is one this console builds for
 * this chain, Safe and owner: `execTransaction` signed as this owner with no value, refund or gas price, around an
 * allowed call on a configured contract (operation 0), or around MultiSendCallOnly with exactly a pause pair
 * (operation 1); or an allowed permissionless call made directly. Nothing stored beside the calldata is trusted.
 */
export function readAdminTx(
  tx: { chainId: number; to: string; data: string; value?: string | undefined },
  ctx: AdminContext,
): AdminTx {
  if (tx.chainId !== ctx.chainId) return no('It is for another network.')
  if ((tx.value ?? '0') !== '0') return no('It sends value.')
  if (!isHex(tx.data)) return no('Its calldata is not hex.')
  const call = (to: string, data: Hex, via: 'safe' | 'direct'): InnerCall | string => {
    const target = ctx.targets[to.toLowerCase()]
    if (target === undefined) return `It calls ${to}, which is not a Sidequest contract in this deployment.`
    let read: ReturnType<typeof describe>
    try {
      read = describe(target.abi, data)
    } catch {
      return `Its call to ${target.name} does not decode.`
    }
    const allowed = via === 'safe' ? target.safe : target.direct
    if (!allowed.includes(read.functionName))
      return `${target.name}.${read.functionName} is not something this console sends ${via === 'safe' ? 'as the Safe' : 'directly'}.`
    return { contract: target.name, to: getAddress(to), functionName: read.functionName, args: read.args, data }
  }

  if (!same(tx.to, ctx.safe)) {
    const inner = call(tx.to, tx.data, 'direct')
    return typeof inner === 'string' ? no(inner) : { ok: true, via: 'direct', calls: [inner], outer: null }
  }
  let args: readonly unknown[]
  try {
    const decoded = decodeFunctionData({ abi: safeAbi, data: tx.data })
    if (decoded.functionName !== 'execTransaction') return no('It is not a Safe execTransaction.')
    args = decoded.args
  } catch {
    return no('It does not decode as a Safe execTransaction.')
  }
  const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatures] = args as [
    Address,
    bigint,
    Hex,
    number,
    bigint,
    bigint,
    bigint,
    Address,
    Address,
    Hex,
  ]
  if (
    value !== 0n ||
    safeTxGas !== 0n ||
    baseGas !== 0n ||
    gasPrice !== 0n ||
    !same(gasToken, zeroAddress) ||
    !same(refundReceiver, zeroAddress)
  ) {
    return no('It moves value or pays a refund from the Safe.')
  }
  if (signatures.toLowerCase() !== preValidated(ctx.owner).toLowerCase())
    return no('It is not signed as you, the signed-in Safe owner.')
  const outer: Array<[string, string]> = [
    ['to', to],
    ['value', '0'],
    ['operation', operation === 1 ? '1 (delegatecall)' : '0 (call)'],
    ['safeTxGas', '0'],
    ['baseGas', '0'],
    ['gasPrice', '0'],
    ['gasToken', zeroAddress],
    ['refundReceiver', zeroAddress],
    ['signatures', signatures],
  ]
  if (operation === 0) {
    const inner = call(to, data, 'safe')
    if (typeof inner === 'string') return no(inner)
    if (pairedOnly(inner))
      return no(
        `${inner.contract}.${inner.functionName} goes out only with the Evaluator’s notePause, as one MultiSend transaction.`,
      )
    return { ok: true, via: 'safe', calls: [inner], outer }
  }
  if (operation !== 1) return no('It uses an unknown Safe operation.')
  if (!same(to, MULTI_SEND_CALL_ONLY)) return no('Its delegatecall is not to MultiSendCallOnly.')
  const packed = unpackMultiSend(data)
  if (packed === null) return no('Its MultiSend batch does not decode.')
  if (packed.length !== ATOMIC.length || packed.some((p) => p.operation !== 0 || p.value !== 0n))
    return no('Its MultiSend batch is not a pause pair.')
  const calls: InnerCall[] = []
  for (const [i, p] of packed.entries()) {
    const inner = call(p.to, p.data, 'safe')
    if (typeof inner === 'string') return no(inner)
    const [contract, functions] = ATOMIC[i] as (typeof ATOMIC)[number]
    if (inner.contract !== contract || !(functions as readonly string[]).includes(inner.functionName))
      return no('Its MultiSend batch is not a pause pair.')
    calls.push(inner)
  }
  return { ok: true, via: 'atomic', calls, outer }
}

/**
 * Reads a whole console operation: each transaction by `readAdminTx`, and the operation refused unless it is exactly
 * one transaction, as every operation this console builds is. A pause and its note split over two transactions is
 * the gap D13 closes, whatever each one reads as alone.
 */
export function readAdminOp(txs: ReadonlyArray<Parameters<typeof readAdminTx>[0]>, ctx: AdminContext): AdminTx[] {
  const reads = txs.map((tx) => readAdminTx(tx, ctx))
  return txs.length === 1
    ? reads
    : [...reads, no(`It holds ${txs.length} transactions; this console sends one per operation.`)]
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
