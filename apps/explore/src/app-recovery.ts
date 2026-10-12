/**
 * Errors the app recovers from by reloading once. Privy's "wallet created" screen can throw while it closes when
 * something asks Privy for a signature at that moment; after a reload the account and wallet exist and the screen is
 * not shown again. The automatic sign-in no longer does that (sign-in.ts), so this is the safety net, not the fix.
 */
const FLAG = 'sidequest.recovered'

/**
 * The Privy crash as each engine words it: Chromium names `d.createWallet` ("…of 'd.createWallet' as it is
 * undefined"), Firefox too ("d.createWallet is undefined"); Safari (the iOS PWA) says only "Right side of
 * assignment cannot be destructured", so there the stack must name createWallet.
 */
function recoverable(error: Error): boolean {
  if (/\.createWallet\b[^]*undefined/.test(error.message)) return true
  return /cannot be destructured/.test(error.message) && (error.stack ?? '').includes('createWallet')
}

/**
 * Whether to reload for this error: a known recoverable one, the first time in this tab. Marks the tab, so a second
 * occurrence shows the error page instead of reloading in a loop.
 */
export function recoverOnce(error: Error, storage: Pick<Storage, 'getItem' | 'setItem'>): boolean {
  if (!recoverable(error)) return false
  if (storage.getItem(FLAG) !== null) return false
  storage.setItem(FLAG, error.message.slice(0, 200))
  return true
}
