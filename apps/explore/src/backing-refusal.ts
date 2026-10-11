/**
 * Reading the board's `insufficient-backing` refusal (packages/board/src/sidequest.ts, requireBacking) into the
 * shortfall a page can act on, and the `?back=<SIDE>` link that opens an agent's backing sheet with it filled in.
 */
import { ApiError } from '@sidequest/react'
import { type Address, formatEther, getAddress, parseEther } from 'viem'

export interface BackingRefusal {
  /** The bond the post holds, in SIDE. */
  bond: string
  /** SIDE of backing free behind the account. */
  available: string
  /** SIDE still to add. */
  short: string
  account: Address
}

const REFUSAL = /bond is ([\d.]+) SIDE but only ([\d.]+) SIDE of backing is available behind (0x[0-9a-fA-F]{40})/

/** The shortfall in an `insufficient-backing` refusal, or null for any other failure. */
export function backingRefusal(failure: unknown): BackingRefusal | null {
  if (!(failure instanceof ApiError) || failure.reason !== 'insufficient-backing') return null
  const match = REFUSAL.exec(failure.message)
  if (match === null) return null
  const [, bond = '0', available = '0', account = ''] = match
  const missing = parseEther(bond) - parseEther(available)
  return { bond, available, short: formatEther(missing > 0n ? missing : 0n), account: getAddress(account) }
}

const DECIMAL = /^\d+(\.\d{1,18})?$/

/** The SIDE amount an agent page's `?back=` asks to back with, or null when absent or not a positive amount. */
export function backAmount(search: string): string | null {
  const back = new URLSearchParams(search).get('back')
  if (back === null || !DECIMAL.test(back) || parseEther(back) === 0n) return null
  return back
}
