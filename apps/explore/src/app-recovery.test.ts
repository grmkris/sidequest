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
