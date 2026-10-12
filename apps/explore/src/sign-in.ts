/**
 * The board's sign-in signature (SIWE). Right after a login it is signed without Privy's screen: a new user's
 * "wallet created" screen is still closing then, and any Privy prompt replaces that screen's data and crashes it
 * (Kris, 12 Oct). Only a sign-in message for this site, this wallet and this chain is signed that way; anything else,
 * and every sign-in a person starts by hand, asks as usual.
 */
import { BaseError, UserRejectedRequestError } from 'viem'
import { parseSiweMessage } from 'viem/siwe'

/** The longest a silently signed sign-in may stay valid: the board's challenge expires in ten minutes. */
const SILENT_MAX_MS = 15 * 60_000

/**
 * Whether a sign-in message may be signed without a prompt: SIWE version 1 for this site (domain and URI origin),
 * this wallet and this chain, with a nonce and an expiry no further than fifteen minutes away.
 */
export function silentSignable(
  message: string,
  expected: { address: string; host: string; origin: string; chainId: number },
  now = Date.now(),
) {
  const siwe = parseSiweMessage(message)
  const expires = siwe.expirationTime?.getTime()
  return (
    siwe.version === '1' &&
    siwe.domain === expected.host &&
    siwe.uri !== undefined &&
    URL.canParse(siwe.uri) &&
    new URL(siwe.uri).origin === expected.origin &&
    siwe.address !== undefined &&
    siwe.address.toLowerCase() === expected.address.toLowerCase() &&
    siwe.chainId === expected.chainId &&
    siwe.nonce !== undefined &&
    siwe.nonce !== '' &&
    expires !== undefined &&
    expires > now &&
    expires <= now + SILENT_MAX_MS
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
