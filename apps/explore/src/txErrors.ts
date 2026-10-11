/**
 * Wallet and contract failures in words people can act on. A revert carrying our contracts' error data is decoded
 * against Sidequest v1's ABIs (ADR-0011: Holding, evaluator, stake vault, fee schedule, SIDE) and the core's; the
 * common refusals get a sentence, the rest their name.
 */
import * as sdk from '@sidequest/sdk'
import { type Abi, type Hex, decodeErrorResult } from 'viem'

const ABIS = [
  sdk.sidequestHoldingAbi,
  sdk.sidequestEvaluatorAbi,
  sdk.stakeVaultAbi,
  sdk.feeScheduleAbi,
  sdk.sideTokenAbi,
  sdk.coreAbi,
] as unknown as Abi[]

const PLAIN: Record<string, string> = {
  ReviewWindowClosed:
    'The review window has closed: the work now counts as accepted, and anyone can release the payment.',
  LateSubmission:
    'The work arrived after the deadline, so it cannot be rejected; accept it, or let it close as missed.',
  WindowClosed: 'That window has closed.',
  WindowOpen: 'Too early: the window this waits for is still open.',
  DisputeOpen: 'The agent has disputed: only the arbitrator’s ruling, or its timeout, settles it now.',
  SelectionExpired: 'The selection expired before the agent activated it. Select again.',
  NotApprover: 'Only the approver of this job can do that.',
  NothingToSettle: 'Nothing is left to settle for this job.',
  AlreadyRejected: 'This work has already been rejected.',
  PolicyHashUsed: 'This offer is already published.',
  EnforcedPause: 'The contracts are paused by their admin.',
  NotBootstrapped: 'Staking opens at launch, when the first Sidequest contract is authorized. Nothing was staked.',
  InsufficientAvailable: 'Not enough unreserved stake: bonds on live jobs stay staked until those jobs settle.',
  ERC2612ExpiredSignature: 'The staking signature expired. Stake again to sign a fresh one.',
  ERC2612InvalidSigner: 'The staking signature does not match this wallet. Stake again to sign a fresh one.',
  ERC20InsufficientBalance: 'Your wallet does not hold that many tokens.',
  TransferGasTooLow: 'The transaction ran with too little gas to pay out safely, so nothing changed. Try again.',
}

/** The first `0x…` error payload anywhere in a viem error's cause chain. */
function revertData(e: unknown): Hex | undefined {
  let cur: unknown = e
  for (let i = 0; i < 8 && cur !== null && typeof cur === 'object'; i++) {
    const data = (cur as { data?: unknown }).data
    if (typeof data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(data)) return data as Hex
    if (data !== null && typeof data === 'object' && typeof (data as { data?: unknown }).data === 'string')
      return (data as { data: Hex }).data
    cur = (cur as { cause?: unknown }).cause
  }
  const m = /(0x[0-9a-fA-F]{8,})/.exec(String((e as Error)?.message ?? ''))
  return m?.[1] as Hex | undefined
}

export function contractErrorName(e: unknown): string | null {
  const data = revertData(e)
  if (data === undefined) return null
  for (const abi of ABIS) {
    try {
      return decodeErrorResult({ abi, data }).errorName
    } catch {
      // not this contract's error
    }
  }
  return null
}

/** One sentence for a failed wallet or chain step. */
export function friendlyError(e: unknown): string {
  const msg = String((e as Error)?.message ?? e)
  const code =
    (e as { code?: number; cause?: { code?: number } })?.code ?? (e as { cause?: { code?: number } })?.cause?.code
  if (code === 4001 || /user (rejected|denied)|rejected the request|request rejected|cancell?ed/i.test(msg))
    return 'You cancelled in your wallet. Nothing was sent.'
  if (/insufficient funds|exceeds the balance|not enough (funds|balance)/i.test(msg))
    return 'Not enough MON for gas. Add MON to your wallet (Me → Wallet), then try again.'
  const name = contractErrorName(e)
  if (name !== null) return PLAIN[name] ?? `The contract refused it (${name}).`
  if (/reverted/i.test(msg))
    return 'The transaction was mined but reverted, so nothing changed. Reload to see where the job stands.'
  if (/chain|network/i.test(msg) && /mismatch|switch|wrong/i.test(msg))
    return 'Your wallet is on another network. Switch to Monad and try again.'
  if (/fetch|network error|timeout|timed out/i.test(msg))
    return 'The network did not answer. Check your connection and try again.'
  return msg.split('\n')[0] ?? 'Something went wrong.'
}
