/**
 * The board's sign-in signature (SIWE). Right after a login it is signed without Privy's screen: a new user's
 * "wallet created" screen is still closing then, and any Privy prompt replaces that screen's data and crashes it
 * (Kris, 12 Oct). Only a sign-in message for this site, this wallet and this chain is signed that way; anything else,
 * and every sign-in a person starts by hand, asks as usual.
 */
import { BaseError, UserRejectedRequestError } from 'viem'
import { parseSiweMessage } from 'viem/siwe'

/** Whether a sign-in message may be signed without a prompt: it names this site, this wallet and this chain. */
export function silentSignable(message: string, expected: { address: string; host: string; chainId: number }) {
  const siwe = parseSiweMessage(message)
  return (
    siwe.domain === expected.host &&
    siwe.address !== undefined &&
    siwe.address.toLowerCase() === expected.address.toLowerCase() &&
    siwe.chainId === expected.chainId
  )
}

/** Whether a failed signature was the person saying no, which is final for this tab, rather than a fault. */
export function isRefusal(error: unknown): boolean {
  if (error instanceof BaseError && error.walk((cause) => cause instanceof UserRejectedRequestError) !== null)
    return true
  return error instanceof Error && /user (rejected|denied|cancel)/i.test(error.message)
}

/** The tab's note that the automatic sign-in already ran for an address (it succeeded or was refused). */
export const askedKey = (address: string) => `sidequest.asked:${address.toLowerCase()}`
