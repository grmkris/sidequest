import { expect, it } from 'vitest'
import { recoverOnce } from './app-recovery.ts'

const storage = () => {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  }
}
const privyCrash = new TypeError("Cannot destructure property 'onSuccess' of 'd.createWallet' as it is undefined.")

it('reloads once for the Privy wallet-created crash, then shows the error page', () => {
  const tab = storage()
  expect(recoverOnce(privyCrash, tab)).toBe(true)
  expect(recoverOnce(privyCrash, tab)).toBe(false)
})

it('never reloads for any other error', () => {
  expect(recoverOnce(new Error('Failed to fetch'), storage())).toBe(false)
})

it('recognises the same crash as Firefox and Safari word it', () => {
  const firefox = new TypeError('can\'t access property "onSuccess", d.createWallet is undefined')
  expect(recoverOnce(firefox, storage())).toBe(true)
  const safari = new TypeError('Right side of assignment cannot be destructured')
  safari.stack = 'createWallet@https://dev.sidequest.exchange/assets/privy.js:1:2'
  expect(recoverOnce(safari, storage())).toBe(true)
  // The same Safari wording from anywhere else is not this crash.
  const other = new TypeError('Right side of assignment cannot be destructured')
  other.stack = 'render@https://dev.sidequest.exchange/assets/index.js:1:2'
  expect(recoverOnce(other, storage())).toBe(false)
})
